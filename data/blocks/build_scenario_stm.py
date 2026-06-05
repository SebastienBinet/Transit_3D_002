"""
Construit les fichiers circuit (un par circuit-direction) + l'index à partir des
horaires GTFS de la STM.

Schéma scalable (voir DECISIONS.md §5) : chaque passage (trip) est stocké UNE fois
sous forme d'horaire (t_arr, t_dep, progress_m), pas comme des frames redondantes.
Le cône d'incertitude p10/p50/p90 est reconstruit côté visualizer (web/js/scenario-model.js)
à partir de l'horaire et du modèle σ partagé. Tient à l'échelle de tous les circuits,
toutes les directions, toute la semaine (chargement paresseux par fichier).

Sorties :
  web/data/circuits/{line_id}.json   — géométrie + tous les passages de la fenêtre
  web/data/circuits_index.json       — liste des circuits + paramètres + modèle σ

Usage : uv run python data/blocks/build_scenario_stm.py
"""
from __future__ import annotations
import csv
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

# ── Chemins ────────────────────────────────────────────────────────────────
CACHE_DIR   = Path(__file__).parent.parent / "cache" / "gtfs"
ROUTES_IN   = Path(__file__).parent.parent.parent / "web" / "data" / "routes_stm.json"
OUTPUT_DIR  = Path(__file__).parent.parent.parent / "web" / "data" / "circuits"
INDEX_OUT   = Path(__file__).parent.parent.parent / "web" / "data" / "circuits_index.json"

# ── Fenêtre de simulation (affichée par le visualizer) ─────────────────────
T0_SECONDS     = 7 * 3600     # début de la fenêtre : 07:00:00 (sec depuis minuit)
HORIZON_S      = 3600.0       # durée affichée : 60 min
FRAME_INTERVAL = 5.0          # cadence de rafraîchissement du cône (sec de sim)
TRAJ_STEP_S    = 60.0         # résolution interne du cône

# ── Fenêtre de génération : on garde tous les passages qui chevauchent ─────
# [T0 - PRE, T0 + HORIZON + POST] pour disposer du passage d'avant et d'après.
GEN_PRE_S  = 1800.0          # 30 min avant T0
GEN_POST_S = 1800.0          # 30 min après la fin de l'horizon

# ── Modèle d'incertitude d'adhérence (σ partagé) ───────────────────────────
# σ(Δt) = SIGMA_COEFF_MIN · (Δt_min)^SIGMA_EXP minutes.
# Calé sur : σ(1 min)=3 min, σ(10 min)≈6 min, σ(60 min)≈10 min.
SIGMA_COEFF_MIN = 3.0
SIGMA_EXP       = 0.301

LAT_M = 111_000.0

# Couleurs (référence — le renderer a sa propre table LINE_COLORS).
LINE_COLORS_HEX = {
    "51":   "#4488ff", "165":  "#ff8844", "11":   "#44cc44",
    "129":  "#ffcc00", "155":  "#44ccdd", "66":   "#ff4466", "144":  "#88ff44",
    "124N": "#ff9900", "124S": "#cc6600", "480N": "#9900cc", "480S": "#6600aa",
}


# ── Lecture CSV ────────────────────────────────────────────────────────────
def read_csv(path: Path) -> list[dict]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def parse_hms(hms: str) -> float:
    """Convertit "HH:MM:SS" → secondes depuis minuit. GTFS permet HH > 24."""
    h, m, s = hms.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def base_route_name(line_id: str) -> str:
    """Enlève le suffixe N/S pour les lignes bidirectionnelles ('124N' → '124')."""
    if len(line_id) > 1 and line_id[-1] in ("N", "S") and line_id[:-1].isdigit():
        return line_id[:-1]
    return line_id


# ── Sélection du service weekday par route ─────────────────────────────────
def pick_service_per_route(
    calendar_rows: list[dict],
    trips_rows: list[dict],
    target_route_ids: set[str],
) -> dict[str, str]:
    """Retourne {route_id: meilleur_service_id} (lundi=1, le plus de trips)."""
    weekday_services = {r["service_id"] for r in calendar_rows
                        if r.get("monday", "0") == "1"}
    if not weekday_services:
        raise RuntimeError("Aucun service de semaine trouvé dans calendar.txt.")

    counts: dict[tuple[str, str], int] = defaultdict(int)
    for t in trips_rows:
        sid = t.get("service_id", "")
        rid = t.get("route_id", "")
        if sid in weekday_services and rid in target_route_ids:
            counts[(rid, sid)] += 1

    best: dict[str, tuple[str, int]] = {}
    for (rid, sid), cnt in counts.items():
        if rid not in best or cnt > best[rid][1]:
            best[rid] = (sid, cnt)
    return {rid: info[0] for rid, info in best.items()}


# ── Snap d'un arrêt sur la shape de la ligne ──────────────────────────────
def snap_stop_to_shape(shape_pts: list[dict], stop_lat: float, stop_lon: float) -> float:
    """Distance cumulée (m) jusqu'au point de la shape le plus proche du stop."""
    if not shape_pts:
        return 0.0
    lonM = LAT_M * math.cos(math.radians(shape_pts[0]["lat"]))
    best_d2 = float("inf")
    best_cum = 0.0
    cum = 0.0
    for i, pt in enumerate(shape_pts):
        dy = (stop_lat - pt["lat"]) * LAT_M
        dx = (stop_lon - pt["lon"]) * lonM
        d2 = dx * dx + dy * dy
        if d2 < best_d2:
            best_d2 = d2
            best_cum = cum
        if i + 1 < len(shape_pts):
            npt = shape_pts[i + 1]
            dy2 = (npt["lat"] - pt["lat"]) * LAT_M
            dx2 = (npt["lon"] - pt["lon"]) * lonM
            cum += math.sqrt(dx2 * dx2 + dy2 * dy2)
    return best_cum


def snap_and_orient_trip(
    visits: list[tuple[float, float, str]],
    stop_latlon: dict[str, tuple[float, float]],
    route_shape: list[dict],
    length_m: float,
) -> list[tuple[float, float, float]] | None:
    """Snap les arrêts du trip sur la shape, corrige la direction inverse.
    Retourne [(t_arr, t_dep, progress_m)] trié et monotone, ou None si < 2 arrêts."""
    full: list[tuple[float, float, float]] = []
    for t_arr, t_dep, sid in visits:
        ll = stop_latlon.get(sid)
        if ll is None:
            continue
        full.append((t_arr, t_dep, snap_stop_to_shape(route_shape, ll[0], ll[1])))

    if len(full) < 2:
        return None

    # Flip si la progression est majoritairement décroissante (trip dans le sens
    # opposé à la shape stockée).
    n_inc = sum(1 for i in range(1, len(full)) if full[i][2] >= full[i - 1][2])
    if n_inc < len(full) // 2:
        full = [(ta, td, length_m - p) for ta, td, p in full]

    full.sort(key=lambda v: v[0])
    # Forcer la monotonie non-décroissante de la progression
    for i in range(1, len(full)):
        if full[i][2] < full[i - 1][2]:
            full[i] = (full[i][0], full[i][1], full[i - 1][2])
    return full


# ── Algorithme principal ───────────────────────────────────────────────────
def build_circuits() -> tuple[list[dict], dict]:
    sys.path.insert(0, str(Path(__file__).parent.parent.parent))
    from sim.models import CircuitData, CircuitIndex

    required = ("routes.txt", "trips.txt", "stop_times.txt", "stops.txt", "calendar.txt")
    for name in required:
        if not (CACHE_DIR / name).exists():
            print(f"ERREUR : {CACHE_DIR / name} introuvable.", file=sys.stderr)
            sys.exit(1)
    if not ROUTES_IN.exists():
        print(f"ERREUR : {ROUTES_IN} introuvable. Lancer build_routes.py d'abord.", file=sys.stderr)
        sys.exit(1)

    # ── Charger routes_stm.json ────────────────────────────────────────────
    routes_data = json.loads(ROUTES_IN.read_text(encoding="utf-8"))
    line_info: dict[str, tuple[str, str | None]] = {}   # line_id → (base, gtfs_dir)
    route_of_line: dict[str, dict] = {}
    for r in routes_data:
        lid = r["line_id"]
        line_info[lid] = (base_route_name(lid), r.get("gtfs_direction_id"))
        route_of_line[lid] = r
    print(f"Routes chargées : {sorted(line_info.keys())}")

    shape_of_line  = {lid: r["shape"]    for lid, r in route_of_line.items()}
    length_of_line = {lid: r["length_m"] for lid, r in route_of_line.items()}
    base_short_names = {base for base, _ in line_info.values()}

    # ── Charger les tables GTFS ────────────────────────────────────────────
    routes_rows = read_csv(CACHE_DIR / "routes.txt")
    trips_rows  = read_csv(CACHE_DIR / "trips.txt")
    st_rows     = read_csv(CACHE_DIR / "stop_times.txt")
    stops_rows  = read_csv(CACHE_DIR / "stops.txt")
    cal_rows    = read_csv(CACHE_DIR / "calendar.txt")

    stop_latlon: dict[str, tuple[float, float]] = {
        r["stop_id"]: (float(r["stop_lat"]), float(r["stop_lon"]))
        for r in stops_rows
    }

    route_id_to_short: dict[str, str] = {}
    for r in routes_rows:
        short = r.get("route_short_name", "").strip()
        if short in base_short_names:
            route_id_to_short[r["route_id"]] = short
    target_route_id_set = set(route_id_to_short.keys())

    service_per_route = pick_service_per_route(cal_rows, trips_rows, target_route_id_set)
    print(f"Services weekday utilisés : {sorted(set(service_per_route.values()))}")

    # ── Trips par line_id (respecte la direction pour les lignes bidirectionnelles) ─
    trips_by_line: dict[str, list[str]] = defaultdict(list)
    for t in trips_rows:
        rid   = t.get("route_id", "")
        short = route_id_to_short.get(rid)
        if not short:
            continue
        expected_sid = service_per_route.get(rid)
        if not expected_sid or t.get("service_id") != expected_sid:
            continue
        tid  = t["trip_id"]
        tdir = t.get("direction_id", "0")
        for lid, (base, gdir) in line_info.items():
            if base != short:
                continue
            if gdir is not None and tdir != gdir:
                continue
            trips_by_line[lid].append(tid)

    # ── stop_times par trip ────────────────────────────────────────────────
    all_relevant = {tid for tids in trips_by_line.values() for tid in tids}
    raw_st: dict[str, list[tuple[int, float, float, str]]] = defaultdict(list)
    for row in st_rows:
        tid = row["trip_id"]
        if tid not in all_relevant:
            continue
        try:
            seq   = int(row["stop_sequence"])
            t_arr = parse_hms(row["arrival_time"])
            t_dep = parse_hms(row["departure_time"])
        except (KeyError, ValueError):
            continue
        raw_st[tid].append((seq, t_arr, t_dep, row["stop_id"]))

    stop_times_by_trip: dict[str, list[tuple[float, float, str]]] = {}
    for tid, visits in raw_st.items():
        visits.sort(key=lambda x: x[0])
        stop_times_by_trip[tid] = [(ta, td, sid) for _, ta, td, sid in visits]

    # ── Construire un fichier par circuit ──────────────────────────────────
    gen_lo = T0_SECONDS - GEN_PRE_S
    gen_hi = T0_SECONDS + HORIZON_S + GEN_POST_S

    circuit_files: list[dict] = []   # objets CircuitData (dict)
    index_entries: list[dict] = []

    for line_id in sorted(line_info.keys()):
        _, gdir = line_info[line_id]
        route_shape = shape_of_line[line_id]
        length_m    = length_of_line[line_id]

        trips_out: list[dict] = []
        for tid in trips_by_line.get(line_id, []):
            visits = stop_times_by_trip.get(tid, [])
            if len(visits) < 2:
                continue
            # Fenêtre de génération : garder les passages qui chevauchent
            if visits[-1][0] < gen_lo or visits[0][0] > gen_hi:
                continue
            full = snap_and_orient_trip(visits, stop_latlon, route_shape, length_m)
            if full is None:
                continue
            trips_out.append({
                "trip_id": tid,
                "schedule": [
                    {"t_arr": round(ta, 1), "t_dep": round(td, 1), "progress_m": round(p, 2)}
                    for ta, td, p in full
                ],
            })

        # Émettre un fichier même sans passage (ex. 480N, express qui ne roule pas
        # le matin) : trips vide mais format respecté, la géométrie reste affichée
        # et l'emplacement est prêt pour les données d'après-midi à venir.
        trips_out.sort(key=lambda tr: tr["schedule"][0]["t_arr"])

        circuit = {
            "line_id": line_id,
            "gtfs_direction_id": gdir,
            "route": route_of_line[line_id],
            "trips": trips_out,
        }
        circuit_files.append(circuit)
        index_entries.append({
            "line_id": line_id,
            "gtfs_direction_id": gdir,
            "color": LINE_COLORS_HEX.get(line_id),
            "file": f"circuits/{line_id}.json",
            "n_trips": len(trips_out),
        })
        if trips_out:
            print(f"  {line_id:>5} : {len(trips_out)} passages "
                  f"({trips_out[0]['schedule'][0]['t_arr']/3600:.2f}h → "
                  f"{trips_out[-1]['schedule'][-1]['t_arr']/3600:.2f}h)")
        else:
            print(f"  {line_id:>5} : 0 passage dans la fenêtre — fichier émis avec trips vide")

    if not circuit_files:
        raise RuntimeError("Aucun circuit construit.")

    index = {
        "t0_seconds": float(T0_SECONDS),
        "horizon_s": HORIZON_S,
        "frame_interval": FRAME_INTERVAL,
        "traj_step": TRAJ_STEP_S,
        "sigma": {"kind": "power", "coeff_min": SIGMA_COEFF_MIN, "exp": SIGMA_EXP},
        "circuits": index_entries,
    }

    # ── Validation Pydantic ────────────────────────────────────────────────
    print("Validation Pydantic …")
    for c in circuit_files:
        CircuitData.model_validate(c)
    CircuitIndex.model_validate(index)

    return circuit_files, index


def main() -> None:
    print(f"Construction des circuits (fenêtre {T0_SECONDS/3600:.1f}h → "
          f"{(T0_SECONDS+HORIZON_S)/3600:.1f}h, génération ±30 min) …")
    circuit_files, index = build_circuits()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    # Nettoyer les anciens fichiers circuit (lignes supprimées comme la 711)
    for old in OUTPUT_DIR.glob("*.json"):
        old.unlink()

    total = 0
    for c in circuit_files:
        path = OUTPUT_DIR / f"{c['line_id']}.json"
        path.write_text(json.dumps(c, ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8")
        total += path.stat().st_size

    INDEX_OUT.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Écrit : {len(circuit_files)} fichiers circuit "
          f"({total/1024:.0f} KB au total) + {INDEX_OUT.name}")


if __name__ == "__main__":
    main()

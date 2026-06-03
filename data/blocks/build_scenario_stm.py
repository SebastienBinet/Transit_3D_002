"""
Construit web/data/scenario_stm_1.json à partir des horaires GTFS de la STM.

Pour chaque ligne cible, sélectionne un trip représentatif actif dans la fenêtre
de simulation (pointe du matin 7h00–7h30) et produit une trajectoire espace-temps
p10/p50/p90 par interpolation des horaires planifiés, avec incertitude d'adhérence
calée sur le modèle σ(Δt) = 3·Δt_min^0.301 minutes.

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
CACHE_DIR = Path(__file__).parent.parent / "cache" / "gtfs"
ROUTES_IN = Path(__file__).parent.parent.parent / "web" / "data" / "routes_stm.json"
OUTPUT    = Path(__file__).parent.parent.parent / "web" / "data" / "scenario_stm_1.json"

# ── Fenêtre de simulation ──────────────────────────────────────────────────
T0_SECONDS      = 7 * 3600          # heure absolue (depuis minuit) du début de la sim : 07:00:00
HORIZON_S       = 1800.0            # durée de la sim : 30 min
FRAME_INTERVAL  = 2.0               # 0.5 Hz de frames produites (espacement temporel)
TRAJ_STEP_S     = 60.0              # résolution interne de la trajectoire prédite
N_TRAJ_STEPS    = int(HORIZON_S // TRAJ_STEP_S) + 1   # 31 points (t=0 inclus)

LAT_M = 111_000.0


# ── Modèle d'incertitude d'adhérence ───────────────────────────────────────
def sigma_time_s(delta_t_s: float) -> float:
    """σ en secondes pour un horizon Δt en secondes.
    Calé sur : σ(1 min)=3 min, σ(10 min)=6 min, σ(60 min)≈10 min."""
    if delta_t_s <= 0:
        return 0.0
    return 3.0 * ((delta_t_s / 60.0) ** 0.301) * 60.0


# ── Lecture CSV ────────────────────────────────────────────────────────────
def read_csv(path: Path) -> list[dict]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def parse_hms(hms: str) -> float:
    """Convertit "HH:MM:SS" → secondes depuis minuit. GTFS permet HH > 24."""
    h, m, s = hms.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


# ── Sélection du service weekday par route ─────────────────────────────────
def pick_service_per_route(
    calendar_rows: list[dict],
    trips_rows: list[dict],
    target_route_ids: set[str],
) -> dict[str, str]:
    """Retourne {route_id: meilleur_service_id} pour les routes cibles.
    Chaque route peut utiliser un service_id différent ; on prend celui qui a
    le plus de trips (lundi=1 dans calendar.txt)."""
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
def snap_stop_to_shape(
    shape_pts: list[dict],
    stop_lat: float,
    stop_lon: float,
) -> float:
    """Retourne la distance cumulée (m) jusqu'au point de la shape le plus proche du stop."""
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


# ── Interpolation horaire → progress_m ─────────────────────────────────────
def build_schedule_progress(
    trip_stop_visits: list[tuple[float, float, float]],
    length_m: float,
) -> callable:
    """Retourne sched(t) → progress_m (linéaire par morceaux).
    trip_stop_visits = liste triée de (t_arrivée, t_départ, progress_m).
    Avant le premier arrêt : 0. Après le dernier : dernière progress connue."""
    if not trip_stop_visits:
        return lambda t: 0.0
    # Aplatir en points (t, p) : utilise arrivée puis départ (palier durant le dwell)
    pts: list[tuple[float, float]] = []
    for t_arr, t_dep, prog in trip_stop_visits:
        if pts and t_arr <= pts[-1][0]:
            # éviter t non-croissant (rare mais possible si arr == dep == prev_dep)
            t_arr = pts[-1][0] + 0.001
        pts.append((t_arr, prog))
        if t_dep > t_arr:
            pts.append((t_dep, prog))

    t_first = pts[0][0]
    t_last  = pts[-1][0]
    p_last  = pts[-1][1]

    def sched(t: float) -> float:
        if t <= t_first:
            return 0.0
        if t >= t_last:
            return p_last  # rester au dernier arrêt connu, pas sauter à length_m
        # bisection sur pts (liste triée)
        lo, hi = 0, len(pts) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if pts[mid][0] <= t:
                lo = mid
            else:
                hi = mid
        t1, p1 = pts[lo]
        t2, p2 = pts[hi]
        if t2 == t1:
            return p1
        return p1 + (p2 - p1) * (t - t1) / (t2 - t1)

    return sched


# ── Construction de la trajectoire d'un véhicule ──────────────────────────
def build_vehicle_trajectory(sched: callable, length_m: float, T_sim_offset: float,
                             ) -> list[dict]:
    """Retourne la trajectoire prédite (N_TRAJ_STEPS points) à partir d'une frame.
    T_sim_offset = secondes depuis T0_SECONDS. Renvoie list[PercentilePoint dict]."""
    points: list[dict] = []
    prev = (-1.0, -1.0, -1.0)
    for k in range(N_TRAJ_STEPS):
        delta_t = k * TRAJ_STEP_S
        t_world = T0_SECONDS + T_sim_offset + delta_t
        p50 = sched(t_world)
        if k == 0:
            p10 = p50
            p90 = p50
        else:
            sigma_s = sigma_time_s(delta_t)
            p10 = sched(t_world - sigma_s)
            p90 = sched(t_world + sigma_s)

        # invariants : ordre + monotonie non-décroissante par rapport au point précédent
        p50 = min(max(p50, 0.0), length_m)
        p10 = min(max(p10, 0.0), p50)
        p90 = min(max(p90, p50), length_m)
        if prev[0] >= 0:
            p10 = max(p10, prev[0])
            p50 = max(p50, prev[1])
            p90 = max(p90, prev[2])
            # ré-imposer p10 ≤ p50 ≤ p90 après le max
            p50 = max(p50, p10)
            p90 = max(p90, p50)
        prev = (p10, p50, p90)

        points.append({
            "t":   round(T_sim_offset + delta_t, 3),
            "p10": round(p10, 2),
            "p50": round(p50, 2),
            "p90": round(p90, 2),
        })
    return points


# ── Sélection des trips représentatifs ─────────────────────────────────────
def select_trip_for_route(
    trips_for_route: list[str],
    stop_times_by_trip: dict[str, list[tuple[float, float, str]]],
) -> str | None:
    """Trip le mieux calé sur la fenêtre [T0, T0+HORIZON].
    Critère 1 : maximum d'arrêts (le plus long trajet actif dans la fenêtre).
    Critère 2 : médiane temporelle la plus proche du milieu de fenêtre.
    Toutes les directions sont considérées."""
    T_mid = T0_SECONDS + HORIZON_S / 2.0
    best_trip = None
    best_score: tuple | None = None
    for tid in trips_for_route:
        visits = stop_times_by_trip.get(tid, [])
        if len(visits) < 2:
            continue
        t_first = visits[0][0]
        t_last  = visits[-1][0]
        if t_last < T0_SECONDS or t_first > T0_SECONDS + HORIZON_S:
            continue
        t_median = 0.5 * (t_first + t_last)
        score = (-len(visits), abs(t_median - T_mid))  # max arrêts, min écart temporel
        if best_score is None or score < best_score:
            best_score = score
            best_trip = tid
    return best_trip


# ── Algorithme principal ───────────────────────────────────────────────────
def build_scenario() -> dict:
    sys.path.insert(0, str(Path(__file__).parent.parent.parent))
    from sim.models import SimulationOutput

    required = ("routes.txt", "trips.txt", "stop_times.txt", "stops.txt", "calendar.txt")
    for name in required:
        if not (CACHE_DIR / name).exists():
            print(f"ERREUR : {CACHE_DIR / name} introuvable.", file=sys.stderr)
            sys.exit(1)
    if not ROUTES_IN.exists():
        print(f"ERREUR : {ROUTES_IN} introuvable. Lancer build_routes.py d'abord.", file=sys.stderr)
        sys.exit(1)

    # ── Charger routes_stm.json (sortie de build_routes) ───────────────────
    routes_data = json.loads(ROUTES_IN.read_text(encoding="utf-8"))
    line_ids = {r["line_id"] for r in routes_data}
    print(f"Routes chargées : {sorted(line_ids)}")

    shape_of_line:  dict[str, list[dict]] = {r["line_id"]: r["shape"]    for r in routes_data}
    length_of_line: dict[str, float]      = {r["line_id"]: r["length_m"] for r in routes_data}

    # ── Charger les tables GTFS ────────────────────────────────────────────
    routes_rows = read_csv(CACHE_DIR / "routes.txt")
    trips_rows  = read_csv(CACHE_DIR / "trips.txt")
    st_rows     = read_csv(CACHE_DIR / "stop_times.txt")
    stops_rows  = read_csv(CACHE_DIR / "stops.txt")
    cal_rows    = read_csv(CACHE_DIR / "calendar.txt")

    # stop_id → (lat, lon)
    stop_latlon: dict[str, tuple[float, float]] = {
        r["stop_id"]: (float(r["stop_lat"]), float(r["stop_lon"]))
        for r in stops_rows
    }

    # route_short_name → route_id et inverse pour les lignes cibles
    target_route_ids: dict[str, str] = {}     # route_id → short
    for r in routes_rows:
        short = r.get("route_short_name", "").strip()
        if short in line_ids:
            target_route_ids[r["route_id"]] = short
    target_route_id_set = set(target_route_ids.keys())

    # ── Choisir le meilleur service weekday par route ──────────────────────
    service_per_route = pick_service_per_route(cal_rows, trips_rows, target_route_id_set)
    services_used = sorted(set(service_per_route.values()))
    print(f"Services weekday utilisés : {services_used}")

    # ── Trips par route (avec le bon service_id par route) ─────────────────
    trips_by_route: dict[str, list[str]] = defaultdict(list)
    direction_of_trip: dict[str, str]    = {}
    for t in trips_rows:
        rid = t.get("route_id", "")
        expected_sid = service_per_route.get(rid)
        if not expected_sid or t.get("service_id") != expected_sid:
            continue
        trips_by_route[rid].append(t["trip_id"])
        direction_of_trip[t["trip_id"]] = t.get("direction_id", "0")

    # ── stop_times par trip → (t_arr, t_dep, stop_id) trié par stop_sequence ─
    all_relevant_trips = {tid for tids in trips_by_route.values() for tid in tids}
    raw_st: dict[str, list[tuple[int, float, float, str]]] = defaultdict(list)
    for row in st_rows:
        tid = row["trip_id"]
        if tid not in all_relevant_trips:
            continue
        try:
            seq    = int(row["stop_sequence"])
            t_arr  = parse_hms(row["arrival_time"])
            t_dep  = parse_hms(row["departure_time"])
        except (KeyError, ValueError):
            continue
        raw_st[tid].append((seq, t_arr, t_dep, row["stop_id"]))

    stop_times_by_trip: dict[str, list[tuple[float, float, str]]] = {}
    for tid, visits in raw_st.items():
        visits.sort(key=lambda x: x[0])
        stop_times_by_trip[tid] = [(t_arr, t_dep, sid) for _, t_arr, t_dep, sid in visits]

    # ── Sélectionner un trip par ligne ─────────────────────────────────────
    selected: list[dict] = []   # éléments : {vehicle_id, line_id, length_m, sched, visits_with_progress}

    for route_id, short in target_route_ids.items():
        tids = trips_by_route.get(route_id, [])
        chosen = select_trip_for_route(tids, stop_times_by_trip)
        if chosen is None:
            print(f"  AVERTISSEMENT : aucun trip valide pour la ligne {short}")
            continue

        # Snap tous les arrêts du trip sur la shape de la ligne
        route_shape = shape_of_line[short]
        visits = stop_times_by_trip[chosen]
        visits_full: list[tuple[float, float, float, str]] = []
        for t_arr, t_dep, sid in visits:
            ll = stop_latlon.get(sid)
            if ll is None:
                continue
            prog = snap_stop_to_shape(route_shape, ll[0], ll[1])
            visits_full.append((t_arr, t_dep, prog, sid))

        if len(visits_full) < 2:
            print(f"  AVERTISSEMENT : trip {chosen} (ligne {short}) — <2 arrêts avec position, ignoré.")
            continue

        # Détection de direction inverse : si la progression est majoritairement
        # décroissante, le trip roule dans le sens opposé à la shape → flip progress.
        n_inc = sum(1 for i in range(1, len(visits_full))
                    if visits_full[i][2] >= visits_full[i - 1][2])
        if n_inc < len(visits_full) // 2:
            L = length_of_line[short]
            visits_full = [(ta, td, L - p, sid) for ta, td, p, sid in visits_full]

        # S'assurer que t et progress sont triés et monotones
        visits_full.sort(key=lambda v: v[0])
        for i in range(1, len(visits_full)):
            if visits_full[i][2] < visits_full[i - 1][2]:
                visits_full[i] = (visits_full[i][0], visits_full[i][1],
                                  visits_full[i - 1][2], visits_full[i][3])

        visits_prog = [(t_arr, t_dep, prog) for t_arr, t_dep, prog, _ in visits_full]
        sched = build_schedule_progress(visits_prog, length_of_line[short])
        vehicle_id = f"{short}-trip{len(selected) + 1}"
        selected.append({
            "vehicle_id": vehicle_id,
            "line_id":    short,
            "length_m":   length_of_line[short],
            "sched":      sched,
            "visits":     visits_full,
            "trip_id":    chosen,
        })
        print(f"  Ligne {short:>4} : trip {chosen}, {len(visits_full)} arrêts, "
              f"{visits_full[0][0]/3600:.2f}h → {visits_full[-1][0]/3600:.2f}h")

    if not selected:
        raise RuntimeError("Aucun trip sélectionné.")

    # ── Produire les frames ────────────────────────────────────────────────
    frames: list[dict] = []
    T_sim = 0.0
    while T_sim <= HORIZON_S + 1e-6:
        vehicles_state = []
        for v in selected:
            traj = build_vehicle_trajectory(v["sched"], v["length_m"], T_sim)
            vehicles_state.append({
                "vehicle_id": v["vehicle_id"],
                "line_id":    v["line_id"],
                "trajectory": traj,
            })
        frames.append({
            "sim_time": round(T_sim, 3),
            "vehicles": vehicles_state,
            "transfers": [],
            "passenger": None,
        })
        T_sim = round(T_sim + FRAME_INTERVAL, 6)
    print(f"Frames générées : {len(frames)} (résolution {FRAME_INTERVAL}s)")

    # ── Fenêtres de correspondance ─────────────────────────────────────────
    # Pour chaque (trip, stop) avec stop partagé entre ≥2 lignes cibles, émettre une fenêtre.
    stop_to_lines: dict[str, set[str]] = defaultdict(set)
    for r in routes_data:
        for s in r["stops"]:
            stop_to_lines[s["stop_id"]].add(r["line_id"])

    windows: list[dict] = []
    for v in selected:
        for t_arr, t_dep, _prog, sid in v["visits"]:
            if len(stop_to_lines[sid]) < 2:
                continue
            t_open  = t_arr - T0_SECONDS
            t_close = max(t_dep - T0_SECONDS, t_open + 1.0)  # ≥1 s de fenêtre
            if t_close < 0 or t_open > HORIZON_S:
                continue
            t_open  = max(0.0, t_open)
            t_close = min(HORIZON_S, t_close)
            if t_close <= t_open:
                continue
            windows.append({
                "stop_id": sid,
                "connector_vehicle_id": v["vehicle_id"],
                "t_open":  round(t_open, 3),
                "t_close": round(t_close, 3),
            })
    print(f"Fenêtres de correspondance émises : {len(windows)}")

    # ── Événements d'arrêt (position + horaire planifié par arrêt) ───────────
    stop_events: list[dict] = []
    for v in selected:
        for t_arr, t_dep, prog, sid in v["visits"]:
            t_arr_rel = t_arr - T0_SECONDS
            t_dep_rel = t_dep - T0_SECONDS
            if t_dep_rel < 0 or t_arr_rel > HORIZON_S:
                continue
            stop_events.append({
                "vehicle_id":  v["vehicle_id"],
                "line_id":     v["line_id"],
                "stop_id":     sid,
                "progress_m":  round(prog, 2),
                "t_arr":       round(t_arr_rel, 3),
                "t_dep":       round(t_dep_rel, 3),
            })
    print(f"Événements d'arrêt émis : {len(stop_events)}")

    # ── Assembler et valider ───────────────────────────────────────────────
    output = {
        "routes": routes_data,
        "frames": frames,
        "passenger_trajectory": [],
        "transfer_windows": windows,
        "stop_events": stop_events,
    }
    print("Validation Pydantic …")
    SimulationOutput.model_validate(output)
    return output


def main() -> None:
    print(f"Construction de {OUTPUT.name} …")
    output = build_scenario()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(output, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    size_mb = OUTPUT.stat().st_size / (1024 * 1024)
    print(f"Écrit : {OUTPUT}  ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()

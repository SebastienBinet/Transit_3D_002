"""
Construit web/data/routes_stm.json à partir du cache GTFS.
Sélectionne le trip le plus long (en nombre d'arrêts) par direction pour
les 6 lignes cibles. Produit une liste de RouteGeometry validée par Pydantic.

Usage : uv run python data/blocks/build_routes.py
"""
from __future__ import annotations
import csv
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

# ── Chemins ────────────────────────────────────────────────────────────────
CACHE_DIR  = Path(__file__).parent.parent / "cache" / "gtfs"
OUTPUT     = Path(__file__).parent.parent.parent / "web" / "data" / "routes_stm.json"

# ── Lignes cibles (route_short_name dans le GTFS STM) ──────────────────────
TARGET_ROUTES = {"51", "11", "165", "129", "155", "66", "144", "124", "480", "103", "24"}

# On exporte les DEUX directions (N et S) pour toutes les lignes.
BIDIRECTIONAL = set(TARGET_ROUTES)

# Couleur hex par ligne-direction (pour l'IHM — non stockée dans le JSON,
# référence pour renderer.js). Chaque ligne : N = teinte de base, S = variante plus foncée.
LINE_COLORS_HEX = {
    "51N":  "#4488ff", "51S":  "#2255cc",   # bleu
    "165N": "#ff8844", "165S": "#cc5511",   # orange
    "11N":  "#44cc44", "11S":  "#229922",   # vert
    "129N": "#ffcc00", "129S": "#cc9900",   # jaune
    "155N": "#44ccdd", "155S": "#2299aa",   # cyan
    "66N":  "#ff4466", "66S":  "#cc1133",   # rose
    "144N": "#88ff44", "144S": "#55cc11",   # vert lime
    "124N": "#ff9900", "124S": "#cc6600",   # orange foncé / brun-orange
    "480N": "#9900cc", "480S": "#6600aa",   # violet / mauve foncé
    "103N": "#ff6600", "103S": "#cc4400",   # orange-rouge
    "24N":  "#00ccaa", "24S":  "#009977",   # turquoise
}

LAT_M = 111_000.0


def read_csv(path: Path) -> list[dict]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance en mètres entre deux points lat/lon (sphère)."""
    R = 6_371_000.0
    φ1, φ2 = math.radians(lat1), math.radians(lat2)
    dφ = math.radians(lat2 - lat1)
    dλ = math.radians(lon2 - lon1)
    a = math.sin(dφ / 2) ** 2 + math.cos(φ1) * math.cos(φ2) * math.sin(dλ / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def progress_along_shape(
    shape_pts: list[tuple[float, float]],
    stop_lat: float,
    stop_lon: float,
) -> float:
    """
    Progression en mètres du début de la shape jusqu'au point le plus proche du stop.
    Cherche le point de la shape le plus proche du stop, retourne la distance cumulée
    jusqu'à ce point.
    """
    best_dist = float("inf")
    best_cum  = 0.0
    cum = 0.0
    for i, (lat, lon) in enumerate(shape_pts):
        d = haversine_m(stop_lat, stop_lon, lat, lon)
        if d < best_dist:
            best_dist = d
            best_cum  = cum
        if i + 1 < len(shape_pts):
            cum += haversine_m(lat, lon, shape_pts[i + 1][0], shape_pts[i + 1][1])
    return best_cum


def build_routes() -> list[dict]:
    for name in ("routes.txt", "trips.txt", "stop_times.txt", "stops.txt", "shapes.txt"):
        if not (CACHE_DIR / name).exists():
            print(f"ERREUR : {CACHE_DIR / name} introuvable. Lancer fetch_gtfs.py d'abord.", file=sys.stderr)
            sys.exit(1)

    # ── Charger les tables GTFS ────────────────────────────────────────────
    routes_rows   = read_csv(CACHE_DIR / "routes.txt")
    trips_rows    = read_csv(CACHE_DIR / "trips.txt")
    st_rows       = read_csv(CACHE_DIR / "stop_times.txt")
    stops_rows    = read_csv(CACHE_DIR / "stops.txt")
    shapes_rows   = read_csv(CACHE_DIR / "shapes.txt")

    # ── Index des stops : stop_id → {lat, lon, name} ───────────────────────
    stop_info: dict[str, dict] = {}
    for row in stops_rows:
        stop_info[row["stop_id"]] = {
            "lat":  float(row["stop_lat"]),
            "lon":  float(row["stop_lon"]),
            "name": row.get("stop_name", row["stop_id"]),
        }

    # ── Filtrer les route_id cibles ────────────────────────────────────────
    target_route_ids: dict[str, str] = {}   # route_id → route_short_name
    for row in routes_rows:
        short = row.get("route_short_name", "").strip()
        if short in TARGET_ROUTES:
            target_route_ids[row["route_id"]] = short

    if not target_route_ids:
        print("ERREUR : aucune des lignes cibles trouvée dans routes.txt.", file=sys.stderr)
        print(f"  Lignes cherchées : {TARGET_ROUTES}", file=sys.stderr)
        sys.exit(1)
    print(f"Lignes trouvées : { {v: k for k, v in target_route_ids.items()} }")

    # ── Trips par route_id ─────────────────────────────────────────────────
    trips_by_route: dict[str, list[str]] = defaultdict(list)   # route_id → [trip_id]
    shape_of_trip:  dict[str, str]       = {}                   # trip_id → shape_id
    direction_of_trip: dict[str, str]    = {}
    for row in trips_rows:
        rid = row["route_id"]
        if rid in target_route_ids:
            tid = row["trip_id"]
            trips_by_route[rid].append(tid)
            shape_of_trip[tid]     = row.get("shape_id", "")
            direction_of_trip[tid] = row.get("direction_id", "0")

    # ── Stop sequences par trip_id ─────────────────────────────────────────
    stop_seq_by_trip: dict[str, list[str]] = defaultdict(list)
    for row in st_rows:
        tid = row["trip_id"]
        if tid in shape_of_trip:
            stop_seq_by_trip[tid].append(row["stop_id"])

    # ── Shape points par shape_id ──────────────────────────────────────────
    shape_pts_by_id: dict[str, list[tuple[float, float, float]]] = defaultdict(list)
    for row in shapes_rows:
        sid = row["shape_id"]
        shape_pts_by_id[sid].append((
            float(row["shape_pt_lat"]),
            float(row["shape_pt_lon"]),
            float(row["shape_pt_sequence"]),
        ))
    # Trier par séquence
    for sid in shape_pts_by_id:
        shape_pts_by_id[sid].sort(key=lambda x: x[2])

    # ── Sélectionner le trip représentatif par route ──────────────────────────
    # Préférer la direction dont le dernier arrêt est plus au sud que le premier
    # (entrée vers le centre-ville, pointe du matin). Tiebreak : plus grand nombre d'arrêts.
    result_routes: list[dict] = []

    def southbound_score(tid: str) -> float:
        """Positif si le dernier arrêt est plus au sud que le premier."""
        stops = stop_seq_by_trip.get(tid, [])
        if len(stops) < 2:
            return 0.0
        first = stop_info.get(stops[0])
        last  = stop_info.get(stops[-1])
        if not first or not last:
            return 0.0
        return first["lat"] - last["lat"]

    def direction_suffix(tid: str) -> str:
        """'N' si le dernier arrêt est plus au nord, 'S' sinon."""
        return "S" if southbound_score(tid) > 0 else "N"

    def build_one_direction(
        short_name: str,
        best_trip: str,
        line_id: str,
        gtfs_dir_id: str | None,
    ) -> dict | None:
        shape_id = shape_of_trip[best_trip]
        stop_ids = stop_seq_by_trip[best_trip]
        print(f"  Ligne {line_id} (dir {gtfs_dir_id}) : trip {best_trip}, "
              f"{len(stop_ids)} arrêts, shape {shape_id}")

        raw_pts = shape_pts_by_id.get(shape_id, [])
        if not raw_pts:
            print(f"  AVERTISSEMENT : shape {shape_id} vide, ligne {line_id} ignorée")
            return None
        shape_latlon = [(pt[0], pt[1]) for pt in raw_pts]

        shape_length_m = sum(
            haversine_m(shape_latlon[i][0], shape_latlon[i][1],
                        shape_latlon[i+1][0], shape_latlon[i+1][1])
            for i in range(len(shape_latlon) - 1)
        )

        stops_out = []
        seen_stops: set[str] = set()
        for sid in stop_ids:
            if sid in seen_stops:
                continue
            seen_stops.add(sid)
            info = stop_info.get(sid)
            if not info:
                continue
            prog = progress_along_shape(shape_latlon, info["lat"], info["lon"])
            stops_out.append({
                "stop_id":    sid,
                "name":       info["name"],
                "position":   {"lat": info["lat"], "lon": info["lon"]},
                "progress_m": round(prog, 1),
            })

        stops_out.sort(key=lambda s: s["progress_m"])

        route_dict: dict = {
            "line_id":  line_id,
            "stops":    stops_out,
            "shape":    [{"lat": pt[0], "lon": pt[1]} for pt in shape_latlon],
            "length_m": round(shape_length_m, 1),
        }
        if gtfs_dir_id is not None:
            route_dict["gtfs_direction_id"] = gtfs_dir_id
        return route_dict

    for route_id, short_name in target_route_ids.items():
        candidates = [
            tid for tid in trips_by_route[route_id]
            if len(stop_seq_by_trip.get(tid, [])) > 1
        ]
        if not candidates:
            print(f"  AVERTISSEMENT : aucun trip valide pour la ligne {short_name}")
            continue

        # Meilleur trip par direction (celui avec le plus d'arrêts dans chaque direction)
        by_dir: dict[str, str] = {}
        for tid in candidates:
            d = direction_of_trip.get(tid, "0")
            if d not in by_dir or len(stop_seq_by_trip[tid]) > len(stop_seq_by_trip[by_dir[d]]):
                by_dir[d] = tid

        if short_name in BIDIRECTIONAL:
            # Émettre une entrée par direction avec suffixe N/S.
            # Quand deux directions existent, garantir des suffixes distincts :
            # la plus « vers le sud » reçoit S, l'autre N (évite une collision 51N/51N).
            items = sorted(by_dir.items())
            if len(items) >= 2:
                ranked = sorted(items, key=lambda kv: southbound_score(kv[1]), reverse=True)
                suffix_of = {ranked[0][0]: "S", ranked[1][0]: "N"}
                for dir_id, best_trip in ranked[2:]:   # rare : >2 directions
                    suffix_of[dir_id] = direction_suffix(best_trip)
            else:
                dir_id, best_trip = items[0]
                suffix_of = {dir_id: direction_suffix(best_trip)}

            for dir_id, best_trip in items:
                lid    = f"{short_name}{suffix_of[dir_id]}"
                result = build_one_direction(short_name, best_trip, lid, dir_id)
                if result:
                    result_routes.append(result)
        else:
            # Direction unique : préférer celle dont le dernier arrêt est plus au sud
            best_trip = max(
                by_dir.values(),
                key=lambda t: (southbound_score(t), len(stop_seq_by_trip.get(t, []))),
            )
            result = build_one_direction(short_name, best_trip, short_name, None)
            if result:
                result_routes.append(result)

    return result_routes


def main() -> None:
    print("Construction de routes_stm.json …")
    routes = build_routes()
    if not routes:
        print("ERREUR : aucune route construite.", file=sys.stderr)
        sys.exit(1)

    # Validation Pydantic
    sys.path.insert(0, str(Path(__file__).parent.parent.parent))
    from sim.models import RouteGeometry
    validated = [RouteGeometry.model_validate(r) for r in routes]

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps([r.model_dump() for r in validated], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Écrit : {OUTPUT}  ({OUTPUT.stat().st_size / 1024:.0f} KB)")
    for r in validated:
        print(f"  {r.line_id:>4} : {len(r.stops)} arrêts, {r.length_m/1000:.1f} km, {len(r.shape)} pts de shape")


if __name__ == "__main__":
    main()

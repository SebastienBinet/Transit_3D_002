"""
Télécharge le réseau de rues depuis l'API Overpass (OSM) pour la zone
couvrant les lignes STM, et produit un graphe nodes/edges compact.

Sortie : web/data/streets_montreal.json
Format :
  {
    "nodes": { "id": {"lat": float, "lon": float}, ... },
    "edges": [ [id_a, id_b, dist_m], ... ]
  }

Usage : uv run python data/blocks/fetch_osm.py
"""
from __future__ import annotations
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

WEB_DATA   = Path(__file__).parent.parent.parent / "web" / "data"
ROUTES_STM = WEB_DATA / "routes_stm.json"
OUT_FILE   = WEB_DATA / "streets_montreal.json"

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
BUFFER_M     = 600      # marge autour des routes (mètres)
LAT_M        = 111_000.0

# Types de voies piétonnes et cyclables inclus
HIGHWAY_FILTER = (
    "primary|secondary|tertiary|residential|unclassified|living_street|"
    "pedestrian|footway|path|cycleway|steps|service"
)


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000.0
    φ1, φ2 = math.radians(lat1), math.radians(lat2)
    dφ = math.radians(lat2 - lat1)
    dλ = math.radians(lon2 - lon1)
    a = math.sin(dφ / 2) ** 2 + math.cos(φ1) * math.cos(φ2) * math.sin(dλ / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def load_bounds_with_buffer() -> tuple[float, float, float, float]:
    if not ROUTES_STM.exists():
        print("ERREUR : routes_stm.json introuvable. Lancer build_routes.py d'abord.", file=sys.stderr)
        sys.exit(1)
    routes = json.loads(ROUTES_STM.read_text(encoding="utf-8"))
    lats, lons = [], []
    for r in routes:
        for pt in r["shape"]:
            lats.append(pt["lat"])
            lons.append(pt["lon"])
    lat_min, lat_max = min(lats), max(lats)
    lon_min, lon_max = min(lons), max(lons)
    lat_center = (lat_min + lat_max) / 2
    lon_m = LAT_M * math.cos(math.radians(lat_center))
    d_lat = BUFFER_M / LAT_M
    d_lon = BUFFER_M / lon_m
    return lat_min - d_lat, lon_min - d_lon, lat_max + d_lat, lon_max + d_lon


def fetch_overpass(s: float, w: float, n: float, e: float) -> dict:
    try:
        import requests
    except ImportError:
        print("ERREUR : 'requests' non installé. Lancer : uv add requests", file=sys.stderr)
        sys.exit(1)

    query = f"""
[out:json][timeout:120];
(
  way[highway~"^({HIGHWAY_FILTER})$"]
    ({s:.6f},{w:.6f},{n:.6f},{e:.6f});
)->.ways;
.ways out geom;
"""
    print(f"Requête Overpass (bbox {s:.4f},{w:.4f},{n:.4f},{e:.4f}) …")
    headers = {"User-Agent": "transit-3d/1.0 (github.com/SebastienBinet/Transit_3D_002)"}
    resp = requests.post(OVERPASS_URL, data={"data": query}, headers=headers, timeout=150)
    resp.raise_for_status()
    data = resp.json()
    print(f"  {len(data.get('elements', []))} segments de rue reçus.")
    return data


def build_graph(overpass_data: dict) -> dict:
    """
    Construit un graphe nodes/edges depuis les éléments Overpass.
    Chaque nœud de way OSM = un nœud du graphe.
    Chaque paire consécutive (node_i, node_{i+1}) dans un way = une arête.
    Les nœuds partagés par plusieurs ways = intersections.
    """
    # Compter les ways qui passent par chaque nœud → intersections
    node_usage: dict[str, int] = defaultdict(int)
    ways_geom: list[list[tuple[str, float, float]]] = []

    for elem in overpass_data.get("elements", []):
        if elem.get("type") != "way":
            continue
        geom = elem.get("geometry", [])
        if len(geom) < 2:
            continue
        way_nodes: list[tuple[str, float, float]] = []
        for i, pt in enumerate(geom):
            # Utiliser une clé lat/lon arrondie comme ID de nœud (pas d'ID OSM dans out geom)
            node_key = f"{pt['lat']:.7f},{pt['lon']:.7f}"
            way_nodes.append((node_key, pt["lat"], pt["lon"]))
            node_usage[node_key] += 1
        ways_geom.append(way_nodes)

    # Construire le graphe en séquences de segments
    nodes_out: dict[str, dict] = {}
    edges_out: list[list] = []
    seen_edges: set[frozenset] = set()

    for way_nodes in ways_geom:
        # Ajouter tous les nœuds
        for nid, lat, lon in way_nodes:
            if nid not in nodes_out:
                nodes_out[nid] = {"lat": lat, "lon": lon}

        # Ajouter les arêtes entre nœuds consécutifs
        for i in range(len(way_nodes) - 1):
            a_id, a_lat, a_lon = way_nodes[i]
            b_id, b_lat, b_lon = way_nodes[i + 1]
            edge_key = frozenset({a_id, b_id})
            if edge_key in seen_edges:
                continue
            seen_edges.add(edge_key)
            dist = haversine_m(a_lat, a_lon, b_lat, b_lon)
            if dist < 0.1:
                continue  # nœuds dupliqués
            edges_out.append([a_id, b_id, round(dist, 2)])

    print(f"  Graphe : {len(nodes_out)} nœuds, {len(edges_out)} arêtes")
    return {"nodes": nodes_out, "edges": edges_out}


def main() -> None:
    s, w, n, e = load_bounds_with_buffer()
    data = fetch_overpass(s, w, n, e)
    graph = build_graph(data)

    WEB_DATA.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(
        json.dumps(graph, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    size_kb = OUT_FILE.stat().st_size / 1024
    print(f"Écrit : {OUT_FILE}  ({size_kb:.0f} KB)")


if __name__ == "__main__":
    main()

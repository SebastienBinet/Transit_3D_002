"""
Tests unitaires du routeur de trajets (build_journeys.py) sur un réseau synthétique
minimal — sans navigateur ni données réelles. Valide :
  - base_line / dist_m
  - point d'intersection de deux lignes
  - plus tôt arrivé (Dijkstra temporel)
  - correspondance à pied (arrêts voisins ≤ rayon)
  - règle « un numéro de ligne au plus une fois par trajet »
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from data.blocks.build_journeys import (
    base_line, dist_m, intersection_point,
    build_nearby, boardings_by_stop, search,
)


# ── Helpers de construction de réseau ──────────────────────────────────────
def mk_stops(specs):
    """specs : liste de (stop_id, base, line_id, lat, lon)."""
    return [{"stop_id": sid, "name": sid, "base": base, "line_id": lid,
             "lat": lat, "lon": lon}
            for sid, base, lid, lat, lon in specs]


def mk_trip(trip_id, line_id, base, seq):
    """seq : liste de (stop_global, t_dep, t_arr)."""
    return {"trip_id": trip_id, "line_id": line_id, "base": base,
            "seq": [{"stop": s, "t_dep": d, "t_arr": a} for s, d, a in seq]}


# ── base_line / dist_m ─────────────────────────────────────────────────────
def test_base_line():
    assert base_line("51N") == "51"
    assert base_line("480S") == "480"
    assert base_line("144") == "144"


def test_dist_m_zero_and_known():
    assert dist_m(45.5, -73.6, 45.5, -73.6) == 0.0
    # 0.001° lat ≈ 111 m
    d = dist_m(45.5, -73.6, 45.501, -73.6)
    assert 105 < d < 117


# ── intersection_point : milieu de la paire la plus proche ─────────────────
def test_intersection_point():
    stops = mk_stops([
        ("A", "1", "1N", 45.500, -73.600),
        ("B", "2", "2N", 45.5002, -73.600),   # ~22 m de A
        ("Z", "2", "2N", 45.600, -73.600),    # loin
    ])
    pt = intersection_point(stops, ["1", "2"])
    assert abs(pt["lat"] - 45.5001) < 1e-6
    assert pt["defining_lines"] == ["1", "2"]
    assert pt["nearest_pair_m"] < 30


# ── Réseau jouet : O(1∩2) → D(3∩4) via bus1 + corresp. pied + bus3 ─────────
def _toy_network():
    # A,B au point O ; C,D au point de correspondance ; E,F au point D.
    stops = mk_stops([
        ("A", "1", "1N", 45.500, -73.600),    # 0
        ("B", "2", "2N", 45.5001, -73.600),   # 1  (≈11 m de A → point O)
        ("C", "1", "1N", 45.510, -73.600),    # 2  (≈1.1 km de A → trajet bus)
        ("D", "3", "3N", 45.5101, -73.600),   # 3  (≈11 m de C → corresp. pied)
        ("E", "3", "3N", 45.520, -73.600),    # 4
        ("F", "4", "4N", 45.5201, -73.600),   # 5  (≈11 m de E → point D)
    ])
    trips = [
        mk_trip("t1", "1N", "1", [(0, 100, 100), (2, 150, 200)]),   # A→C
        mk_trip("t3", "3N", "3", [(3, 300, 300), (4, 350, 400)]),   # D→E
    ]
    return stops, trips


def test_earliest_arrival_with_walk_transfer():
    stops, trips = _toy_network()
    nearby = build_nearby(stops)
    board = boardings_by_stop(trips)
    case = {"id": "T", "origin_lines": ["1", "2"], "dest_lines": ["3", "4"],
            "depart_s": 0}
    origin, dest, dep, journeys = search(case, stops, trips, nearby, board)
    assert journeys, "au moins un trajet attendu"
    best = journeys[0]
    lines = [leg["base"] for leg in best["legs"]]
    assert lines == ["1", "3"]
    # arrivée = t_arr du dernier bus (400) + marche de sortie (~8 s)
    assert 400 <= best["arrival_s"] < 420


def test_line_used_once():
    # Deux passages de la MÊME ligne 1 enchaînés ne doivent pas former un trajet :
    # une fois la ligne 1 prise, elle est interdite ; aucun chemin n'atteint D.
    stops = mk_stops([
        ("A", "1", "1N", 45.500, -73.600),    # 0  point O (lignes 1 & 2)
        ("B", "2", "2N", 45.5001, -73.600),   # 1
        ("C", "1", "1N", 45.510, -73.600),    # 2
        ("Cb", "1", "1N", 45.5101, -73.600),  # 3  voisin de C, encore ligne 1
        ("E", "1", "1N", 45.520, -73.600),    # 4
        ("F", "4", "4N", 45.5201, -73.600),   # 5  point D (lignes 1 & 4) — mais via ligne 1 seulement
    ])
    trips = [
        mk_trip("p1", "1N", "1", [(0, 100, 100), (2, 150, 200)]),   # A→C
        mk_trip("p2", "1N", "1", [(3, 300, 300), (4, 350, 400)]),   # Cb→E (encore ligne 1)
    ]
    nearby = build_nearby(stops)
    board = boardings_by_stop(trips)
    case = {"id": "T", "origin_lines": ["1", "2"], "dest_lines": ["1", "4"],
            "depart_s": 0}
    _, _, _, journeys = search(case, stops, trips, nearby, board)
    # E (point D) n'est atteignable qu'en réutilisant la ligne 1 → aucun trajet.
    assert journeys == []


def test_respects_departure_time():
    # Bus 1 part trop tôt (avant depart_s) → pas embarquable ; aucun trajet.
    stops, trips = _toy_network()
    nearby = build_nearby(stops)
    board = boardings_by_stop(trips)
    case = {"id": "T", "origin_lines": ["1", "2"], "dest_lines": ["3", "4"],
            "depart_s": 120}   # > t_dep=100 du bus 1
    _, _, _, journeys = search(case, stops, trips, nearby, board)
    assert journeys == []

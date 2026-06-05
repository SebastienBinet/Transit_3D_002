"""
Tests unitaires de data/blocks/build_scenario_stm.py.

La construction du cône d'incertitude p10/p50/p90 vit désormais côté visualizer
(web/js/scenario-model.js, couverte par tests/level3/test_scenario_model.mjs).
Ici on couvre la logique Python restante : parsing horaire, nommage de direction,
snap des arrêts sur la shape et détection/correction de la direction inverse.
"""
from __future__ import annotations
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from data.blocks.build_scenario_stm import (
    parse_hms,
    base_route_name,
    snap_stop_to_shape,
    snap_and_orient_trip,
)


# ── parse_hms ──────────────────────────────────────────────────────────────
def test_parse_hms_basic():
    assert parse_hms("07:00:00") == 25200
    assert parse_hms("07:30:00") == 27000
    # GTFS permet les heures > 24 (service de nuit)
    assert parse_hms("25:15:00") == 25 * 3600 + 15 * 60


# ── base_route_name ────────────────────────────────────────────────────────
def test_base_route_name_strips_direction_suffix():
    assert base_route_name("124N") == "124"
    assert base_route_name("480S") == "480"


def test_base_route_name_keeps_plain_lines():
    assert base_route_name("51") == "51"
    assert base_route_name("165") == "165"
    # pas de faux positif sur une lettre non N/S
    assert base_route_name("11A") == "11A"


# ── snap_stop_to_shape ─────────────────────────────────────────────────────
# Shape est-ouest le long de lat=45.50, de lon -73.65 à -73.55
SHAPE = [
    {"lat": 45.50, "lon": -73.65},
    {"lat": 45.50, "lon": -73.60},
    {"lat": 45.50, "lon": -73.55},
]


def test_snap_first_vertex_is_zero():
    assert snap_stop_to_shape(SHAPE, 45.50, -73.65) == 0.0


def test_snap_increases_along_shape():
    d_mid = snap_stop_to_shape(SHAPE, 45.50, -73.60)
    d_end = snap_stop_to_shape(SHAPE, 45.50, -73.55)
    assert 0.0 < d_mid < d_end


# ── snap_and_orient_trip ───────────────────────────────────────────────────
STOPS = {
    "A": (45.50, -73.65),   # début de la shape
    "B": (45.50, -73.60),   # milieu
    "C": (45.50, -73.55),   # fin
}
LENGTH = snap_stop_to_shape(SHAPE, 45.50, -73.55)  # longueur ≈ shape complète


def test_orient_forward_trip_is_increasing():
    visits = [(100.0, 110.0, "A"), (200.0, 210.0, "B"), (300.0, 300.0, "C")]
    full = snap_and_orient_trip(visits, STOPS, SHAPE, LENGTH)
    assert full is not None
    progs = [p for _, _, p in full]
    assert progs == sorted(progs)
    assert progs[0] < progs[-1]


def test_orient_reverse_trip_is_flipped_to_increasing():
    # Trip dans le sens C→B→A : la progression brute décroît → flip attendu.
    visits = [(100.0, 110.0, "C"), (200.0, 210.0, "B"), (300.0, 300.0, "A")]
    full = snap_and_orient_trip(visits, STOPS, SHAPE, LENGTH)
    assert full is not None
    progs = [p for _, _, p in full]
    assert progs == sorted(progs), f"progression non monotone après flip : {progs}"
    assert progs[0] < progs[-1]


def test_orient_rejects_single_stop():
    visits = [(100.0, 110.0, "A")]
    assert snap_and_orient_trip(visits, STOPS, SHAPE, LENGTH) is None

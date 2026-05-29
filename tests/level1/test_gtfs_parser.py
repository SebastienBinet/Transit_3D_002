"""
Tests unitaires pour build_routes.py — utilise un GTFS minimal synthétique en mémoire.
Valide : sélection du meilleur trip, calcul de progress_m, sortie RouteGeometry.
"""
import csv
import io
import json
import math
import sys
import tempfile
from pathlib import Path

import pytest

# Ajouter le répertoire racine pour pouvoir importer les modules du projet
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from data.blocks.build_routes import (
    haversine_m,
    progress_along_shape,
    build_routes,
    CACHE_DIR,
    OUTPUT,
    TARGET_ROUTES,
)


# ── Helpers ────────────────────────────────────────────────────────────────

def write_csv(path: Path, rows: list[dict]) -> None:
    if not rows:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=rows[0].keys())
        w.writeheader()
        w.writerows(rows)


# ── Tests haversine ────────────────────────────────────────────────────────

def test_haversine_zero():
    assert haversine_m(45.5, -73.6, 45.5, -73.6) == pytest.approx(0.0)


def test_haversine_known_distance():
    # 1 degré de latitude ≈ 111 km
    d = haversine_m(45.0, -73.6, 46.0, -73.6)
    assert 110_000 < d < 112_000


def test_haversine_east():
    # 0.01° de longitude à 45° lat ≈ 0.01 * 111_000 * cos(45°) ≈ 785 m
    d = haversine_m(45.5, -73.640, 45.5, -73.630)
    assert 770 < d < 800


# ── Tests progress_along_shape ─────────────────────────────────────────────

def test_progress_start():
    shape = [(45.5, -73.65), (45.5, -73.64), (45.5, -73.63)]
    prog = progress_along_shape(shape, 45.5, -73.65)
    assert prog == pytest.approx(0.0, abs=10)


def test_progress_end():
    shape = [(45.5, -73.65), (45.5, -73.64), (45.5, -73.63)]
    prog_full = sum(
        haversine_m(shape[i][0], shape[i][1], shape[i+1][0], shape[i+1][1])
        for i in range(len(shape) - 1)
    )
    prog = progress_along_shape(shape, 45.5, -73.63)
    assert abs(prog - prog_full) < 10


def test_progress_midpoint():
    shape = [(45.5, -73.65), (45.5, -73.64), (45.5, -73.63)]
    seg_len = haversine_m(45.5, -73.65, 45.5, -73.64)
    prog = progress_along_shape(shape, 45.5, -73.64)
    assert abs(prog - seg_len) < 10


# ── Tests build_routes avec GTFS synthétique ───────────────────────────────

SYNTHETIC_GTFS = {
    "routes.txt": [
        {"route_id": "R51", "route_short_name": "51", "route_long_name": "Test 51"},
    ],
    "trips.txt": [
        {"route_id": "R51", "trip_id": "T51A", "shape_id": "S51", "direction_id": "0",
         "service_id": "WD"},
        {"route_id": "R51", "trip_id": "T51B", "shape_id": "S51", "direction_id": "0",
         "service_id": "WD"},
    ],
    "stop_times.txt": [
        # T51A : 3 arrêts
        {"trip_id": "T51A", "stop_id": "SA", "arrival_time": "08:00:00", "stop_sequence": "1"},
        {"trip_id": "T51A", "stop_id": "SB", "arrival_time": "08:05:00", "stop_sequence": "2"},
        {"trip_id": "T51A", "stop_id": "SC", "arrival_time": "08:10:00", "stop_sequence": "3"},
        # T51B : 2 arrêts seulement
        {"trip_id": "T51B", "stop_id": "SA", "arrival_time": "09:00:00", "stop_sequence": "1"},
        {"trip_id": "T51B", "stop_id": "SB", "arrival_time": "09:05:00", "stop_sequence": "2"},
    ],
    "stops.txt": [
        {"stop_id": "SA", "stop_name": "Arrêt A", "stop_lat": "45.500", "stop_lon": "-73.650"},
        {"stop_id": "SB", "stop_name": "Arrêt B", "stop_lat": "45.500", "stop_lon": "-73.640"},
        {"stop_id": "SC", "stop_name": "Arrêt C", "stop_lat": "45.500", "stop_lon": "-73.630"},
    ],
    "shapes.txt": [
        {"shape_id": "S51", "shape_pt_lat": "45.500", "shape_pt_lon": "-73.650", "shape_pt_sequence": "1"},
        {"shape_id": "S51", "shape_pt_lat": "45.500", "shape_pt_lon": "-73.645", "shape_pt_sequence": "2"},
        {"shape_id": "S51", "shape_pt_lat": "45.500", "shape_pt_lon": "-73.640", "shape_pt_sequence": "3"},
        {"shape_id": "S51", "shape_pt_lat": "45.500", "shape_pt_lon": "-73.635", "shape_pt_sequence": "4"},
        {"shape_id": "S51", "shape_pt_lat": "45.500", "shape_pt_lon": "-73.630", "shape_pt_sequence": "5"},
    ],
    "calendar.txt": [
        {"service_id": "WD", "monday": "1", "tuesday": "1", "wednesday": "1",
         "thursday": "1", "friday": "1", "saturday": "0", "sunday": "0",
         "start_date": "20260101", "end_date": "20261231"},
    ],
    "calendar_dates.txt": [],
}


@pytest.fixture()
def gtfs_cache(tmp_path, monkeypatch):
    """Crée un cache GTFS synthétique dans un répertoire temporaire."""
    cache = tmp_path / "gtfs"
    cache.mkdir()
    for fname, rows in SYNTHETIC_GTFS.items():
        if rows:
            write_csv(cache / fname, rows)
        else:
            (cache / fname).write_text("", encoding="utf-8")

    monkeypatch.setattr("data.blocks.build_routes.CACHE_DIR", cache)
    monkeypatch.setattr(
        "data.blocks.build_routes.TARGET_ROUTES", {"51"}
    )
    out = tmp_path / "routes_stm.json"
    monkeypatch.setattr("data.blocks.build_routes.OUTPUT", out)
    return cache, out


def test_build_routes_selects_longest_trip(gtfs_cache):
    """build_routes doit choisir T51A (3 arrêts) plutôt que T51B (2 arrêts)."""
    cache, out = gtfs_cache
    routes = build_routes()
    assert len(routes) == 1
    r = routes[0]
    assert r["line_id"] == "51"
    assert len(r["stops"]) == 3   # A, B, C — trip le plus long


def test_build_routes_progress_monotone(gtfs_cache):
    """Les progress_m des arrêts doivent être monotones non-décroissants."""
    _, _ = gtfs_cache
    routes = build_routes()
    stops = routes[0]["stops"]
    progs = [s["progress_m"] for s in stops]
    for i in range(1, len(progs)):
        assert progs[i] >= progs[i - 1], f"Non-monotone à l'arrêt {i}"


def test_build_routes_shape_nonempty(gtfs_cache):
    """La shape doit avoir au moins 2 points."""
    _, _ = gtfs_cache
    routes = build_routes()
    assert len(routes[0]["shape"]) >= 2


def test_build_routes_length_positive(gtfs_cache):
    """La longueur de la route doit être positive."""
    _, _ = gtfs_cache
    routes = build_routes()
    assert routes[0]["length_m"] > 0


def test_build_routes_pydantic_valid(gtfs_cache):
    """La sortie doit passer la validation Pydantic RouteGeometry."""
    _, _ = gtfs_cache
    from sim.models import RouteGeometry
    routes = build_routes()
    for r in routes:
        RouteGeometry.model_validate(r)   # ne doit pas lever d'exception

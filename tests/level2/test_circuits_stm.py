"""
Tests L2 : schéma des fichiers circuit (scalable) produits par build_scenario_stm.py.

Deux niveaux :
  1. Validation du schéma Pydantic sur des données synthétiques (toujours exécuté).
  2. Validation des fichiers réellement générés s'ils existent (sinon skip).
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from sim.models import CircuitData, CircuitIndex, TripSchedule

DATA_DIR   = Path(__file__).parent.parent.parent / "web" / "data"
INDEX_PATH = DATA_DIR / "circuits_index.json"


# ── 1. Schéma sur données synthétiques (toujours exécuté) ──────────────────
def _synthetic_circuit() -> dict:
    return {
        "line_id": "124N",
        "gtfs_direction_id": "0",
        "route": {
            "line_id": "124N",
            "stops": [],
            "shape": [{"lat": 45.50, "lon": -73.65}, {"lat": 45.52, "lon": -73.60}],
            "length_m": 4200.0,
        },
        "trips": [{
            "trip_id": "t1",
            "schedule": [
                {"t_arr": 25200, "t_dep": 25210, "progress_m": 0.0},
                {"t_arr": 25500, "t_dep": 25500, "progress_m": 2100.0},
                {"t_arr": 25800, "t_dep": 25800, "progress_m": 4200.0},
            ],
        }],
    }


def test_circuit_schema_valid() -> None:
    CircuitData.model_validate(_synthetic_circuit())


def test_circuit_index_schema_valid() -> None:
    CircuitIndex.model_validate({
        "t0_seconds": 25200,
        "horizon_s": 3600,
        "frame_interval": 5,
        "traj_step": 60,
        "sigma": {"kind": "power", "coeff_min": 3.0, "exp": 0.301},
        "circuits": [{
            "line_id": "124N", "gtfs_direction_id": "0",
            "color": "#ff9900", "file": "circuits/124N.json", "n_trips": 1,
        }],
    })


def test_trip_rejects_decreasing_progress() -> None:
    with pytest.raises(Exception):
        TripSchedule.model_validate({
            "trip_id": "bad",
            "schedule": [
                {"t_arr": 100, "t_dep": 100, "progress_m": 500.0},
                {"t_arr": 200, "t_dep": 200, "progress_m": 100.0},  # recule → invalide
            ],
        })


def test_trip_rejects_single_stop() -> None:
    with pytest.raises(Exception):
        TripSchedule.model_validate({
            "trip_id": "bad",
            "schedule": [{"t_arr": 100, "t_dep": 100, "progress_m": 0.0}],
        })


# ── 2. Fichiers réellement générés (skip si absents) ──────────────────────
pytestmark_generated = pytest.mark.skipif(
    not INDEX_PATH.exists(),
    reason="circuits_index.json non généré (lancer build_scenario_stm.py)",
)


@pytestmark_generated
def test_generated_index_and_circuits_valid() -> None:
    index = CircuitIndex.model_validate(json.loads(INDEX_PATH.read_text("utf-8")))
    assert len(index.circuits) >= 1
    for entry in index.circuits:
        path = DATA_DIR / entry.file
        assert path.exists(), f"fichier circuit manquant : {entry.file}"
        circuit = CircuitData.model_validate(json.loads(path.read_text("utf-8")))
        assert circuit.line_id == entry.line_id
        assert len(circuit.trips) == entry.n_trips
        # 711 ne doit plus exister ; 124/480 bidirectionnels
        assert circuit.line_id != "711"


@pytestmark_generated
def test_generated_no_711_present() -> None:
    index = CircuitIndex.model_validate(json.loads(INDEX_PATH.read_text("utf-8")))
    line_ids = {c.line_id for c in index.circuits}
    assert "711" not in line_ids

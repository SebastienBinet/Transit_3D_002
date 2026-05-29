"""
Tests L2 : validation du scénario STM produit par build_scenario_stm.py.
Skip si le fichier n'a pas encore été généré (CI ou exécution manuelle requise).
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from sim.models import SimulationOutput

SCENARIO_PATH = Path(__file__).parent.parent.parent / "web" / "data" / "scenario_stm_1.json"

pytestmark = pytest.mark.skipif(
    not SCENARIO_PATH.exists(),
    reason=f"{SCENARIO_PATH.name} non généré (lancer build_scenario_stm.py)",
)


@pytest.fixture(scope="module")
def sim_output() -> SimulationOutput:
    data = json.loads(SCENARIO_PATH.read_text(encoding="utf-8"))
    return SimulationOutput.model_validate(data)


def test_stm_scenario_has_routes(sim_output: SimulationOutput) -> None:
    assert len(sim_output.routes) >= 1
    line_ids = {r.line_id for r in sim_output.routes}
    # Au moins une des lignes cibles doit être présente
    expected = {"51", "11", "165", "711", "129", "155", "66", "144"}
    assert line_ids & expected


def test_stm_scenario_has_frames(sim_output: SimulationOutput) -> None:
    assert len(sim_output.frames) > 10
    # sim_time croissant
    for i in range(1, len(sim_output.frames)):
        assert sim_output.frames[i].sim_time > sim_output.frames[i - 1].sim_time


def test_stm_scenario_first_frame_at_zero(sim_output: SimulationOutput) -> None:
    assert sim_output.frames[0].sim_time == 0.0


def test_stm_scenario_vehicles_per_frame_consistent(sim_output: SimulationOutput) -> None:
    n = len(sim_output.frames[0].vehicles)
    assert n >= 1
    for f in sim_output.frames:
        assert len(f.vehicles) == n


def test_stm_scenario_trajectory_invariants(sim_output: SimulationOutput) -> None:
    """Au moins une frame milieu et fin : invariants p10≤p50≤p90 et progression."""
    samples = [sim_output.frames[0],
               sim_output.frames[len(sim_output.frames) // 2],
               sim_output.frames[-1]]
    for frame in samples:
        for veh in frame.vehicles:
            traj = veh.trajectory
            assert len(traj) >= 2
            # Pydantic valide déjà l'ordre interne ; on vérifie en plus la non-décroissance
            for i in range(1, len(traj)):
                assert traj[i].p50 >= traj[i - 1].p50
            # p10 = p50 = p90 au premier point
            assert traj[0].p10 == traj[0].p50 == traj[0].p90


def test_stm_scenario_transfer_windows_valid(sim_output: SimulationOutput) -> None:
    for tw in sim_output.transfer_windows:
        assert tw.t_open < tw.t_close
        assert tw.t_open >= 0.0
        assert tw.connector_vehicle_id


def test_stm_scenario_vehicle_line_ids_match_routes(sim_output: SimulationOutput) -> None:
    """Tous les line_id des véhicules doivent référencer une route fournie."""
    route_lines = {r.line_id for r in sim_output.routes}
    for frame in sim_output.frames[:5]:
        for v in frame.vehicles:
            assert v.line_id in route_lines

import pytest
from pydantic import ValidationError
from sim.models import Frame, SimulationOutput


def frame_valide() -> dict:
    return {
        "sim_time": 0.0,
        "vehicles": [
            {
                "vehicle_id": "L42-1",
                "line_id": "L42",
                "trajectory": [
                    {"t": 0.0, "p10": 0.0, "p50": 0.0, "p90": 0.0},
                    {"t": 300.0, "p10": 200.0, "p50": 250.0, "p90": 300.0},
                ],
            }
        ],
        "transfers": [],
    }


def test_frame_valide_parse():
    frame = Frame.model_validate(frame_valide())
    assert frame.sim_time == 0.0
    assert len(frame.vehicles) == 1


def test_frame_aller_retour_json():
    frame = Frame.model_validate(frame_valide())
    rechargee = Frame.model_validate_json(frame.model_dump_json())
    assert rechargee.sim_time == frame.sim_time
    assert rechargee.vehicles[0].vehicle_id == frame.vehicles[0].vehicle_id


def test_frame_rejette_trajectoire_invalide():
    data = frame_valide()
    data["vehicles"][0]["trajectory"][1]["p10"] = 9999.0
    with pytest.raises(ValidationError):
        Frame.model_validate(data)


def test_simulation_output_valide():
    output = {
        "routes": [
            {
                "line_id": "L42",
                "stops": [
                    {"stop_id": "O", "name": "Origine", "position": {"lat": 45.5, "lon": -73.6}},
                    {"stop_id": "P3", "name": "Point 3", "position": {"lat": 45.52, "lon": -73.58}},
                ],
                "shape": [
                    {"lat": 45.5, "lon": -73.6},
                    {"lat": 45.52, "lon": -73.58},
                ],
            }
        ],
        "frames": [frame_valide()],
    }
    result = SimulationOutput.model_validate(output)
    assert len(result.frames) == 1
    assert result.routes[0].line_id == "L42"

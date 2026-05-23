import pytest
from sim.simulator import simulate
from sim.scenario import V_NOM


@pytest.mark.parametrize("scenario_id", [1, 2])
def test_output_schema_valide(scenario_id):
    out = simulate(scenario_id)
    assert len(out.routes) == 3
    assert len(out.frames) > 0


@pytest.mark.parametrize("scenario_id", [1, 2])
def test_invariants_trajectoire(scenario_id):
    out = simulate(scenario_id)
    for frame in out.frames[::20]:
        for v in frame.vehicles:
            pts = v.trajectory
            for i in range(1, len(pts)):
                assert pts[i].t > pts[i - 1].t
                assert pts[i].p10 >= pts[i - 1].p10
                assert pts[i].p50 >= pts[i - 1].p50
                assert pts[i].p90 >= pts[i - 1].p90
                assert pts[i].p10 <= pts[i].p50 <= pts[i].p90


def test_scenario1_probabilite_L33_initiale_elevee():
    out = simulate(1)
    t0 = out.frames[0]
    prob = next(t.probability for t in t0.transfers if t.to_vehicle_id == "L33-util")
    assert prob >= 0.90, f"prob initiale L33 cas 1 = {prob}"


def test_scenario2_memes_predictions_initiales():
    out1 = simulate(1)
    out2 = simulate(2)
    prob1 = next(t.probability for t in out1.frames[0].transfers if t.to_vehicle_id == "L33-util")
    prob2 = next(t.probability for t in out2.frames[0].transfers if t.to_vehicle_id == "L33-util")
    assert prob1 == prob2, "prédictions initiales doivent être identiques"


def test_scenario2_probabilite_L33_chute():
    out = simulate(2)
    frame_300 = out.frames[60]  # T = 300 s (60 × 5 s)
    prob = next(t.probability for t in frame_300.transfers if t.to_vehicle_id == "L33-util")
    assert prob < 0.20, f"prob L33 à T=300 s devrait être faible, reçu {prob}"


def test_scenario1_probabilite_L33_reste_elevee():
    out = simulate(1)
    frame_300 = out.frames[60]
    prob = next(t.probability for t in frame_300.transfers if t.to_vehicle_id == "L33-util")
    assert prob >= 0.80, f"prob L33 à T=300 s cas 1 devrait rester élevée, reçu {prob}"

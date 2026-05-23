import pytest
from pydantic import ValidationError
from sim.models import PercentilePoint, VehicleState, TransferProbability


def pt(t, p):
    return PercentilePoint(t=t, p10=p, p50=p, p90=p)


def test_percentile_point_valide():
    p = PercentilePoint(t=0.0, p10=0.0, p50=10.0, p90=20.0)
    assert p.p10 <= p.p50 <= p.p90


def test_percentile_point_ordre_invalide():
    with pytest.raises(ValidationError):
        PercentilePoint(t=0.0, p10=20.0, p50=10.0, p90=30.0)


def test_vehicle_state_valide():
    v = VehicleState(
        vehicle_id="L42-1",
        line_id="L42",
        trajectory=[
            pt(0.0, 100.0),
            PercentilePoint(t=60.0, p10=110.0, p50=120.0, p90=130.0),
        ],
    )
    assert len(v.trajectory) == 2


def test_vehicle_t0_percentiles_doivent_etre_egaux():
    with pytest.raises(ValidationError):
        VehicleState(
            vehicle_id="v1",
            line_id="L42",
            trajectory=[PercentilePoint(t=0.0, p10=0.0, p50=10.0, p90=20.0)],
        )


def test_vehicle_temps_strictement_croissant():
    with pytest.raises(ValidationError):
        VehicleState(
            vehicle_id="v1",
            line_id="L42",
            trajectory=[pt(0.0, 0.0), pt(0.0, 10.0)],
        )


def test_vehicle_progress_non_decroissant():
    with pytest.raises(ValidationError):
        VehicleState(
            vehicle_id="v1",
            line_id="L42",
            trajectory=[
                pt(0.0, 100.0),
                PercentilePoint(t=60.0, p10=90.0, p50=80.0, p90=70.0),
            ],
        )


def test_transfer_probability_valide():
    t = TransferProbability(
        from_vehicle_id="L42-1",
        to_vehicle_id="L33-1",
        stop_id="P3",
        probability=0.95,
    )
    assert t.probability == 0.95


def test_transfer_probability_hors_intervalle():
    with pytest.raises(ValidationError):
        TransferProbability(
            from_vehicle_id="v1", to_vehicle_id="v2", stop_id="P1", probability=1.5
        )

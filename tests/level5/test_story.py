from sim.models import Frame, VehicleState, PercentilePoint, TransferProbability


def pt(t, p):
    return PercentilePoint(t=t, p10=p, p50=p, p90=p)


def test_scenario_cas1_probabilite_initiale_elevee():
    """Au départ, 95 % de chance d'attraper L33 depuis L42."""
    frame = Frame(
        sim_time=0.0,
        vehicles=[
            VehicleState(
                vehicle_id="L42-1",
                line_id="L42",
                trajectory=[pt(0.0, 0.0), PercentilePoint(t=300.0, p10=200.0, p50=250.0, p90=300.0)],
            ),
            VehicleState(
                vehicle_id="L33-1",
                line_id="L33",
                trajectory=[pt(0.0, 500.0), PercentilePoint(t=300.0, p10=600.0, p50=650.0, p90=700.0)],
            ),
        ],
        transfers=[
            TransferProbability(
                from_vehicle_id="L42-1",
                to_vehicle_id="L33-1",
                stop_id="P3",
                probability=0.95,
            )
        ],
    )
    transfert = frame.transfers[0]
    assert transfert.probability == 0.95
    assert transfert.stop_id == "P3"


def test_scenario_cas2_probabilite_chute():
    """Quand L42 est lent, la probabilité d'attraper L33 chute sous le seuil de risque."""
    frame_tard = Frame(
        sim_time=600.0,
        vehicles=[
            VehicleState(
                vehicle_id="L42-1",
                line_id="L42",
                trajectory=[pt(600.0, 80.0), PercentilePoint(t=900.0, p10=100.0, p50=120.0, p90=140.0)],
            ),
            VehicleState(
                vehicle_id="L33-1",
                line_id="L33",
                trajectory=[pt(600.0, 500.0), PercentilePoint(t=900.0, p10=620.0, p50=650.0, p90=680.0)],
            ),
        ],
        transfers=[
            TransferProbability(
                from_vehicle_id="L42-1",
                to_vehicle_id="L33-1",
                stop_id="P3",
                probability=0.15,
            )
        ],
    )
    transfert = frame_tard.transfers[0]
    assert transfert.probability < 0.5, "L42 lent → probabilité d'attraper L33 doit être faible"

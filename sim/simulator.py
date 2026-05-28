from __future__ import annotations
import math

from sim.models import (
    Frame, VehicleState, PercentilePoint, TransferProbability,
    PassengerState, PassengerCheckpoint, TransferWindow,
    RouteGeometry, Stop, LatLon, SimulationOutput,
)
from sim.scenario import (
    BusSpec, STOP_COORDS, LINE_STOPS, V_NOM, SIGMA_SPEED, T_PRIOR,
    L33_P3_TIME, L17_P1_TIME, L17_P1_DWELL, L33_P3_DWELL,
    build_scenario, route_length, route_stop_progress,
)

FRAME_INTERVAL = 1.0   # secondes entre frames (1 s → 20 Hz à ×20, sans saut visible)
HORIZON = 1800.0       # 30 min
TRAJ_STEP = 60.0       # résolution de la trajectoire prédite (1 min)


def _normal_cdf(z: float) -> float:
    return 0.5 * math.erfc(-z / math.sqrt(2))


def _posterior(p_t: float, T: float, dep_time: float, r_len: float) -> tuple[float, float]:
    elapsed = T - dep_time
    if elapsed <= 0 or p_t >= r_len:
        return V_NOM, SIGMA_SPEED
    v_obs = p_t / elapsed
    weight = elapsed / (elapsed + T_PRIOR)
    v_post = V_NOM * (1 - weight) + v_obs * weight
    sigma_post = SIGMA_SPEED * math.sqrt(T_PRIOR / (elapsed + T_PRIOR))
    return v_post, sigma_post


def _bus_progress(bus: BusSpec, T: float) -> float:
    if T < bus.departure_time:
        return 0.0
    return min(bus.speed_mps * (T - bus.departure_time), route_length(bus.line_id))


def _vehicle_state(bus: BusSpec, T: float) -> VehicleState:
    r_len = route_length(bus.line_id)
    p_t = _bus_progress(bus, T)
    v_post, sigma_post = _posterior(p_t, T, bus.departure_time, r_len)
    v_low = max(0.0, v_post - 1.28 * sigma_post)
    v_high = v_post + 1.28 * sigma_post

    points: list[PercentilePoint] = [PercentilePoint(t=T, p10=p_t, p50=p_t, p90=p_t)]
    prev = (p_t, p_t, p_t)

    t_fut = T + TRAJ_STEP
    while t_fut <= T + HORIZON:
        if t_fut <= bus.departure_time:
            p10, p50, p90 = 0.0, 0.0, 0.0
        elif T >= bus.departure_time:
            # bus déjà en route : prédiction depuis la position actuelle
            tau = t_fut - T
            p50 = min(p_t + v_post * tau, r_len)
            p10 = min(p_t + v_low  * tau, r_len)
            p90 = min(p_t + v_high * tau, r_len)
        else:
            # bus part dans le futur : prédiction depuis l'arrêt de départ
            mt = t_fut - bus.departure_time
            p50 = min(v_post * mt, r_len)
            p10 = min(v_low  * mt, r_len)
            p90 = min(v_high * mt, r_len)

        # invariants non-décroissant + p10 ≤ p50 ≤ p90
        p10 = max(p10, prev[0])
        p50 = max(p50, prev[1])
        p90 = max(p90, prev[2])
        p10 = min(p10, p50)
        p90 = max(p90, p50)

        points.append(PercentilePoint(t=t_fut, p10=p10, p50=p50, p90=p90))
        prev = (p10, p50, p90)
        t_fut += TRAJ_STEP

    return VehicleState(vehicle_id=bus.vehicle_id, line_id=bus.line_id, trajectory=points)


def _transfer_prob_L33(p_t: float, T: float, dep_time: float) -> float:
    p3 = route_stop_progress("L42")[3]
    r_len = route_length("L42")
    remaining_dist = max(0.0, p3 - p_t)
    remaining_time = L33_P3_TIME - T
    if remaining_time <= 0:
        return 0.0 if remaining_dist > 0 else 1.0
    if remaining_dist <= 0:
        return 1.0
    v_post, sigma_post = _posterior(p_t, T, dep_time, r_len)
    speed_needed = remaining_dist / remaining_time
    z = (speed_needed - v_post) / max(sigma_post, 1e-9)
    return round(1.0 - _normal_cdf(z), 6)


def _transfer_prob_L17(p_t: float, T: float, dep_time: float) -> float:
    p1 = route_stop_progress("L42")[1]
    r_len = route_length("L42")
    remaining_dist = max(0.0, p1 - p_t)
    deadline = L17_P1_TIME + L17_P1_DWELL
    remaining_time = deadline - T
    if remaining_time <= 0:
        return 0.0 if remaining_dist > 0 else 1.0
    if remaining_dist <= 0:
        return 1.0
    v_post, sigma_post = _posterior(p_t, T, dep_time, r_len)
    speed_needed = remaining_dist / remaining_time
    z = (speed_needed - v_post) / max(sigma_post, 1e-9)
    return round(1.0 - _normal_cdf(z), 6)


def _passenger_config(scenario_id: int, buses: list[BusSpec]) -> dict:
    """Calcule les constantes du parcours passager pour un scénario."""
    L42_util = next(b for b in buses if b.vehicle_id == "L42-util")
    if scenario_id == 1:
        connector_id = "L33-util"
        stop_idx_L42 = 3           # P3 est le 4e arrêt de L42
        stop_idx_connector = 2     # P3 est le 3e arrêt de L33
        T_board = L33_P3_TIME
    else:
        connector_id = "L17-util"
        stop_idx_L42 = 1           # P1 est le 2e arrêt de L42
        stop_idx_connector = 2     # P1 est le 3e arrêt de L17
        T_board = L17_P1_TIME

    connector = next(b for b in buses if b.vehicle_id == connector_id)
    connector_line = connector.line_id
    p_stop_L42 = route_stop_progress("L42")[stop_idx_L42]
    p_stop_connector = route_stop_progress(connector_line)[stop_idx_connector]
    T_arrive = L42_util.departure_time + p_stop_L42 / L42_util.speed_mps

    return dict(
        L42_util=L42_util,
        connector=connector,
        connector_id=connector_id,
        connector_line=connector_line,
        p_stop_L42=p_stop_L42,
        p_stop_connector=p_stop_connector,
        T_arrive=T_arrive,
        T_board=T_board,
    )


def _passenger_state(cfg: dict, T: float) -> PassengerState:
    if T < cfg["T_arrive"]:
        return PassengerState(
            state="onboard",
            vehicle_id="L42-util",
            progress_m=_bus_progress(cfg["L42_util"], T),
        )
    if T < cfg["T_board"]:
        return PassengerState(
            state="waiting",
            vehicle_id=cfg["connector_id"],
            progress_m=cfg["p_stop_connector"],
        )
    return PassengerState(
        state="transferred",
        vehicle_id=cfg["connector_id"],
        progress_m=_bus_progress(cfg["connector"], T),
    )


def _passenger_trajectory(cfg: dict) -> list[PassengerCheckpoint]:
    """Retourne les jalons clés du parcours espace-temps du passager."""
    connector_len = route_length(cfg["connector_line"])
    T_arrive_dest = cfg["T_board"] + (connector_len - cfg["p_stop_connector"]) / cfg["connector"].speed_mps

    result = [
        PassengerCheckpoint(t=0.0, vehicle_id="L42-util", progress_m=0.0),
        PassengerCheckpoint(t=cfg["T_arrive"], vehicle_id="L42-util", progress_m=cfg["p_stop_L42"]),
        PassengerCheckpoint(t=cfg["T_arrive"], vehicle_id=cfg["connector_id"], progress_m=cfg["p_stop_connector"]),
        PassengerCheckpoint(t=cfg["T_board"],  vehicle_id=cfg["connector_id"], progress_m=cfg["p_stop_connector"]),
    ]
    if T_arrive_dest < HORIZON:
        result.append(PassengerCheckpoint(t=T_arrive_dest, vehicle_id=cfg["connector_id"], progress_m=connector_len))
    result.append(PassengerCheckpoint(t=HORIZON, vehicle_id=cfg["connector_id"], progress_m=connector_len))
    return result


def _build_routes() -> list[RouteGeometry]:
    routes = []
    for line_id, stop_ids in LINE_STOPS.items():
        progs = route_stop_progress(line_id)
        stops = [
            Stop(
                stop_id=sid,
                name=sid,
                position=LatLon(lat=STOP_COORDS[sid][0], lon=STOP_COORDS[sid][1]),
                progress_m=progs[i],
            )
            for i, sid in enumerate(stop_ids)
        ]
        shape = [LatLon(lat=STOP_COORDS[sid][0], lon=STOP_COORDS[sid][1]) for sid in stop_ids]
        routes.append(RouteGeometry(
            line_id=line_id, stops=stops, shape=shape, length_m=route_length(line_id),
        ))
    return routes


def _transfer_windows(buses: list[BusSpec]) -> list[TransferWindow]:
    L17 = next(b for b in buses if b.vehicle_id == "L17-util")
    L33 = next(b for b in buses if b.vehicle_id == "L33-util")
    p1_on_L17 = route_stop_progress("L17")[2]
    p3_on_L33 = route_stop_progress("L33")[2]
    t_L17 = L17.departure_time + p1_on_L17 / L17.speed_mps
    t_L33 = L33.departure_time + p3_on_L33 / L33.speed_mps
    return [
        TransferWindow(stop_id="P1", connector_vehicle_id="L17-util",
                       t_open=t_L17, t_close=t_L17 + L17_P1_DWELL),
        TransferWindow(stop_id="P3", connector_vehicle_id="L33-util",
                       t_open=t_L33, t_close=t_L33 + L33_P3_DWELL),
    ]


def simulate(scenario_id: int) -> SimulationOutput:
    """
    scenario_id=1 : L42 roule à vitesse nominale (plan nominal).
    scenario_id=2 : L42-util roule à 60 % de la vitesse nominale (repli à P1).
    """
    L42_speed = V_NOM if scenario_id == 1 else V_NOM * 0.6
    buses = build_scenario(L42_speed)
    L42_util = next(b for b in buses if b.vehicle_id == "L42-util")
    cfg = _passenger_config(scenario_id, buses)

    frames: list[Frame] = []
    T = 0.0
    while T <= HORIZON:
        vehicles = [_vehicle_state(b, T) for b in buses]
        p_L42 = _bus_progress(L42_util, T)
        transfers = [
            TransferProbability(
                from_vehicle_id="L42-util",
                to_vehicle_id="L33-util",
                stop_id="P3",
                probability=_transfer_prob_L33(p_L42, T, L42_util.departure_time),
            ),
            TransferProbability(
                from_vehicle_id="L42-util",
                to_vehicle_id="L17-util",
                stop_id="P1",
                probability=_transfer_prob_L17(p_L42, T, L42_util.departure_time),
            ),
        ]
        frames.append(Frame(
            sim_time=T,
            vehicles=vehicles,
            transfers=transfers,
            passenger=_passenger_state(cfg, T),
        ))
        T = round(T + FRAME_INTERVAL, 6)

    return SimulationOutput(
        routes=_build_routes(),
        frames=frames,
        passenger_trajectory=_passenger_trajectory(cfg),
        transfer_windows=_transfer_windows(buses),
    )

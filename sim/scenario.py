from __future__ import annotations
import math
from dataclasses import dataclass

LAT_REF = 45.50
M_PER_DEG_LAT = 111_000.0
M_PER_DEG_LON = 111_000.0 * math.cos(math.radians(LAT_REF))

STOP_COORDS: dict[str, tuple[float, float]] = {
    "O":  (45.510, -73.650),
    "P1": (45.510, -73.640),
    "P2": (45.510, -73.630),
    "P3": (45.510, -73.620),
    "P4": (45.510, -73.610),
    "H1": (45.530, -73.640),
    "H2": (45.522, -73.640),
    "H3": (45.498, -73.640),
    "H4": (45.490, -73.640),
    "G1": (45.530, -73.620),
    "G2": (45.522, -73.620),
    "G3": (45.498, -73.620),
    "G4": (45.490, -73.620),
}

LINE_STOPS: dict[str, list[str]] = {
    "L42": ["O", "P1", "P2", "P3", "P4"],
    "L17": ["H1", "H2", "P1", "H3", "H4", "G4"],
    "L33": ["G1", "G2", "P3", "G3", "G4"],
}


def stop_distance_m(s1: str, s2: str) -> float:
    lat1, lon1 = STOP_COORDS[s1]
    lat2, lon2 = STOP_COORDS[s2]
    dy = (lat2 - lat1) * M_PER_DEG_LAT
    dx = (lon2 - lon1) * M_PER_DEG_LON
    return math.sqrt(dy**2 + dx**2)


def route_stop_progress(line_id: str) -> list[float]:
    stops = LINE_STOPS[line_id]
    dists = [0.0]
    for i in range(1, len(stops)):
        dists.append(dists[-1] + stop_distance_m(stops[i - 1], stops[i]))
    return dists


def route_length(line_id: str) -> float:
    return route_stop_progress(line_id)[-1]


@dataclass
class BusSpec:
    vehicle_id: str
    line_id: str
    departure_time: float
    speed_mps: float


V_NOM = 5.0          # m/s vitesse nominale
SIGMA_SPEED = 0.5    # m/s écart-type de vitesse
T_PRIOR = 300.0      # s "poids" du prior bayésien

FREQ_L42_L17 = 900.0   # 15 min
FREQ_L33 = 1200.0       # 20 min

# L33-util passe P3 à T=560 s → P(attraper) ≈ 95 % au départ
L33_P3_TIME = 560.0
L17_P1_TIME = 450.0
L17_P1_DWELL = 60.0    # durée d'arrêt à P1


def build_scenario(L42_utile_speed: float) -> list[BusSpec]:
    L33_P3_dist = route_stop_progress("L33")[2]
    L33_util_dep = L33_P3_TIME - L33_P3_dist / V_NOM

    L17_P1_dist = route_stop_progress("L17")[2]
    L17_util_dep = L17_P1_TIME - L17_P1_dist / V_NOM

    return [
        BusSpec("L42-prev", "L42", -FREQ_L42_L17,           V_NOM),
        BusSpec("L42-util", "L42",  0.0,                    L42_utile_speed),
        BusSpec("L42-next", "L42", +FREQ_L42_L17,           V_NOM),
        BusSpec("L17-prev", "L17", L17_util_dep - FREQ_L42_L17, V_NOM),
        BusSpec("L17-util", "L17", L17_util_dep,             V_NOM),
        BusSpec("L17-next", "L17", L17_util_dep + FREQ_L42_L17, V_NOM),
        BusSpec("L33-prev", "L33", L33_util_dep - FREQ_L33,  V_NOM),
        BusSpec("L33-util", "L33", L33_util_dep,             V_NOM),
        BusSpec("L33-next", "L33", L33_util_dep + FREQ_L33,  V_NOM),
    ]

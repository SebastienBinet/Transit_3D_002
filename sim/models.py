from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, model_validator


class PercentilePoint(BaseModel):
    t: float
    p10: float
    p50: float
    p90: float

    @model_validator(mode='after')
    def check_percentile_order(self) -> PercentilePoint:
        if not (self.p10 <= self.p50 <= self.p90):
            raise ValueError(f"p10 ≤ p50 ≤ p90 requis, reçu {self.p10} {self.p50} {self.p90}")
        return self


class VehicleState(BaseModel):
    vehicle_id: str
    line_id: str
    trajectory: list[PercentilePoint]

    @model_validator(mode='after')
    def check_trajectory_invariants(self) -> VehicleState:
        pts = self.trajectory
        if not pts:
            raise ValueError("trajectory vide")
        first = pts[0]
        if not (first.p10 == first.p50 == first.p90):
            raise ValueError("percentiles doivent être égaux à t=0")
        for i in range(1, len(pts)):
            if pts[i].t <= pts[i - 1].t:
                raise ValueError("temps doit être strictement croissant")
            if pts[i].p10 < pts[i - 1].p10:
                raise ValueError("progress p10 doit être non-décroissant")
            if pts[i].p50 < pts[i - 1].p50:
                raise ValueError("progress p50 doit être non-décroissant")
            if pts[i].p90 < pts[i - 1].p90:
                raise ValueError("progress p90 doit être non-décroissant")
        return self


class TransferProbability(BaseModel):
    from_vehicle_id: str
    to_vehicle_id: str
    stop_id: str
    probability: float

    @model_validator(mode='after')
    def check_probability_range(self) -> TransferProbability:
        if not (0.0 <= self.probability <= 1.0):
            raise ValueError(f"probability doit être dans [0, 1], reçu {self.probability}")
        return self


class PassengerState(BaseModel):
    state: Literal["onboard", "waiting", "transferred"]
    vehicle_id: str   # L42-util, L33-util ou L17-util
    progress_m: float  # position le long du tracé du véhicule référencé


class PassengerCheckpoint(BaseModel):
    t: float
    vehicle_id: str
    progress_m: float


class Frame(BaseModel):
    sim_time: float
    vehicles: list[VehicleState]
    transfers: list[TransferProbability] = []
    passenger: PassengerState | None = None


class LatLon(BaseModel):
    lat: float
    lon: float


class Stop(BaseModel):
    stop_id: str
    name: str
    position: LatLon
    progress_m: float = 0.0  # distance depuis le premier arrêt de la ligne


class RouteGeometry(BaseModel):
    line_id: str
    stops: list[Stop]
    shape: list[LatLon]
    length_m: float = 0.0  # longueur totale du tracé


class TransferWindow(BaseModel):
    stop_id: str
    connector_vehicle_id: str
    t_open: float   # heure d'arrivée du connecteur à l'arrêt
    t_close: float  # heure de départ du connecteur


class SimulationOutput(BaseModel):
    routes: list[RouteGeometry]
    frames: list[Frame]
    passenger_trajectory: list[PassengerCheckpoint] = []
    transfer_windows: list[TransferWindow] = []

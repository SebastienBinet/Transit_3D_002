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
    length_m: float = 0.0
    gtfs_direction_id: str | None = None  # "0" ou "1" pour les lignes bidirectionnelles


class TransferWindow(BaseModel):
    stop_id: str
    connector_vehicle_id: str
    t_open: float   # heure d'arrivée du connecteur à l'arrêt
    t_close: float  # heure de départ du connecteur


class StopEvent(BaseModel):
    vehicle_id: str
    line_id: str
    stop_id: str
    progress_m: float
    t_arr: float   # secondes depuis T0 (même référence que trajectory.t)
    t_dep: float   # secondes depuis T0


class SimulationOutput(BaseModel):
    routes: list[RouteGeometry]
    frames: list[Frame]
    passenger_trajectory: list[PassengerCheckpoint] = []
    transfer_windows: list[TransferWindow] = []
    stop_events: list[StopEvent] = []


# ─────────────────────────────────────────────────────────────────────────────
# Schéma horaire compact (scalable) — un fichier par circuit-direction.
#
# Au lieu de pré-calculer des frames redondantes (chaque frame ré-émet la
# trajectoire prédite complète de chaque véhicule → O(frames)), on stocke chaque
# passage UNE fois sous forme d'horaire (t, progress_m) + un modèle d'incertitude
# global. Le visualizer reconstruit le cône p10/p50/p90 pour le « maintenant »
# courant par rejeu déterministe de l'horaire et du modèle σ (pas de nouvelle
# prédiction). Voir DECISIONS.md §5 pour la réconciliation avec l'invariant.
# ─────────────────────────────────────────────────────────────────────────────

class StopVisit(BaseModel):
    """Passage planifié à un arrêt, en secondes depuis minuit (référence de service)."""
    t_arr: float
    t_dep: float
    progress_m: float

    @model_validator(mode='after')
    def check_order(self) -> StopVisit:
        if self.t_dep < self.t_arr:
            raise ValueError(f"t_dep ({self.t_dep}) < t_arr ({self.t_arr})")
        return self


class TripSchedule(BaseModel):
    """Un passage (un trip GTFS) : la suite de ses arrêts planifiés."""
    trip_id: str
    schedule: list[StopVisit]

    @model_validator(mode='after')
    def check_schedule(self) -> TripSchedule:
        s = self.schedule
        if len(s) < 2:
            raise ValueError("schedule doit avoir ≥ 2 arrêts")
        for i in range(1, len(s)):
            if s[i].t_arr < s[i - 1].t_arr:
                raise ValueError("t_arr doit être non-décroissant le long du trip")
            if s[i].progress_m < s[i - 1].progress_m:
                raise ValueError("progress_m doit être non-décroissant le long du trip")
        return self


class SigmaModel(BaseModel):
    """Modèle d'incertitude d'adhérence : σ(Δt) en secondes.
    'power' : σ(Δt) = coeff_min · (Δt_min)^exp minutes."""
    kind: Literal["power"] = "power"
    coeff_min: float  # σ(1 min) en minutes
    exp: float


class CircuitData(BaseModel):
    """Contenu d'un fichier circuit : géométrie + tous les passages de la fenêtre."""
    line_id: str
    gtfs_direction_id: str | None = None
    route: RouteGeometry
    trips: list[TripSchedule]


class CircuitIndexEntry(BaseModel):
    line_id: str
    gtfs_direction_id: str | None = None
    color: str | None = None
    file: str        # chemin relatif à web/data/ (ex. "circuits/124N.json")
    n_trips: int


class CircuitIndex(BaseModel):
    """Index des circuits + paramètres de fenêtre et modèle σ partagés."""
    t0_seconds: float        # début de la fenêtre de simulation (sec depuis minuit)
    horizon_s: float         # durée affichée
    frame_interval: float    # cadence de rafraîchissement du cône (sec de sim)
    traj_step: float         # résolution interne du cône (sec)
    sigma: SigmaModel
    circuits: list[CircuitIndexEntry]

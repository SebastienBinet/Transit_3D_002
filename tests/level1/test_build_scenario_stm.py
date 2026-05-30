"""
Tests unitaires de data/blocks/build_scenario_stm.py.
Vérifie le modèle σ, l'interpolation horaire→progress, et les invariants de trajectoire.
"""
from __future__ import annotations
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from data.blocks.build_scenario_stm import (
    sigma_time_s,
    build_schedule_progress,
    build_vehicle_trajectory,
    parse_hms,
    HORIZON_S,
    TRAJ_STEP_S,
    T0_SECONDS,
    N_TRAJ_STEPS,
)


# ── σ(Δt) ──────────────────────────────────────────────────────────────────

def test_sigma_zero_at_t0():
    assert sigma_time_s(0) == 0.0


def test_sigma_negative_is_zero():
    assert sigma_time_s(-10) == 0.0


def test_sigma_at_1_min_is_3_min():
    assert abs(sigma_time_s(60) - 180) < 15


def test_sigma_at_60_min_is_10_min():
    assert abs(sigma_time_s(3600) - 600) < 60


# ── parse_hms ──────────────────────────────────────────────────────────────

def test_parse_hms_basic():
    assert parse_hms("07:00:00") == 25200
    assert parse_hms("07:30:00") == 27000
    # GTFS permet les heures > 24 (service de nuit)
    assert parse_hms("25:15:00") == 25 * 3600 + 15 * 60


# ── build_schedule_progress ────────────────────────────────────────────────

def test_sched_before_first_returns_zero():
    visits = [(1000.0, 1030.0, 0.0), (1300.0, 1330.0, 500.0)]
    sched = build_schedule_progress(visits, length_m=1000.0)
    assert sched(500.0) == 0.0
    assert sched(1000.0) == 0.0


def test_sched_after_last_returns_length():
    visits = [(1000.0, 1030.0, 0.0), (1300.0, 1330.0, 500.0)]
    sched = build_schedule_progress(visits, length_m=1000.0)
    assert sched(2000.0) == 1000.0


def test_sched_linear_between_stops():
    visits = [(0.0, 0.0, 0.0), (100.0, 100.0, 1000.0)]
    sched = build_schedule_progress(visits, length_m=1000.0)
    assert abs(sched(50.0) - 500.0) < 1.0


def test_sched_constant_during_dwell():
    """Pendant l'arrêt (dwell), progress reste constant."""
    visits = [(0.0, 0.0, 0.0), (100.0, 130.0, 500.0), (200.0, 200.0, 1000.0)]
    sched = build_schedule_progress(visits, length_m=1000.0)
    assert abs(sched(100.0) - 500.0) < 1.0
    assert abs(sched(115.0) - 500.0) < 1.0
    assert abs(sched(130.0) - 500.0) < 1.0


# ── build_vehicle_trajectory ───────────────────────────────────────────────

def _simple_sched():
    """Trip linéaire : démarre à T0, finit à T0 + 1800, longueur 9000 m."""
    visits = [
        (T0_SECONDS, T0_SECONDS, 0.0),
        (T0_SECONDS + 1800.0, T0_SECONDS + 1800.0, 9000.0),
    ]
    return build_schedule_progress(visits, length_m=9000.0), 9000.0


def test_trajectory_length_is_31_points():
    sched, L = _simple_sched()
    traj = build_vehicle_trajectory(sched, L, T_sim_offset=0.0)
    assert len(traj) == N_TRAJ_STEPS


def test_trajectory_t_strictly_increasing():
    sched, L = _simple_sched()
    traj = build_vehicle_trajectory(sched, L, T_sim_offset=300.0)
    for i in range(1, len(traj)):
        assert traj[i]["t"] > traj[i-1]["t"]


def test_trajectory_p10_p50_p90_ordered():
    sched, L = _simple_sched()
    traj = build_vehicle_trajectory(sched, L, T_sim_offset=300.0)
    for pt in traj:
        assert pt["p10"] <= pt["p50"] <= pt["p90"]


def test_trajectory_progress_non_decreasing():
    sched, L = _simple_sched()
    traj = build_vehicle_trajectory(sched, L, T_sim_offset=300.0)
    for i in range(1, len(traj)):
        assert traj[i]["p10"] >= traj[i-1]["p10"]
        assert traj[i]["p50"] >= traj[i-1]["p50"]
        assert traj[i]["p90"] >= traj[i-1]["p90"]


def test_trajectory_percentiles_equal_at_t0():
    sched, L = _simple_sched()
    traj = build_vehicle_trajectory(sched, L, T_sim_offset=600.0)
    p = traj[0]
    assert p["p10"] == p["p50"] == p["p90"]


def test_trajectory_progress_within_route_length():
    sched, L = _simple_sched()
    traj = build_vehicle_trajectory(sched, L, T_sim_offset=0.0)
    for pt in traj:
        assert 0.0 <= pt["p10"] <= L
        assert 0.0 <= pt["p50"] <= L
        assert 0.0 <= pt["p90"] <= L


def test_trajectory_uncertainty_widens_with_horizon():
    """L'écart p90 − p10 doit croître avec l'horizon (en l'absence de plafonnement)."""
    # Trip lent : 60 m/s = 60 m par σ minute, on reste loin de la fin → pas de plafonnement
    visits = [(T0_SECONDS - 1000, T0_SECONDS - 1000, 0.0),
              (T0_SECONDS + 5000, T0_SECONDS + 5000, 360_000.0)]  # 60 m/s
    sched = build_schedule_progress(visits, length_m=360_000.0)
    traj = build_vehicle_trajectory(sched, 360_000.0, T_sim_offset=200.0)
    widths = [pt["p90"] - pt["p10"] for pt in traj]
    assert widths[0] == 0.0
    # La largeur doit globalement croître (pas strictement à chaque pas, mais sur l'horizon)
    assert widths[-1] > widths[1]
    assert widths[5] >= widths[1]

"""
Tests unitaires du modèle d'adhérence aux horaires.
σ(Δt_s) doit satisfaire :
  - σ(0) = 0  (invariant de trajectoire)
  - σ(60) ≈ 180 s  (±3 min à 1 min d'horizon)
  - σ(600) ≈ 360 s  (±6 min à 10 min)
  - σ(3600) ≈ 600 s  (±10 min à 60 min)
"""
import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))


def sigma_time_s(delta_t_s: float) -> float:
    """
    Incertitude σ en secondes pour un horizon de delta_t_s secondes.
    Formule : σ(x_min) = 3 * x_min^0.301 minutes, convertie en secondes.
    Calée sur : σ(1 min)=3 min, σ(10 min)=6 min, σ(60 min)≈10 min.
    """
    if delta_t_s <= 0:
        return 0.0
    delta_t_min = delta_t_s / 60.0
    return 3.0 * (delta_t_min ** 0.301) * 60.0


# ── Tests des valeurs spécifiées ───────────────────────────────────────────

def test_sigma_zero_at_t0():
    assert sigma_time_s(0) == pytest.approx(0.0)


def test_sigma_negative_is_zero():
    assert sigma_time_s(-100) == pytest.approx(0.0)


def test_sigma_at_1_min():
    """À 1 minute d'horizon : σ ≈ ±3 min = 180 s."""
    s = sigma_time_s(60)
    assert abs(s - 180) < 15, f"attendu ≈180 s, reçu {s:.1f} s"


def test_sigma_at_10_min():
    """À 10 minutes d'horizon : σ ≈ ±6 min = 360 s."""
    s = sigma_time_s(600)
    assert abs(s - 360) < 30, f"attendu ≈360 s, reçu {s:.1f} s"


def test_sigma_at_60_min():
    """À 60 minutes d'horizon : σ ≈ ±10 min = 600 s."""
    s = sigma_time_s(3600)
    assert abs(s - 600) < 60, f"attendu ≈600 s, reçu {s:.1f} s"


# ── Tests des propriétés de la courbe ──────────────────────────────────────

def test_sigma_monotone_increasing():
    """L'incertitude doit croître avec l'horizon."""
    deltas = [0, 30, 60, 120, 300, 600, 1200, 3600]
    sigmas = [sigma_time_s(d) for d in deltas]
    for i in range(1, len(sigmas)):
        assert sigmas[i] >= sigmas[i - 1], (
            f"Non-monotone : σ({deltas[i]}) = {sigmas[i]:.1f} < σ({deltas[i-1]}) = {sigmas[i-1]:.1f}"
        )


def test_sigma_bounded_above():
    """À horizon très long, σ ne doit pas dépasser 20 min = 1200 s."""
    assert sigma_time_s(7200) < 1200


def test_sigma_positive_for_positive_delta():
    """Pour tout delta > 0, σ doit être strictement positif."""
    for d in [1, 10, 60, 600, 3600]:
        assert sigma_time_s(d) > 0

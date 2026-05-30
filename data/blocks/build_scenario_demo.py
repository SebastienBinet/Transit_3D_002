"""
Génère web/data/scenario_stm_1.json à partir de routes_stm.json uniquement,
sans nécessiter le cache GTFS.

Produit des trajectoires synthétiques calées sur des vitesses moyennes de bus
urbain (~15 km/h) avec le modèle d'adhérence réel.  Utilisé comme démo jusqu'à
ce que data-sync.yml génère les horaires GTFS réels.

Usage : uv run python data/blocks/build_scenario_demo.py
"""
from __future__ import annotations
import json
import math
import sys
from pathlib import Path

ROOT      = Path(__file__).parent.parent.parent
ROUTES_IN = ROOT / "web" / "data" / "routes_stm.json"
OUTPUT    = ROOT / "web" / "data" / "scenario_stm_1.json"

T0_SECONDS     = 7 * 3600      # 07:00:00
HORIZON_S      = 1800.0        # 30 min
FRAME_INTERVAL = 2.0
TRAJ_STEP_S    = 60.0
N_STEPS        = int(HORIZON_S / TRAJ_STEP_S) + 1   # 31

AVG_SPEED_MPS  = 4.0           # ~15 km/h, bus urbain de pointe
DWELL_S        = 20.0          # temps d'arrêt


def sigma_time_s(delta_t_s: float) -> float:
    if delta_t_s <= 0:
        return 0.0
    return 3.0 * ((delta_t_s / 60.0) ** 0.301) * 60.0


def build_fake_sched(route: dict, departure_offset_s: float) -> list[tuple[float, float, float]]:
    """Retourne liste triée (t_arr, t_dep, progress_m) simulant un trip."""
    visits = []
    speed = AVG_SPEED_MPS
    for stop in route["stops"]:
        t_arr = T0_SECONDS + departure_offset_s + stop["progress_m"] / speed
        t_dep = t_arr + DWELL_S
        visits.append((t_arr, t_dep, stop["progress_m"]))
    return visits


def sched_fn(visits: list[tuple[float, float, float]], length_m: float):
    """Interpolation linéaire par morceaux entre les arrêts."""
    pts: list[tuple[float, float]] = []
    for t_arr, t_dep, prog in visits:
        if pts and t_arr <= pts[-1][0]:
            t_arr = pts[-1][0] + 0.001
        pts.append((t_arr, prog))
        if t_dep > t_arr:
            pts.append((t_dep, prog))

    t_first, t_last = pts[0][0], pts[-1][0]

    def sched(t: float) -> float:
        if t <= t_first:
            return 0.0
        if t >= t_last:
            return length_m
        lo, hi = 0, len(pts) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if pts[mid][0] <= t:
                lo = mid
            else:
                hi = mid
        t1, p1 = pts[lo]
        t2, p2 = pts[hi]
        return p1 if t2 == t1 else p1 + (p2 - p1) * (t - t1) / (t2 - t1)

    return sched


def build_trajectory(sched, length_m: float, T_sim_offset: float) -> list[dict]:
    points = []
    prev = (-1.0, -1.0, -1.0)
    for k in range(N_STEPS):
        delta_t = k * TRAJ_STEP_S
        t_world = T0_SECONDS + T_sim_offset + delta_t
        p50 = sched(t_world)
        if k == 0:
            p10 = p50; p90 = p50
        else:
            sigma_s = sigma_time_s(delta_t)
            p10 = sched(t_world - sigma_s)
            p90 = sched(t_world + sigma_s)

        p50 = min(max(p50, 0.0), length_m)
        p10 = min(max(p10, 0.0), p50)
        p90 = min(max(p90, p50), length_m)
        if prev[0] >= 0:
            p10 = max(p10, prev[0])
            p50 = max(p50, prev[1])
            p90 = max(p90, prev[2])
            p50 = max(p50, p10)
            p90 = max(p90, p50)
        prev = (p10, p50, p90)
        points.append({"t": round(T_sim_offset + delta_t, 3),
                        "p10": round(p10, 2), "p50": round(p50, 2), "p90": round(p90, 2)})
    return points


def main() -> None:
    sys.path.insert(0, str(ROOT))
    from sim.models import SimulationOutput

    routes_data = json.loads(ROUTES_IN.read_text(encoding="utf-8"))
    print(f"Lignes : {[r['line_id'] for r in routes_data]}")

    # Décalages de départ : on étale les trips sur ±10 min autour de T0
    # pour qu'ils soient tous actifs dans la fenêtre [0, 1800 s].
    offsets = {
        r["line_id"]: i * 90 - 270  # -270, -180, -90, 0, 90, 180 s
        for i, r in enumerate(routes_data)
    }

    # Construction des scheds et fenêtres de correspondance
    stop_to_lines: dict[str, set] = {}
    for r in routes_data:
        for s in r["stops"]:
            stop_to_lines.setdefault(s["stop_id"], set()).add(r["line_id"])

    vehicles_meta = []
    for idx, route in enumerate(routes_data):
        visits = build_fake_sched(route, offsets[route["line_id"]])
        fn = sched_fn(visits, route["length_m"])
        vehicles_meta.append({
            "vehicle_id": f"{route['line_id']}-trip1",
            "line_id":    route["line_id"],
            "length_m":   route["length_m"],
            "sched":      fn,
            "visits":     visits,
        })

    frames = []
    T_sim = 0.0
    while T_sim <= HORIZON_S + 1e-6:
        vehicles = []
        for v in vehicles_meta:
            traj = build_trajectory(v["sched"], v["length_m"], T_sim)
            vehicles.append({"vehicle_id": v["vehicle_id"],
                              "line_id": v["line_id"],
                              "trajectory": traj})
        frames.append({"sim_time": round(T_sim, 3),
                        "vehicles": vehicles,
                        "transfers": [], "passenger": None})
        T_sim = round(T_sim + FRAME_INTERVAL, 6)

    windows = []
    for v in vehicles_meta:
        for t_arr, t_dep, prog in v["visits"]:
            sid_candidates = [
                s["stop_id"] for s in next(
                    r for r in routes_data if r["line_id"] == v["line_id"]
                )["stops"]
                if abs(s["progress_m"] - prog) < 0.1
            ]
            for sid in sid_candidates:
                if len(stop_to_lines.get(sid, set())) < 2:
                    continue
                t_open  = t_arr - T0_SECONDS
                t_close = t_dep - T0_SECONDS
                if t_close < 0 or t_open > HORIZON_S:
                    continue
                t_open  = max(0.0, t_open)
                t_close = min(HORIZON_S, max(t_close, t_open + 1.0))
                windows.append({"stop_id": sid,
                                 "connector_vehicle_id": v["vehicle_id"],
                                 "t_open": round(t_open, 3),
                                 "t_close": round(t_close, 3)})

    output = {"routes": routes_data, "frames": frames,
              "passenger_trajectory": [], "transfer_windows": windows}
    print("Validation Pydantic …")
    SimulationOutput.model_validate(output)

    OUTPUT.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    size_mb = OUTPUT.stat().st_size / 1024 / 1024
    print(f"Écrit : {OUTPUT}  ({size_mb:.1f} MB, {len(frames)} frames)")


if __name__ == "__main__":
    main()

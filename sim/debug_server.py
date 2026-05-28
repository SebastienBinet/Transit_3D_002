"""
Serveur de diagnostics Transit-3D.

Lance : uv run python -m sim.debug_server
Interroge :
    curl http://localhost:8765/stats          # agrégats
    curl http://localhost:8765/log?n=20       # derniers événements bruts
    curl http://localhost:8765/log?type=drawFrame   # seulement les draws
    curl http://localhost:8765/jumps          # sauts détectés dans currentSimTime
"""
from __future__ import annotations

import statistics
import time
from collections import deque

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Transit-3D Diagnostics")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Stockage circulaire — ~1 min à 60 fps, moins pour les draws
_events: deque[dict] = deque(maxlen=4000)


class LogBatch(BaseModel):
    entries: list[dict]


@app.post("/log")
def post_log(batch: LogBatch):
    ts = time.time()
    for e in batch.entries:
        e["_server_ts"] = ts
        _events.append(e)
    return {"received": len(batch.entries), "total": len(_events)}


@app.get("/log")
def get_log(n: int = 30, type: str | None = None):
    data = list(_events)
    if type:
        data = [e for e in data if e.get("type") == type]
    return data[-n:]


@app.get("/stats")
def get_stats():
    data = list(_events)
    if not data:
        return {"error": "aucune donnée — le navigateur est-il connecté ?"}

    ticks = [e for e in data if e.get("type") == "tick"]
    draws = [e for e in data if e.get("type") == "drawFrame"]

    result: dict = {
        "total_events": len(data),
        "tick_count": len(ticks),
        "draw_count": len(draws),
    }

    if len(ticks) >= 2:
        sim_d  = [ticks[i]["simTime"] - ticks[i - 1]["simTime"] for i in range(1, len(ticks))]
        tgy_d  = [ticks[i]["tGroupY"] - ticks[i - 1]["tGroupY"] for i in range(1, len(ticks))]
        raf_ms = [e["rafMs"] for e in ticks if "rafMs" in e]
        med    = statistics.median(sim_d)
        result["simTime"] = {
            "premier": round(ticks[0]["simTime"], 3),
            "dernier": round(ticks[-1]["simTime"], 3),
            "delta_median": round(med, 4),
            "delta_max":    round(max(sim_d), 4),
            "sauts_retour": sum(1 for d in sim_d if d < -0.001),
            "sauts_avant_5x": sum(1 for d in sim_d if d > med * 5),
        }
        if tgy_d:
            result["timeGroupY"] = {
                "premier": round(ticks[0]["tGroupY"], 2),
                "dernier": round(ticks[-1]["tGroupY"], 2),
                "delta_median": round(statistics.median(tgy_d), 4),
            }
        if raf_ms:
            result["raf"] = {
                "median_ms": round(statistics.median(raf_ms), 2),
                "max_ms":    round(max(raf_ms), 2),
                "frames_lentes_50ms": sum(1 for d in raf_ms if d > 50),
            }

    if draws:
        result["draws_recents"] = [
            {"frameSim": e.get("frameSim"), "currentSimTime": e.get("currentSimTime"),
             "delta": round(e.get("frameSim", 0) - e.get("currentSimTime", 0), 3),
             "drawMs": e.get("drawMs")}
            for e in draws[-8:]
        ]

    return result


@app.get("/jumps")
def get_jumps(threshold: float = 0.1):
    """Retourne les événements tick où currentSimTime a sauté de façon anormale."""
    ticks = [e for e in _events if e.get("type") == "tick"]
    if len(ticks) < 2:
        return {"jumps": [], "msg": "pas assez de ticks"}

    deltas = [
        {
            "i": i,
            "t": round(ticks[i]["simTime"], 3),
            "delta": round(ticks[i]["simTime"] - ticks[i - 1]["simTime"], 4),
            "rafMs": ticks[i].get("rafMs"),
        }
        for i in range(1, len(ticks))
    ]
    med = statistics.median(d["delta"] for d in deltas)
    jumps = [d for d in deltas if abs(d["delta"] - med) > threshold or d["delta"] < 0]
    return {"median_delta": round(med, 4), "jumps": jumps[-20:]}


@app.delete("/log")
def clear_log():
    _events.clear()
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")

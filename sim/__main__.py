import json
from datetime import datetime, timezone
from pathlib import Path
from sim.simulator import simulate

DATA_DIR = Path(__file__).parent.parent / "web" / "data"


def main() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    now = datetime.now(timezone.utc)
    build_info = {
        "sim_date": now.strftime("%Y-%m-%d"),
        "viz_built_at": now.strftime("%Y-%m-%d %H:%M UTC"),
    }
    (DATA_DIR / "build_info.json").write_text(json.dumps(build_info))
    for sid in (1, 2):
        output = simulate(sid)
        path = DATA_DIR / f"scenario{sid}.json"
        path.write_text(output.model_dump_json())
        print(f"scenario{sid}.json : {len(output.frames)} frames → {path}")


if __name__ == "__main__":
    main()

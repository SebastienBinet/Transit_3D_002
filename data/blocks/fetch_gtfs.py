"""
Télécharge le GTFS de la STM et l'extrait dans data/cache/gtfs/.
Re-télécharge uniquement si le cache a plus de 7 jours.

Usage : uv run python data/blocks/fetch_gtfs.py [--force]
"""
from __future__ import annotations
import sys
import time
import zipfile
from pathlib import Path
from datetime import datetime, timezone

GTFS_URL  = "https://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip"
CACHE_DIR = Path(__file__).parent.parent / "cache" / "gtfs"
MAX_AGE_S = 7 * 24 * 3600   # 7 jours

NEEDED_FILES = {
    "routes.txt", "trips.txt", "stop_times.txt",
    "stops.txt", "shapes.txt", "calendar.txt", "calendar_dates.txt",
}


def is_cache_fresh() -> bool:
    stamp = CACHE_DIR / ".fetched_at"
    if not stamp.exists():
        return False
    age = time.time() - stamp.stat().st_mtime
    return age < MAX_AGE_S


def download_and_extract(force: bool = False) -> None:
    if not force and is_cache_fresh():
        print(f"Cache GTFS récent ({CACHE_DIR}) — téléchargement ignoré.")
        return

    try:
        import requests
    except ImportError:
        print("ERREUR : 'requests' non installé. Lancer : uv add requests", file=sys.stderr)
        sys.exit(1)

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = CACHE_DIR / "gtfs_stm.zip"

    print(f"Téléchargement GTFS depuis {GTFS_URL} …")
    headers = {"User-Agent": "transit-3d/1.0 (github.com/SebastienBinet/Transit_3D_002)"}
    resp = requests.get(GTFS_URL, headers=headers, timeout=120)
    resp.raise_for_status()
    zip_path.write_bytes(resp.content)
    print(f"  {len(resp.content) / 1e6:.1f} MB téléchargés.")

    print("Extraction …")
    with zipfile.ZipFile(zip_path) as zf:
        names_in_zip = set(zf.namelist())
        for name in NEEDED_FILES:
            if name in names_in_zip:
                zf.extract(name, CACHE_DIR)
            else:
                print(f"  AVERTISSEMENT : {name} absent du GTFS.")
    zip_path.unlink()  # supprimer le zip, garder uniquement les CSV

    (CACHE_DIR / ".fetched_at").write_text(
        datetime.now(timezone.utc).isoformat()
    )
    print(f"Cache GTFS mis à jour dans {CACHE_DIR}")


if __name__ == "__main__":
    force = "--force" in sys.argv
    download_and_extract(force=force)

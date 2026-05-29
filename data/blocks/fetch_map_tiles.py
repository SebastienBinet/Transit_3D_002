"""
Télécharge les tuiles OSM pour la bounding box des lignes STM,
compose un PNG unique et sauvegarde les bounds géoréférencées.

Sorties :
  web/data/map_montreal.png
  web/data/map_bounds.json

Usage : uv run python data/blocks/fetch_map_tiles.py
"""
from __future__ import annotations
import json
import math
import sys
import time
from pathlib import Path

WEB_DATA   = Path(__file__).parent.parent.parent / "web" / "data"
ROUTES_STM = WEB_DATA / "routes_stm.json"
OUT_PNG    = WEB_DATA / "map_montreal.png"
OUT_BOUNDS = WEB_DATA / "map_bounds.json"

ZOOM       = 14        # résolution ≈ 10 m/pixel
TILE_SIZE  = 256       # pixels par tuile OSM
PADDING    = 0.15      # 15 % de marge autour des routes
MAX_DIM    = 4096      # limite en pixels du PNG composite
RATE_LIMIT = 0.6       # secondes entre requêtes (OSM tile policy)

OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
USER_AGENT = "transit-3d/1.0 (github.com/SebastienBinet/Transit_3D_002)"


def deg2tile(lat_deg: float, lon_deg: float, zoom: int) -> tuple[int, int]:
    lat_r = math.radians(lat_deg)
    n = 2 ** zoom
    x = int((lon_deg + 180.0) / 360.0 * n)
    y = int((1.0 - math.log(math.tan(lat_r) + 1.0 / math.cos(lat_r)) / math.pi) / 2.0 * n)
    return x, y


def tile2deg(x: int, y: int, zoom: int) -> tuple[float, float]:
    n = 2 ** zoom
    lon = x / n * 360.0 - 180.0
    lat_r = math.atan(math.sinh(math.pi * (1 - 2 * y / n)))
    lat = math.degrees(lat_r)
    return lat, lon


def load_bounds_from_routes() -> tuple[float, float, float, float]:
    """Retourne (lat_min, lon_min, lat_max, lon_max) depuis routes_stm.json."""
    if not ROUTES_STM.exists():
        print("ERREUR : routes_stm.json introuvable. Lancer build_routes.py d'abord.", file=sys.stderr)
        sys.exit(1)
    routes = json.loads(ROUTES_STM.read_text(encoding="utf-8"))
    lats, lons = [], []
    for r in routes:
        for pt in r["shape"]:
            lats.append(pt["lat"])
            lons.append(pt["lon"])
    lat_min, lat_max = min(lats), max(lats)
    lon_min, lon_max = min(lons), max(lons)
    # Ajouter padding
    dlat = (lat_max - lat_min) * PADDING
    dlon = (lon_max - lon_min) * PADDING
    return lat_min - dlat, lon_min - dlon, lat_max + dlat, lon_max + dlon


def fetch_tiles(
    lat_min: float, lon_min: float, lat_max: float, lon_max: float,
    zoom: int,
) -> None:
    try:
        import requests
        from PIL import Image
        import io
    except ImportError:
        print("ERREUR : 'requests' et 'Pillow' requis. Lancer : uv add requests Pillow", file=sys.stderr)
        sys.exit(1)

    # Tuiles couvrant la bounding box
    x_min, y_min = deg2tile(lat_max, lon_min, zoom)   # haut-gauche (y inversé)
    x_max, y_max = deg2tile(lat_min, lon_max, zoom)   # bas-droite

    n_x = x_max - x_min + 1
    n_y = y_max - y_min + 1
    print(f"Grille de tuiles : {n_x}×{n_y} = {n_x * n_y} tuiles (zoom {zoom})")

    # Limiter la résolution du PNG composite
    while n_x * TILE_SIZE > MAX_DIM or n_y * TILE_SIZE > MAX_DIM:
        zoom -= 1
        x_min, y_min = deg2tile(lat_max, lon_min, zoom)
        x_max, y_max = deg2tile(lat_min, lon_max, zoom)
        n_x = x_max - x_min + 1
        n_y = y_max - y_min + 1
        print(f"  Zoom réduit à {zoom} : {n_x}×{n_y} tuiles")

    canvas = Image.new("RGB", (n_x * TILE_SIZE, n_y * TILE_SIZE), (200, 200, 200))

    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT

    total = n_x * n_y
    for idx, (xi, yi) in enumerate(
        (x_min + dx, y_min + dy) for dy in range(n_y) for dx in range(n_x)
    ):
        url = OSM_URL.format(z=zoom, x=xi, y=yi)
        try:
            resp = session.get(url, timeout=30)
            resp.raise_for_status()
            tile_img = Image.open(io.BytesIO(resp.content))
            px = (xi - x_min) * TILE_SIZE
            py = (yi - y_min) * TILE_SIZE
            canvas.paste(tile_img, (px, py))
        except Exception as e:
            print(f"  AVERTISSEMENT : tuile ({xi},{yi}) ignorée : {e}")
        if (idx + 1) % 10 == 0 or idx + 1 == total:
            print(f"  {idx + 1}/{total} tuiles", end="\r")
        time.sleep(RATE_LIMIT)

    print()

    # Bounds géoréférencées du PNG composite (coins des tuiles extrêmes)
    top_left_lat,  top_left_lon  = tile2deg(x_min,     y_min,     zoom)
    bot_right_lat, bot_right_lon = tile2deg(x_max + 1, y_max + 1, zoom)

    bounds = {
        "lat_min": bot_right_lat,
        "lon_min": top_left_lon,
        "lat_max": top_left_lat,
        "lon_max": bot_right_lon,
        "lat_center": (top_left_lat  + bot_right_lat) / 2,
        "lon_center": (top_left_lon  + bot_right_lon) / 2,
        "zoom": zoom,
        "width_px":  n_x * TILE_SIZE,
        "height_px": n_y * TILE_SIZE,
    }

    WEB_DATA.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT_PNG, "PNG", optimize=True)
    OUT_BOUNDS.write_text(json.dumps(bounds, indent=2), encoding="utf-8")

    print(f"Écrit : {OUT_PNG}  ({OUT_PNG.stat().st_size / 1e6:.1f} MB)")
    print(f"Écrit : {OUT_BOUNDS}")
    print(f"Bounds : lat [{bounds['lat_min']:.4f}, {bounds['lat_max']:.4f}]"
          f"  lon [{bounds['lon_min']:.4f}, {bounds['lon_max']:.4f}]")


if __name__ == "__main__":
    lat_min, lon_min, lat_max, lon_max = load_bounds_from_routes()
    fetch_tiles(lat_min, lon_min, lat_max, lon_max, ZOOM)

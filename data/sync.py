"""
Point d'entrée unique pour synchroniser toutes les données externes.
Lance les blocs dans l'ordre correct (certains dépendent d'autres).

Usage : uv run python data/sync.py [--force-gtfs] [--skip-tiles] [--skip-osm]
"""
from __future__ import annotations
import importlib.util
import sys
from pathlib import Path


def run_module(path: Path, argv_extra: list[str] = ()) -> None:
    print(f"\n{'='*60}")
    print(f"▶  {path.name}")
    print(f"{'='*60}")
    old_argv = sys.argv[:]
    sys.argv = [str(path)] + list(argv_extra)
    spec = importlib.util.spec_from_file_location(path.stem, path)
    mod  = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    sys.argv = old_argv


BLOCKS = Path(__file__).parent / "blocks"


def main() -> None:
    args = sys.argv[1:]
    force_gtfs  = "--force-gtfs"  in args
    skip_tiles  = "--skip-tiles"  in args
    skip_osm    = "--skip-osm"    in args

    # 1. Télécharger le GTFS STM
    run_module(BLOCKS / "fetch_gtfs.py", ["--force"] if force_gtfs else [])

    # 2. Construire routes_stm.json (dépend du GTFS)
    run_module(BLOCKS / "build_routes.py")

    # 3. Fond de carte raster (dépend de routes_stm.json pour les bounds)
    if not skip_tiles:
        run_module(BLOCKS / "fetch_map_tiles.py")
    else:
        print("\n⏭  fetch_map_tiles.py ignoré (--skip-tiles)")

    # 4. Réseau de rues OSM (dépend de routes_stm.json pour les bounds)
    if not skip_osm:
        run_module(BLOCKS / "fetch_osm.py")
    else:
        print("\n⏭  fetch_osm.py ignoré (--skip-osm)")

    print("\n✓ Synchronisation terminée.")


if __name__ == "__main__":
    main()

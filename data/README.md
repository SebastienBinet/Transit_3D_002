# Pipeline de données

Ce dossier récupère les données externes et les transforme en fichiers que le
visualizer charge (`web/data/`). Tout part de sources **publiques** (aucune clé
ni authentification).

## Vue d'ensemble

```
GTFS STM (zip)  ─┬─►  build_routes.py        ─►  web/data/routes_stm.json
                 │      (géométrie des lignes cibles)
                 └─►  build_scenario_stm.py  ─►  web/data/circuits/{ligne}{N|S}.json
                        (horaires compacts par circuit)   + circuits_index.json

Overpass (OSM) ─────►  fetch_osm.py           ─►  web/data/streets_montreal.json
Tuiles OSM     ─────►  fetch_map_tiles.py     ─►  web/data/map_montreal.png + map_bounds.json
```

Les **circuits d'autobus** (ce qui nous intéresse le plus) = GTFS → `build_routes`
→ `build_scenario_stm`. Le reste (OSM, tuiles) ne sert qu'au fond de carte.

## Sources externes

| Bloc | Source | URL |
|------|--------|-----|
| `fetch_gtfs.py` | GTFS officiel STM (horaires + tracés) | `https://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip` |
| `fetch_osm.py` | Réseau de rues (Overpass API) | `overpass-api.de` (+ miroirs de secours) |
| `fetch_map_tiles.py` | Fond de carte raster | `tile.openstreetmap.org` |

Le GTFS est mis en cache dans `data/cache/gtfs/` (CSV standard : `routes.txt`,
`trips.txt`, `stop_times.txt`, `stops.txt`, `shapes.txt`, `calendar.txt`). Cache
valable **7 jours** ; `--force-gtfs` force un re-téléchargement.

## Lancer la synchronisation

Un seul point d'entrée orchestre les blocs dans le bon ordre :

```bash
uv run python data/sync.py
```

Options utiles :

| Flag | Effet |
|------|-------|
| `--force-gtfs` | re-télécharge le GTFS même si le cache est récent |
| `--skip-tiles` | ne refait pas le fond de carte raster |
| `--skip-osm` | ne refait pas le réseau de rues |
| `--skip-scenario` | ne reconstruit pas les circuits |

**Juste les horaires** (sans toucher à la carte) :

```bash
uv run python data/sync.py --skip-tiles --skip-osm
```

⚠️ Si tu **ajoutes une ligne** dont le tracé sort des bornes actuelles de la
carte, fais au moins une passe complète (avec tuiles + OSM) une fois, sinon les
tracés déborderaient du fond.

## Ajouter / retirer une ligne

Les lignes retenues sont listées en dur dans **`data/blocks/build_routes.py`** :

```python
TARGET_ROUTES = {"51", "11", "165", "129", "155", "66", "144", "124",
                 "480", "103", "24", "138", "104", "119", "71"}
```

Ce sont les `route_short_name` du GTFS (= le numéro affiché sur le bus). Le GTFS
STM contient **tout le réseau** ; cette liste est le filtre. Ajoute un numéro,
relance `sync.py`, et le circuit apparaît. (Pense aussi à donner une couleur N/S
dans les tables `LINE_COLORS_HEX` de `build_routes.py` / `build_scenario_stm.py`
et `web/js/colors.js`.)

## Fenêtre temporelle des horaires

Dans `data/blocks/build_scenario_stm.py` :

- `T0_SECONDS` : début de la fenêtre affichée (7h00).
- `HORIZON_S` : durée d'affichage des cônes d'incertitude (1 h).
- `GEN_PRE_S` / `GEN_POST_S` : marge de génération autour de la fenêtre. `GEN_POST_S`
  est étendu (2 h 30) pour que le Cas 7 dispose des passages de remplacement
  bien au-delà de l'horizon d'affichage (couverture ~6h30 → 10h30).

## Sorties produites (dans `web/data/`)

- `routes_stm.json` — géométrie (tracé + arrêts) des lignes cibles
- `circuits/{ligne}{N|S}.json` — un fichier par circuit-direction : tous les
  passages de la fenêtre, chacun sous forme d'horaire `[(t_arr, t_dep, progress_m)]`
- `circuits_index.json` — index des circuits + modèle σ d'incertitude
- `streets_montreal.json`, `map_montreal.png`, `map_bounds.json` — fond de carte

## Sans dépôt git local

Tu n'as **pas besoin de `git`** — seulement des fichiers du dépôt + Python. Deux
façons de les obtenir sans cloner :

**A. Télécharger un instantané ZIP** (dépôt public, aucun compte requis) :

```bash
# Remplacer <branche> par main (ou la branche de travail)
curl -L -o transit3d.zip \
  https://github.com/SebastienBinet/Transit_3D_002/archive/refs/heads/<branche>.zip
unzip transit3d.zip
cd Transit_3D_002-<branche>

uv sync
uv run python data/sync.py --skip-tiles --skip-osm   # juste les horaires
```

`uv` lit `pyproject.toml` / `uv.lock` (présents dans le ZIP) et installe les
dépendances dans un venv isolé — aucune installation système. Sans `uv`, un
`pip install -r requirements.txt` puis `python data/sync.py …` fonctionne aussi.

**B. Régénérer et récupérer les fichiers** : une fois `sync.py` lancé, tout est
dans `web/data/` — tu peux copier ce dossier où tu veux (le visualizer n'a besoin
de rien d'autre que `web/`).

> Note : la chaîne réutilise les modèles Pydantic de `sim/models.py` pour valider
> le schéma. C'est pourquoi on part des fichiers du dépôt (via ZIP) plutôt que
> d'un script isolé — pas de duplication de logique, pas de dérive. Si tu veux un
> **script autonome d'un seul fichier** (GTFS → circuits, sans le reste du dépôt),
> c'est faisable sur demande.

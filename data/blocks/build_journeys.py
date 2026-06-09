"""
Calcule, pour un « cas » donné (point de départ, point de destination, heure de
départ), les meilleurs trajets origine→destination en transport STM, à partir des
horaires planifiés (p50) des fichiers circuit.

Modèle (voir conversation de conception) :
  - Origine et destination sont des POINTS géographiques (les « intersections » de
    deux lignes ne servent qu'à nommer un coin de rue ; on prend le milieu de la
    paire d'arrêts inter-lignes la plus proche).
  - On embarque/descend/transfère par une MARCHE courte (≤ WALK_RADIUS_M, à
    WALK_SPEED_MPS). Aucun arrêt n'est partagé entre lignes : tout transfert est
    une marche entre arrêts voisins.
  - Temps planifiés seulement (p50) : t_dep à l'embarquement, t_arr à la descente.
  - RÈGLE : un même NUMÉRO de ligne (N et S confondus) est utilisé au plus une
    fois dans un trajet.
  - On retient les TRAJET_COUNT arrivées les plus hâtives ; recherche de type
    Dijkstra temporel, une arrivée conservée par (arrêt final, ensemble de lignes).

Sortie : web/data/journeys_case{ID}.json — table analysable.

Usage : uv run python data/blocks/build_journeys.py
"""
from __future__ import annotations
import heapq
import json
import math
from pathlib import Path

# ── Chemins ────────────────────────────────────────────────────────────────
CIRCUITS_DIR = Path(__file__).parent.parent.parent / "web" / "data" / "circuits"
INDEX_IN     = Path(__file__).parent.parent.parent / "web" / "data" / "circuits_index.json"
OUTPUT_DIR   = Path(__file__).parent.parent.parent / "web" / "data"

# ── Paramètres du modèle de trajet ─────────────────────────────────────────
WALK_RADIUS_M     = 300.0    # rayon de marche max (embarquement, transfert, descente)
WALK_SPEED_MPS    = 1.4      # vitesse de marche
TRANSFER_BUFFER_S = 0.0      # tampon en plus du temps de marche
TRAJET_COUNT      = 10       # nombre de trajets retenus dans la sortie finale
# La terminaison anticipée stoppe dès que SEARCH_DEPTH complétions brutes ont été
# collectées ET que le heap dépasse la pire. On choisit un multiple de TRAJET_COUNT
# pour laisser assez de place après le filtre de dominance.
SEARCH_DEPTH      = 60       # complétions brutes avant d'autoriser la coupure
MAX_JOURNEY_S     = 7200.0   # horizon absolu : ne jamais dépasser depart + 2 h
LAT_M             = 111_000.0

# ── Registre des cas (extensible : cas 6, 7, ...) ──────────────────────────
# origin_lines / dest_lines : numéros (sans suffixe N/S) dont l'intersection
# définit le point. depart_s : on peut embarquer un bus partant à t ≥ depart_s.
CASES = [
    {
        "id": "6",
        "label": "Départ 7h00 — 51∩66 → 480∩144",
        "origin_lines": ["51", "66"],
        "dest_lines":   ["480", "144"],
        "depart_s": 7 * 3600,
    },
]


# ── Géométrie ──────────────────────────────────────────────────────────────
def dist_m(a_lat, a_lon, b_lat, b_lon):
    """Distance euclidienne locale (m), précise à l'échelle urbaine."""
    lat_mid = (a_lat + b_lat) / 2.0
    lon_m = LAT_M * math.cos(lat_mid * math.pi / 180.0)
    return math.hypot((a_lat - b_lat) * LAT_M, (a_lon - b_lon) * lon_m)


def base_line(line_id: str) -> str:
    """'51N' -> '51' ; '480S' -> '480'."""
    return "".join(ch for ch in line_id if ch.isdigit())


# ── Chargement des circuits → structures de recherche ──────────────────────
def load_network(circuits_dir=CIRCUITS_DIR, index_in=INDEX_IN):
    """Retourne (stops, trips) :
      stops : liste de {stop_id, name, lat, lon, base, line_id}
      trips : liste de {trip_id, line_id, base, seq:[{stop_idx_global, t_dep, t_arr}]}
    stop_idx_global indexe la liste `stops`.
    """
    index = json.loads(Path(index_in).read_text(encoding="utf-8"))
    stops = []
    stop_key_to_idx = {}   # (line_id, stop_id) -> index global (stop_id peut se répéter entre directions)
    trips = []

    for entry in index["circuits"]:
        line_id = entry["line_id"]
        base = base_line(line_id)
        circ = json.loads((Path(circuits_dir).parent / entry["file"]).read_text(encoding="utf-8"))
        route_stops = circ["route"]["stops"]
        local_idx = []   # index global de chaque arrêt de CE circuit (aligné sur le schedule)
        for s in route_stops:
            key = (line_id, s["stop_id"])
            if key not in stop_key_to_idx:
                stop_key_to_idx[key] = len(stops)
                stops.append({
                    "stop_id": s["stop_id"], "name": s["name"],
                    "lat": s["position"]["lat"], "lon": s["position"]["lon"],
                    "base": base, "line_id": line_id,
                })
            local_idx.append(stop_key_to_idx[key])

        for trip in circ["trips"]:
            sched = trip["schedule"]
            if len(sched) != len(local_idx):
                # Sécurité : alignement index requis (schedule[i] ↔ stops[i])
                continue
            seq = [{"stop": local_idx[i], "t_dep": sched[i]["t_dep"], "t_arr": sched[i]["t_arr"]}
                   for i in range(len(sched))]
            trips.append({"trip_id": trip["trip_id"], "line_id": line_id, "base": base, "seq": seq})

    return stops, trips


def build_nearby(stops, radius=WALK_RADIUS_M):
    """nearby[i] = liste de (j, walk_s) pour tout arrêt j à ≤ radius de i (i inclus, walk 0)."""
    n = len(stops)
    nearby = [[] for _ in range(n)]
    for i in range(n):
        for j in range(n):
            d = dist_m(stops[i]["lat"], stops[i]["lon"], stops[j]["lat"], stops[j]["lon"])
            if d <= radius:
                nearby[i].append((j, d / WALK_SPEED_MPS))
    return nearby


def boardings_by_stop(trips):
    """index : stop_global -> liste de (trip_idx, position_dans_seq, t_dep)."""
    idx = {}
    for ti, trip in enumerate(trips):
        for pos, st in enumerate(trip["seq"]):
            idx.setdefault(st["stop"], []).append((ti, pos, st["t_dep"]))
    for k in idx:
        idx[k].sort(key=lambda x: x[2])
    return idx


# ── Point géographique d'une « intersection » de deux lignes ───────────────
def intersection_point(stops, lines):
    """Milieu de la paire d'arrêts la plus proche entre deux numéros de ligne."""
    a, b = lines
    sa = [s for s in stops if s["base"] == a]
    sb = [s for s in stops if s["base"] == b]
    best = None
    for x in sa:
        for y in sb:
            d = dist_m(x["lat"], x["lon"], y["lat"], y["lon"])
            if best is None or d < best[0]:
                best = (d, x, y)
    _, x, y = best
    return {
        "lat": (x["lat"] + y["lat"]) / 2.0,
        "lon": (x["lon"] + y["lon"]) / 2.0,
        "defining_lines": list(lines),
        "nearest_pair_m": round(best[0], 1),
    }


def stops_near_point(stops, pt, radius=WALK_RADIUS_M):
    """Liste de (stop_global, walk_s) pour les arrêts à ≤ radius du point."""
    out = []
    for i, s in enumerate(stops):
        d = dist_m(pt["lat"], pt["lon"], s["lat"], s["lon"])
        if d <= radius:
            out.append((i, d / WALK_SPEED_MPS, d))
    return out


# ── Recherche : Dijkstra temporel avec contrainte « une ligne par numéro » ──
def search(case, stops, trips, nearby, board_idx):
    origin = intersection_point(stops, case["origin_lines"])
    dest   = intersection_point(stops, case["dest_lines"])
    depart_s = case["depart_s"]

    # Arrêts d'accès (marche depuis l'origine) et de sortie (marche vers la destination)
    access = stops_near_point(stops, origin)            # [(stop, walk_s, dist)]
    egress = {i: (walk_s, dist) for i, walk_s, dist in stops_near_point(stops, dest)}

    # État : (time, stop_global, frozenset(bases utilisées), legs)
    # legs : liste de segments bus (le détail marche est recalculé à la sortie).
    #
    # Clé de pruning : (stop, used, last_trip_id). Deux chemins qui arrivent au même
    # arrêt via des passages de bus DIFFÉRENTS sont des états distincts et doivent
    # tous deux être développés — sinon le Dijkstra coupe les passages ultérieurs
    # d'une même ligne qui pourraient connecter à un bus différent en aval.
    best_at = {}        # (stop, frozenset, last_trip_id|None) -> meilleur temps de settle
    # Clé de complétion = tuple des trip_id réellement empruntés : plusieurs arrêts
    # de descente du même bus en zone d'arrivée ne comptent qu'UN trajet (le meilleur).
    completed = {}      # tuple(trip_ids) -> meilleure arrivée + legs

    heap = []
    counter = 0
    for stop_i, walk_s, dist in access:
        t = depart_s + walk_s
        heapq.heappush(heap, (t, counter, stop_i, frozenset(), tuple(),
                              {"access_stop": stop_i, "access_walk_s": walk_s, "access_dist": dist}))
        counter += 1

    deadline = depart_s + MAX_JOURNEY_S

    while heap:
        t, _, stop_i, used, legs, meta = heapq.heappop(heap)

        # Terminaison anticipée : si on a collecté SEARCH_DEPTH complétions brutes
        # et que le heap dépasse la pire, les futures complétions sont toutes pires.
        # On utilise SEARCH_DEPTH >> TRAJET_COUNT pour laisser de la marge au filtre
        # de dominance (certaines complétions brutes seront éliminées).
        if len(completed) >= SEARCH_DEPTH:
            worst = sorted(completed.values(), key=lambda c: c["arrival_s"])[SEARCH_DEPTH - 1]["arrival_s"]
            if t > worst:
                break

        if t > deadline:
            break

        last_tid = legs[-1]["trip_id"] if legs else None
        key = (stop_i, used, last_tid)
        if key in best_at and best_at[key] <= t:
            continue
        best_at[key] = t

        # Sortie possible : cet arrêt est-il à portée de marche de la destination ?
        if stop_i in egress and legs:
            walk_s, dist = egress[stop_i]
            arrival = t + walk_s
            # Clé = séquence exacte des passages de bus pris : plusieurs arrêts du
            # même bus dans le rayon d'arrivée ne créent qu'une seule entrée.
            ckey = tuple(leg["trip_id"] for leg in legs)
            if ckey not in completed or arrival < completed[ckey]["arrival_s"]:
                completed[ckey] = {
                    "arrival_s": arrival, "legs": legs, "meta": meta,
                    "egress_stop": stop_i, "egress_walk_s": walk_s, "egress_dist": dist,
                }

        # Expansion : marcher vers un arrêt voisin (≤ radius) puis prendre un bus
        # d'une ligne non encore utilisée qui part après l'arrivée à pied.
        for nb_stop, walk_s in nearby[stop_i]:
            ready = t + walk_s + TRANSFER_BUFFER_S
            for ti, pos, t_dep in board_idx.get(nb_stop, ()):
                trip = trips[ti]
                if trip["base"] in used:
                    continue
                if t_dep < ready:
                    continue
                # Descendre à un arrêt aval (toute position > pos)
                for j in range(pos + 1, len(trip["seq"])):
                    alight = trip["seq"][j]
                    a_stop = alight["stop"]
                    a_time = alight["t_arr"]
                    nused = used | {trip["base"]}
                    nlegs = legs + ({
                        "line_id": trip["line_id"], "base": trip["base"], "trip_id": trip["trip_id"],
                        "board_stop": nb_stop, "board_s": t_dep,
                        "alight_stop": a_stop, "alight_s": a_time,
                        "from_walk_stop": stop_i, "from_walk_s": walk_s,
                        "n_stops": j - pos,
                    },)
                    nstate_key = (a_stop, nused, trip["trip_id"])
                    if nstate_key in best_at and best_at[nstate_key] <= a_time:
                        continue
                    heapq.heappush(heap, (a_time, counter, a_stop, nused, nlegs, meta))
                    counter += 1

    # Filtre de dominance : on retire un trajet J s'il existe J' arrivant aussi tôt
    # (≤) dont l'ensemble de lignes est un sous-ensemble STRICT de celui de J — c.-à-d.
    # J ajoute des bus superflus sans gagner de temps (préfixe/détour inutile).
    cand = sorted(completed.values(), key=lambda c: c["arrival_s"])
    line_sets = [frozenset(leg["base"] for leg in c["legs"]) for c in cand]
    kept = []
    for i, c in enumerate(cand):
        dominated = any(
            j != i and line_sets[j] < line_sets[i] and cand[j]["arrival_s"] <= c["arrival_s"]
            for j in range(len(cand))
        )
        if not dominated:
            kept.append(c)
    journeys = kept[:TRAJET_COUNT]
    return origin, dest, depart_s, journeys


# ── Mise en forme de la table de sortie ────────────────────────────────────
def hms(s):
    s = int(round(s))
    return f"{s // 3600}h{(s % 3600) // 60:02d}:{s % 60:02d}"


def format_journey(rank, jr, stops, depart_s, origin_pt, dest_pt):
    """Construit la représentation détaillée d'un trajet avec toutes les infos
    géographiques (lat/lon) et temporelles (depart_s/arrive_s) nécessaires au
    visualizer pour animer le passager (phases walk / wait / bus)."""
    legs_out = []
    t = float(depart_s)  # curseur temporel

    def spt(idx):
        """Raccourci : infos d'un arrêt global par son index."""
        s = stops[idx]
        return s["stop_id"], s["name"], s["lat"], s["lon"]

    # ── Marche d'accès (ORIGIN → premier embarquement) ────────────────────
    first = jr["legs"][0]
    meta  = jr["meta"]
    _, to_name, to_lat, to_lon = spt(first["board_stop"])
    walk0_arrive = t + meta["access_walk_s"]
    legs_out.append({
        "type": "walk", "from": "ORIGIN",
        "to_stop": stops[first["board_stop"]]["stop_id"], "to_name": to_name,
        "from_lat": origin_pt["lat"], "from_lon": origin_pt["lon"],
        "to_lat": to_lat, "to_lon": to_lon,
        "dist_m": round(meta["access_dist"], 1),
        "walk_s": round(meta["access_walk_s"], 1),
        "depart_s": round(t, 1), "arrive_s": round(walk0_arrive, 1),
    })
    t = walk0_arrive

    for k, leg in enumerate(jr["legs"]):
        board_sid, board_name, board_lat, board_lon = spt(leg["board_stop"])
        alight_sid, alight_name, alight_lat, alight_lon = spt(leg["alight_stop"])

        # ── Marche de transfert entre bus k-1 et bus k ────────────────────
        if k > 0:
            prev = jr["legs"][k - 1]
            walk_arrive = t + leg["from_walk_s"]
            _, prev_name, prev_lat, prev_lon = spt(prev["alight_stop"])
            legs_out.append({
                "type": "walk",
                "from_stop": stops[prev["alight_stop"]]["stop_id"],
                "from_name": prev_name,
                "to_stop": board_sid, "to_name": board_name,
                "from_lat": prev_lat, "from_lon": prev_lon,
                "to_lat": board_lat, "to_lon": board_lon,
                "dist_m": round(leg["from_walk_s"] * WALK_SPEED_MPS, 1),
                "walk_s": round(leg["from_walk_s"], 1),
                "depart_s": round(t, 1), "arrive_s": round(walk_arrive, 1),
            })
            t = walk_arrive

        # ── Attente à l'arrêt si le bus arrive plus tard que la marche ────
        if leg["board_s"] > t + 1:
            legs_out.append({
                "type": "wait",
                "at_stop": board_sid, "at_name": board_name,
                "from_lat": board_lat, "from_lon": board_lon,
                "to_lat": board_lat, "to_lon": board_lon,
                "wait_s": round(leg["board_s"] - t, 1),
                "depart_s": round(t, 1), "arrive_s": round(leg["board_s"], 1),
            })
        t = leg["board_s"]

        # ── Segment de bus ────────────────────────────────────────────────
        legs_out.append({
            "type": "bus", "line_id": leg["line_id"], "base": leg["base"],
            "trip_id": leg["trip_id"],
            "board_stop": board_sid, "board_name": board_name,
            "board_lat": board_lat, "board_lon": board_lon,
            "board_s": leg["board_s"], "board_hms": hms(leg["board_s"]),
            "alight_stop": alight_sid, "alight_name": alight_name,
            "alight_lat": alight_lat, "alight_lon": alight_lon,
            "alight_s": leg["alight_s"], "alight_hms": hms(leg["alight_s"]),
            "n_stops": leg["n_stops"],
            "depart_s": round(leg["board_s"], 1),
            "arrive_s": round(leg["alight_s"], 1),
        })
        t = leg["alight_s"]

    # ── Marche de sortie (dernière descente → DESTINATION) ────────────────
    last = jr["legs"][-1]
    _, from_name, from_lat, from_lon = spt(last["alight_stop"])
    legs_out.append({
        "type": "walk",
        "from_stop": stops[last["alight_stop"]]["stop_id"], "from_name": from_name,
        "to": "DESTINATION",
        "from_lat": from_lat, "from_lon": from_lon,
        "to_lat": dest_pt["lat"], "to_lon": dest_pt["lon"],
        "dist_m": round(jr["egress_dist"], 1),
        "walk_s": round(jr["egress_walk_s"], 1),
        "depart_s": round(t, 1), "arrive_s": round(jr["arrival_s"], 1),
    })

    return {
        "rank": rank,
        "arrival_s": round(jr["arrival_s"], 1),
        "arrival_hms": hms(jr["arrival_s"]),
        "duration_s": round(jr["arrival_s"] - depart_s, 1),
        "n_bus": len(jr["legs"]),
        "lines": [leg["base"] for leg in jr["legs"]],
        "line_ids": [leg["line_id"] for leg in jr["legs"]],
        "legs": legs_out,
    }


def build_case(case, stops, trips, nearby, board_idx):
    origin, dest, depart_s, journeys = search(case, stops, trips, nearby, board_idx)
    return {
        "case": case["id"],
        "label": case["label"],
        "origin": origin,
        "destination": dest,
        "depart_after_s": depart_s,
        "depart_after_hms": hms(depart_s),
        "params": {
            "walk_radius_m": WALK_RADIUS_M,
            "walk_speed_mps": WALK_SPEED_MPS,
            "transfer_buffer_s": TRANSFER_BUFFER_S,
            "percentile": "p50",
            "rule": "un numéro de ligne au plus une fois par trajet (N/S confondus)",
        },
        "journeys": [format_journey(i + 1, jr, stops, depart_s, origin, dest)
                     for i, jr in enumerate(journeys)],
    }


def main():
    stops, trips = load_network()
    nearby = build_nearby(stops)
    board_idx = boardings_by_stop(trips)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for case in CASES:
        out = build_case(case, stops, trips, nearby, board_idx)
        path = OUTPUT_DIR / f"journeys_case{case['id']}.json"
        path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Cas {case['id']} : {len(out['journeys'])} trajets → {path}")
        for jr in out["journeys"]:
            print(f"  #{jr['rank']:2d}  arr {jr['arrival_hms']}  "
                  f"({jr['duration_s']/60:.1f} min, {jr['n_bus']} bus)  "
                  f"{' → '.join(jr['line_ids'])}")


if __name__ == "__main__":
    main()

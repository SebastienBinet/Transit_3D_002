// Moteur de choix (Cas 7) — couche PURE : aucun import DOM / Three.js / Canvas.
// Testable sous Node (niveau 3).
//
// Rôle : à tout instant, énumérer les « prochaines actions » possibles de l'usager
// (attendre un bus, marcher vers un arrêt, descendre pour un transfert, descendre
// et finir à pied), avec pour chacune les meilleurs trajets qui en découlent.
// L'usager peut s'engager (commit) dans un choix et changer d'idée tant que les
// horaires p50 le permettent.
//
// Déterminisme (DECISIONS.md §14) : rejeu des horaires planifiés p50 + modèle σ,
// comme scenario-model.js (§5bis). La péremption d'un choix est au p50 strict ;
// le σ ne sert qu'aux CDF. Aucune prédiction n'est inventée.
//
// PORTABILITÉ : ce module est la référence du futur code Python temps réel du
// produit. Style volontairement data-in/data-out : état explicite (plan de legs),
// fonctions paramétriques, pas d'astuce navigateur.

import { makeSigma, makeReducedSigma, makeSched, SIGMA_DEP_LATE_S, REPORT_LAG_S }
    from './scenario-model.js';
import { progressToLatLon } from './interpolation.js';

// ── Paramètres du modèle (mêmes valeurs que build_journeys.py) ─────────────
export const WALK_RADIUS_M      = 300.0;  // rayon de marche (accès, transfert, sortie)
export const WALK_SPEED_MPS     = 1.4;
export const MAX_JOURNEY_S      = 7200;   // horizon d'un trajet : maintenant + 2 h
export const SEARCH_DEPTH       = 60;     // complétions brutes avant coupure du Dijkstra
export const MAX_DEP_PER_LINE_STOP = 3;   // départs considérés par (arrêt, ligne) — les
                                          // suivants sont dominés (pas de dépassement)
const LAT_M = 111_000.0;

// ── Géométrie ──────────────────────────────────────────────────────────────
export function distM(aLat, aLon, bLat, bLon) {
    const lonM = LAT_M * Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
    return Math.hypot((aLat - bLat) * LAT_M, (aLon - bLon) * lonM);
}

// ── Modèle de probabilité (référence — copie paramétrique du Cas 6) ────────
// σ asymétrique d'un événement bus à tE : nul si passé ; ancré à
// max(now, départ terminus) ; un bus pas encore parti ne peut pas être en avance.
export function makeEventSigmas(sigmaFn, tripStarts, reportLagS = REPORT_LAG_S) {
    const reduced = makeReducedSigma(sigmaFn, reportLagS);
    return (tE, tripId, nowAbs) => {
        if (tE <= nowAbs) return { early: 0, late: 0 };
        const tFirst      = tripStarts[tripId];
        const notDeparted = tFirst != null && nowAbs < tFirst;
        const anchor      = tFirst != null ? Math.max(nowAbs, tFirst) : nowAbs;
        const dt          = Math.max(0, tE - anchor);
        const s = notDeparted ? sigmaFn(dt) : reduced(dt);
        return { early: s, late: s + (notDeparted ? SIGMA_DEP_LATE_S : 0) };
    };
}

// P(transfert réussi) entre la descente de legA et la montée de legB — linéaire :
// P=0 quand la marge vaut −σ, P=1 quand elle vaut +σ (identique au Cas 6).
export function pTransferSuccess(legA, legB, nowAbs, evSig) {
    const sgA = evSig(legA.alight_s, legA.trip_id, nowAbs);
    const sgB = evSig(legB.board_s,  legB.trip_id, nowAbs);
    const margin = legB.board_s - legA.alight_s;
    const sigma  = sgA.late + sgB.early;
    if (sigma <= 0) return margin > 0 ? 1 : 0;
    return Math.max(0, Math.min(1, 0.5 + margin / (2 * sigma)));
}

function journeyTransferP(jr, nowAbs, evSig) {
    const bus = jr.legs.filter(l => l.type === 'bus');
    let p = 1;
    for (let i = 0; i < bus.length - 1; i++) p *= pTransferSuccess(bus[i], bus[i + 1], nowAbs, evSig);
    return p;
}

// Points (t, cumP) de la CDF d'arrivée d'un choix : chaque trajet contribue
// rawP/totalP × CDF linéaire sur sa fenêtre d'arrivée [p10, p90] (Cas 6).
// tPlateau : borne basse du plateau 0 % (ex. now − passé affiché).
export function computeChoiceCdf(journeys, nowAbs, evSig, tPlateau = null) {
    const wjs = journeys.map(jr => {
        const bus = jr.legs.filter(l => l.type === 'bus');
        if (!bus.length) return null;
        const last = bus[bus.length - 1];
        const sg   = evSig(jr.arrival_s, last.trip_id, nowAbs);
        return { tLo: jr.arrival_s - sg.early, tHi: jr.arrival_s + sg.late,
                 rawP: journeyTransferP(jr, nowAbs, evSig) };
    }).filter(Boolean);
    const totalP = wjs.reduce((s, x) => s + x.rawP, 0);
    if (totalP <= 0 || !wjs.length) return { pts: [], p90First: null };

    const allT = new Set();
    if (tPlateau != null) allT.add(tPlateau);
    wjs.forEach(({ tLo, tHi }) => {
        allT.add(tLo); allT.add(tHi);
        for (let t = tLo; t <= tHi; t += 20) allT.add(t);
    });
    const pts = [...allT].sort((a, b) => a - b).map(t => {
        let cumP = 0;
        wjs.forEach(({ tLo, tHi, rawP }) => {
            const w = rawP / totalP;
            if (t >= tHi) cumP += w;
            else if (t > tLo) cumP += w * (t - tLo) / (tHi - tLo);
        });
        return { t, cumP };
    });
    return { pts, p90First: Math.min(...wjs.map(x => x.tHi)) };
}

// ── File de priorité minimale sur t (FIFO à t égal) ────────────────────────
function makeHeap() {
    const a = [];
    let counter = 0;
    const less = (x, y) => x.t < y.t || (x.t === y.t && x.c < y.c);
    return {
        get size() { return a.length; },
        push(node) {
            node.c = counter++;
            a.push(node);
            let i = a.length - 1;
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (!less(a[i], a[p])) break;
                [a[i], a[p]] = [a[p], a[i]]; i = p;
            }
        },
        pop() {
            const top = a[0], last = a.pop();
            if (a.length) {
                a[0] = last;
                let i = 0;
                for (;;) {
                    const l = 2 * i + 1, r = l + 1;
                    let m = i;
                    if (l < a.length && less(a[l], a[m])) m = l;
                    if (r < a.length && less(a[r], a[m])) m = r;
                    if (m === i) break;
                    [a[i], a[m]] = [a[m], a[i]]; i = m;
                }
            }
            return top;
        },
    };
}

// ── Moteur ─────────────────────────────────────────────────────────────────
export function createChoiceEngine({
    circuits,                 // [CircuitData] (fichiers circuit chargés)
    sigma,                    // modèle σ de l'index
    originLines, destLines,   // ex. ['51','66'] / ['480','144']
    departS,                  // heure de départ (sec depuis minuit)
    nBest = 4,                // choix affichés
    subK  = 4,                // trajets conservés par choix (pour la CDF)
    walkRadiusM  = WALK_RADIUS_M,
    walkSpeedMps = WALK_SPEED_MPS,
    maxJourneyS  = MAX_JOURNEY_S,
    searchDepth  = SEARCH_DEPTH,
}) {
    const sigmaFn = makeSigma(sigma);

    // ── Réseau : stops globaux, trips, index d'embarquement, voisinage ────
    const stops = [];               // {stopId, name, lat, lon, base, lineId}
    const trips = [];               // {tripId, lineId, base, seq:[{stop,tDep,tArr}], tFirst, tLast}
    const lineGeom = new Map();     // lineId → {shape, lengthM}
    const schedCache = new Map();   // tripId → fn(tAbs) → progress_m

    function baseLine(lineId) { return lineId.replace(/[NS]$/, ''); }

    for (const circ of circuits) {
        lineGeom.set(circ.line_id, { shape: circ.route.shape, lengthM: circ.route.length_m });
        const base = baseLine(circ.line_id);
        const localIdx = [];
        for (const s of circ.route.stops) {
            localIdx.push(stops.length);
            stops.push({ stopId: s.stop_id, name: s.name,
                         lat: s.position.lat, lon: s.position.lon,
                         base, lineId: circ.line_id });
        }
        for (const trip of circ.trips) {
            if (trip.schedule.length !== localIdx.length) continue;   // alignement requis
            const seq = trip.schedule.map((v, i) => ({ stop: localIdx[i], tDep: v.t_dep, tArr: v.t_arr }));
            trips.push({ tripId: trip.trip_id, lineId: circ.line_id, base, seq,
                         tFirst: seq[0].tDep, tLast: seq[seq.length - 1].tArr,
                         schedule: trip.schedule });
        }
    }

    const tripByIdx = trips;
    const tripStarts = {};
    for (const t of trips) tripStarts[t.tripId] = t.tFirst;
    const evSig = makeEventSigmas(sigmaFn, tripStarts);

    function schedOf(trip) {
        let fn = schedCache.get(trip.tripId);
        if (!fn) { fn = makeSched(trip.schedule).fn; schedCache.set(trip.tripId, fn); }
        return fn;
    }

    // nearby[i] = [{j, walkS}] pour tout arrêt j à ≤ walkRadiusM de i (i inclus, walk 0)
    const nearby = stops.map(() => []);
    for (let i = 0; i < stops.length; i++) {
        for (let j = 0; j < stops.length; j++) {
            const d = distM(stops[i].lat, stops[i].lon, stops[j].lat, stops[j].lon);
            if (d <= walkRadiusM) nearby[i].push({ j, walkS: d / walkSpeedMps });
        }
    }

    // boardIdx : stop global → [{ti, pos, tDep}] trié par tDep
    const boardIdx = new Map();
    trips.forEach((trip, ti) => {
        trip.seq.forEach((v, pos) => {
            if (!boardIdx.has(v.stop)) boardIdx.set(v.stop, []);
            boardIdx.get(v.stop).push({ ti, pos, tDep: v.tDep });
        });
    });
    for (const lst of boardIdx.values()) lst.sort((a, b) => a.tDep - b.tDep);

    // Premier index de boardIdx[stop] avec tDep ≥ ready (recherche binaire)
    function firstBoardable(lst, ready) {
        let lo = 0, hi = lst.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (lst[mid].tDep < ready) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    // ── Points origine / destination (milieu de la paire d'arrêts la plus proche) ──
    function intersectionPoint(lines) {
        const [a, b] = lines;
        const sa = stops.filter(s => s.base === a);
        const sb = stops.filter(s => s.base === b);
        let best = null;
        for (const x of sa) for (const y of sb) {
            const d = distM(x.lat, x.lon, y.lat, y.lon);
            if (!best || d < best.d) best = { d, x, y };
        }
        if (!best) throw new Error(`Intersection introuvable : ${lines}`);
        return { lat: (best.x.lat + best.y.lat) / 2, lon: (best.x.lon + best.y.lon) / 2 };
    }
    const origin      = intersectionPoint(originLines);
    const destination = intersectionPoint(destLines);

    // egress : stop global → temps de marche vers la destination (≤ rayon)
    const egress = new Map();
    stops.forEach((s, i) => {
        const d = distM(destination.lat, destination.lon, s.lat, s.lon);
        if (d <= walkRadiusM) egress.set(i, d / walkSpeedMps);
    });

    function stopsNearPoint(pt) {
        const out = [];
        stops.forEach((s, i) => {
            const d = distM(pt.lat, pt.lon, s.lat, s.lon);
            if (d <= walkRadiusM) out.push({ i, walkS: d / walkSpeedMps });
        });
        return out;
    }

    // Arrêt « intéressant » pour une descente : sortie possible OU au moins une
    // AUTRE ligne embarquable à portée de marche. Descendre ailleurs est inutile,
    // ce qui élague fortement le Dijkstra.
    const interesting = stops.map((s, g) =>
        egress.has(g) || nearby[g].some(({ j }) => stops[j].base !== s.base));

    // ── Dijkstra temporel (port de build_journeys.search) ──────────────────
    // seeds : [{t, stop, meta}] — meta est transporté tel quel jusqu'aux complétions.
    // usedInit : Set de numéros de ligne déjà empruntés (règle : au plus une fois).
    // Retourne [{arrivalS, legs, egressWalkS, meta}] ; legs = segments bus
    // {ti, tripId, lineId, base, boardStop, boardS, alightStop, alightS, fromWalkS}.
    function search(seeds, usedInit, tNow) {
        const heap = makeHeap();
        const bestAt = new Map();        // "stop|used|lastTrip" → t
        const completed = new Map();     // "tripIds…" (+meta key) → complétion
        const deadline = tNow + maxJourneyS;
        const MAX_SETTLES = 30_000;      // garde-fou (cas sans complétion possible)
        let worstCache = null;
        let settles = 0;

        const usedKey0 = [...usedInit].sort().join(',');
        for (const sd of seeds) {
            heap.push({ t: sd.t, stop: sd.stop, used: usedInit, usedKey: usedKey0,
                        legs: [], meta: sd.meta ?? null });
        }

        while (heap.size) {
            const st = heap.pop();
            const { t, stop, used, usedKey, legs, meta } = st;

            if (completed.size >= searchDepth) {
                if (worstCache === null) {
                    const arr = [...completed.values()].map(c => c.arrivalS).sort((a, b) => a - b);
                    worstCache = arr[searchDepth - 1];
                }
                if (t > worstCache) break;
            }
            if (t > deadline) break;
            if (++settles > MAX_SETTLES) break;

            const lastTid = legs.length ? legs[legs.length - 1].tripId : '';
            const key = `${stop}|${usedKey}|${lastTid}`;
            const prev = bestAt.get(key);
            if (prev !== undefined && prev <= t) continue;
            bestAt.set(key, t);

            // Sortie : l'arrêt est à portée de marche de la destination
            if (egress.has(stop) && legs.length) {
                const walkS = egress.get(stop);
                const arrival = t + walkS;
                const ckey = legs.map(l => l.tripId).join('>') + '|' + JSON.stringify(meta);
                const ex = completed.get(ckey);
                if (!ex || arrival < ex.arrivalS) {
                    completed.set(ckey, { arrivalS: arrival, legs, egressWalkS: walkS, meta });
                    worstCache = null;
                }
            }

            // Expansion : marcher vers un arrêt voisin puis embarquer
            for (const { j, walkS } of nearby[stop]) {
                const ready = t + walkS;
                const lst = boardIdx.get(j);
                if (!lst) continue;
                const perLine = new Map();   // lineId → nb de départs considérés
                for (let bi = firstBoardable(lst, ready); bi < lst.length; bi++) {
                    const { ti, pos, tDep } = lst[bi];
                    if (tDep > deadline) break;
                    const trip = tripByIdx[ti];
                    if (used.has(trip.base)) continue;
                    const cnt = perLine.get(trip.lineId) ?? 0;
                    if (cnt >= MAX_DEP_PER_LINE_STOP) continue;
                    perLine.set(trip.lineId, cnt + 1);
                    const nused = new Set(used); nused.add(trip.base);
                    const nusedKey = [...nused].sort().join(',');
                    for (let q = pos + 1; q < trip.seq.length; q++) {
                        const al = trip.seq[q];
                        if (al.tArr > deadline) break;
                        if (!interesting[al.stop]) continue;   // ni sortie ni transfert utile
                        const nlegs = legs.concat({
                            ti, tripId: trip.tripId, lineId: trip.lineId, base: trip.base,
                            boardStop: j, boardS: tDep, boardPosIdx: pos,
                            alightStop: al.stop, alightS: al.tArr, alightPosIdx: q,
                            fromWalkS: walkS,
                        });
                        const nkey = `${al.stop}|${nusedKey}|${trip.tripId}`;
                        const p2 = bestAt.get(nkey);
                        if (p2 !== undefined && p2 <= al.tArr) continue;
                        heap.push({ t: al.tArr, stop: al.stop, used: nused, usedKey: nusedKey,
                                    legs: nlegs, meta });
                    }
                }
            }
        }
        return [...completed.values()];
    }

    // ── Mise en forme d'un trajet pour le panneau (façon format_journey) ───
    // prefix : { kind:'board', walkS, tDep }  → marche+attente GLISSANTES (slides)
    //          { kind:'ride', rideLeg }        → segment bus courant (temps absolus)
    function formatJourney(prefix, raw) {
        const legs = [];
        if (prefix.kind === 'board') {
            legs.push({ type: 'walk', slides: true, walk_s: prefix.walkS });
            legs.push({ type: 'wait', slides: true, until_s: prefix.tDep });
        } else {
            legs.push(prefix.rideLeg);   // {type:'bus', …} déjà formé
        }
        let t = prefix.kind === 'board' ? prefix.tDep : prefix.rideLeg.alight_s;
        raw.legs.forEach((leg, k) => {
            if (k > 0 || prefix.kind !== 'board') {
                // marche + attente de transfert (ou depuis la descente du bus courant)
                const walkEnd = t + leg.fromWalkS;
                legs.push({ type: 'walk', depart_s: t, arrive_s: walkEnd });
                if (leg.boardS > walkEnd + 1) legs.push({ type: 'wait', depart_s: walkEnd, arrive_s: leg.boardS });
            }
            legs.push({
                type: 'bus', line_id: leg.lineId, base: leg.base, trip_id: leg.tripId,
                board_s: leg.boardS, alight_s: leg.alightS,
                depart_s: leg.boardS, arrive_s: leg.alightS,
                board_stop: stops[leg.boardStop].stopId, alight_stop: stops[leg.alightStop].stopId,
                board_name: stops[leg.boardStop].name, alight_name: stops[leg.alightStop].name,
            });
            t = leg.alightS;
        });
        legs.push({ type: 'walk', depart_s: t, arrive_s: raw.arrivalS, final: true });
        return {
            arrival_s: raw.arrivalS,
            lines: raw.legs.map(l => l.base),
            trip_ids: raw.legs.map(l => l.tripId),
            legs,
        };
    }

    // ── État de l'usager : plan de legs, construit par les commits ─────────
    // walk  : {type:'walk', tStart, tEnd, fromLat, fromLon, toLat, toLon, final?}
    // wait  : {type:'wait', tStart, tEnd, lat, lon, stopG}
    // ride  : {type:'ride', ti, tBoard, boardPos, tAlight?, alightPos?}   (ouvert si tAlight absent)
    let plan = [];
    let committedId = null;
    let cache = null;   // { tAt, validUntil, choices }

    function invalidate() { cache = null; }

    function reset() { plan = []; committedId = null; invalidate(); }

    // Phase courante à tAbs : {mode:'foot'|'walking'|'waiting'|'riding'|'arrived', lat, lon, …}
    function phaseAt(tAbs) {
        let lat = origin.lat, lon = origin.lon;
        for (const leg of plan) {
            if (leg.type === 'walk') {
                if (tAbs < leg.tStart) return { mode: 'foot', lat, lon };
                if (tAbs < leg.tEnd) {
                    const r = (tAbs - leg.tStart) / Math.max(1e-9, leg.tEnd - leg.tStart);
                    return { mode: 'walking', final: !!leg.final,
                             lat: leg.fromLat + r * (leg.toLat - leg.fromLat),
                             lon: leg.fromLon + r * (leg.toLon - leg.fromLon) };
                }
                lat = leg.toLat; lon = leg.toLon;
                if (leg.final) return { mode: 'arrived', lat, lon };
            } else if (leg.type === 'wait') {
                if (tAbs < leg.tEnd) return { mode: 'waiting', lat: leg.lat, lon: leg.lon, stopG: leg.stopG };
                lat = leg.lat; lon = leg.lon;
            } else {  // ride
                const trip = tripByIdx[leg.ti];
                const tEnd = leg.tAlight ?? trip.tLast;
                if (tAbs < tEnd) {
                    const geom = lineGeom.get(trip.lineId);
                    const ll = progressToLatLon(schedOf(trip)(tAbs), geom.shape) ?? { lat, lon };
                    return { mode: 'riding', ti: leg.ti, ride: leg, lat: ll.lat, lon: ll.lon };
                }
                const endStop = leg.alightPos != null ? trip.seq[leg.alightPos].stop
                                                      : trip.seq[trip.seq.length - 1].stop;
                lat = stops[endStop].lat; lon = stops[endStop].lon;
            }
        }
        return { mode: plan.length && plan[plan.length - 1].final ? 'arrived' : 'foot', lat, lon };
    }

    // Lignes déjà empruntées à tAbs (rides commencés)
    function usedLinesAt(tAbs) {
        const used = new Set();
        for (const leg of plan) if (leg.type === 'ride' && leg.tBoard <= tAbs) used.add(tripByIdx[leg.ti].base);
        return used;
    }

    // Prochaine frontière de phase après tAbs (fin de marche, embarquement, descente…)
    function nextTransition(tAbs) {
        let next = Infinity;
        const consider = (t) => { if (t > tAbs && t < next) next = t; };
        for (const leg of plan) {
            if (leg.type === 'walk' || leg.type === 'wait') { consider(leg.tStart); consider(leg.tEnd); }
            else {
                consider(leg.tBoard);
                consider(leg.tAlight ?? tripByIdx[leg.ti].tLast);
            }
        }
        return next;
    }

    // Tronque le plan à tAbs (changement d'idée) : coupe le leg courant et retire la suite.
    function truncateAt(tAbs) {
        const kept = [];
        for (const leg of plan) {
            const tStart = leg.type === 'ride' ? leg.tBoard : leg.tStart;
            if (tStart >= tAbs) break;
            if (leg.type === 'walk' && tAbs < leg.tEnd) {
                const r = (tAbs - leg.tStart) / Math.max(1e-9, leg.tEnd - leg.tStart);
                kept.push({ ...leg,
                    tEnd: tAbs,
                    toLat: leg.fromLat + r * (leg.toLat - leg.fromLat),
                    toLon: leg.fromLon + r * (leg.toLon - leg.fromLon) });
                break;
            }
            if (leg.type === 'wait' && tAbs < leg.tEnd) { kept.push({ ...leg, tEnd: tAbs }); break; }
            if (leg.type === 'ride') {
                const tEnd = leg.tAlight ?? tripByIdx[leg.ti].tLast;
                if (tAbs < tEnd) { kept.push({ type: 'ride', ti: leg.ti, tBoard: leg.tBoard, boardPos: leg.boardPos }); break; }
            }
            kept.push(leg);
        }
        plan = kept;
    }

    // ── Énumération contexte « à pied » ────────────────────────────────────
    function enumerateOnFoot(pos, tNow, used) {
        const seeds = stopsNearPoint(pos).map(({ i, walkS }) => ({ t: tNow + walkS, stop: i }));
        if (!seeds.length) return [];
        const completions = search(seeds, used, tNow);

        // Groupe par premier embarquement (tripId@stop)
        const groups = new Map();
        for (const c of completions) {
            const f = c.legs[0];
            const gkey = `${f.tripId}@${f.boardStop}`;
            if (!groups.has(gkey)) groups.set(gkey, []);
            groups.get(gkey).push(c);
        }
        // Dédoublonnage par ligne-direction : meilleure arrivée ; à égalité, la
        // marche la plus courte (confort). Un embarquement plus lointain sur le
        // même passage réapparaîtra comme choix de REMPLACEMENT quand celui-ci
        // expirera (« trop tard ici, mais encore possible à l'arrêt suivant »).
        const perLine = new Map();   // lineId → {gkey, arr, walkS}
        for (const [gkey, comps] of groups) {
            comps.sort((a, b) => a.arrivalS - b.arrivalS);
            const f = comps[0].legs[0];
            const bs = stops[f.boardStop];
            const walkS = distM(pos.lat, pos.lon, bs.lat, bs.lon) / walkSpeedMps;
            if (tNow + walkS > f.boardS) continue;   // plus le temps d'y marcher
            const arr = comps[0].arrivalS;
            const cur = perLine.get(f.lineId);
            if (!cur || arr < cur.arr - 1e-9 ||
                (Math.abs(arr - cur.arr) < 1e-9 && walkS < cur.walkS)) {
                perLine.set(f.lineId, { gkey, arr, walkS });
            }
        }

        // Post-passe : le Dijkstra fusionne les embarquements équivalents d'un même
        // passage (états identiques à la descente) et peut retenir un arrêt lointain.
        // On re-choisit, parmi les arrêts du passage EN AMONT de la première descente,
        // celui à marche minimale encore attrapable. Pas de plafond de rayon ici :
        // la distance affichée est la vraie marche (« marcher vers la 103 » peut
        // dépasser le rayon de recherche, c'est le choix long assumé du récit).
        function bestBoarding(comps) {
            const f = comps[0].legs[0];
            const trip = tripByIdx[f.ti];
            const minAlight = Math.min(...comps.map(c => c.legs[0].alightPosIdx));
            let best = null;
            for (let p = 0; p < minAlight; p++) {
                const g = trip.seq[p].stop;
                const w = distM(pos.lat, pos.lon, stops[g].lat, stops[g].lon) / walkSpeedMps;
                if (tNow + w > trip.seq[p].tDep) continue;
                if (!best || w < best.w) best = { p, g, w, tDep: trip.seq[p].tDep };
            }
            return best;
        }

        const choices = [];
        for (const { gkey, walkS: walkS0 } of perLine.values()) {
            let comps = groups.get(gkey).slice(0, subK);
            let walkS = walkS0;
            const bb = bestBoarding(comps);
            if (bb && bb.g !== comps[0].legs[0].boardStop) {
                walkS = bb.w;
                comps = comps.map(c => ({
                    ...c,
                    legs: [{ ...c.legs[0], boardStop: bb.g, boardS: bb.tDep, boardPosIdx: bb.p },
                           ...c.legs.slice(1)],
                }));
            }
            const f = comps[0].legs[0];
            const bs = stops[f.boardStop];
            const journeys = comps.map(c => formatJourney({ kind: 'board', walkS, tDep: f.boardS }, c));
            choices.push({
                id: `board:${f.tripId}@${bs.stopId}`,
                kind: 'board',
                lineId: f.lineId, base: f.base,
                tripId: f.tripId,
                boardStop: { stopId: bs.stopId, name: bs.name, lat: bs.lat, lon: bs.lon, g: f.boardStop },
                boardPos: f.boardPosIdx,
                ti: f.ti,
                tDep: f.boardS,
                walkS,
                expiresS: f.boardS - walkS,
                bestArrivalS: comps[0].arrivalS,
                journeys,
            });
        }
        return choices;
    }

    // ── Énumération contexte « à bord » ────────────────────────────────────
    function enumerateRiding(ride, tNow, used) {
        const trip = tripByIdx[ride.ti];
        const geom = lineGeom.get(trip.lineId);

        // Descentes possibles : tout arrêt aval que le bus n'a pas encore quitté
        const alights = [];
        for (let q = ride.boardPos + 1; q < trip.seq.length; q++) {
            if (trip.seq[q].tDep >= tNow) alights.push(q);
        }
        if (!alights.length) return [];

        const rideLegOf = (q) => ({
            type: 'bus', line_id: trip.lineId, base: trip.base, trip_id: trip.tripId,
            board_s: ride.tBoard, alight_s: trip.seq[q].tArr,
            depart_s: ride.tBoard, arrive_s: trip.seq[q].tArr,
            alight_stop: stops[trip.seq[q].stop].stopId,
            alight_name: stops[trip.seq[q].stop].name,
        });

        const choices = [];

        // a) Descendre et finir à pied — meilleure descente vers la destination
        let bestFinal = null;
        for (const q of alights) {
            const g = trip.seq[q].stop;
            if (!egress.has(g)) continue;
            const arrival = trip.seq[q].tArr + egress.get(g);
            if (!bestFinal || arrival < bestFinal.arrival) bestFinal = { q, arrival };
        }
        if (bestFinal) {
            const q = bestFinal.q;
            const g = trip.seq[q].stop;
            choices.push({
                id: `final:${trip.tripId}@${stops[g].stopId}`,
                kind: 'final',
                lineId: trip.lineId, base: trip.base,
                alightStop: { stopId: stops[g].stopId, name: stops[g].name, g },
                alightPos: q, tAlight: trip.seq[q].tArr, ti: ride.ti,
                egressWalkS: egress.get(g),
                expiresS: trip.seq[q].tDep,
                bestArrivalS: bestFinal.arrival,
                journeys: [{
                    arrival_s: bestFinal.arrival, lines: [], trip_ids: [],
                    legs: [rideLegOf(q),
                           { type: 'walk', depart_s: trip.seq[q].tArr, arrive_s: bestFinal.arrival, final: true }],
                }],
            });
        }

        // b) Transferts : Dijkstra semé à chaque descente possible
        const seeds = alights.map(q => ({ t: trip.seq[q].tArr, stop: trip.seq[q].stop, meta: { q } }));
        const completions = search(seeds, used, tNow);

        // Groupe par (descente, premier embarquement) puis dédoublonne par ligne cible
        const groups = new Map();
        for (const c of completions) {
            if (!c.legs.length) continue;
            const f = c.legs[0];
            const gkey = `${c.meta.q}>${f.tripId}@${f.boardStop}`;
            if (!groups.has(gkey)) groups.set(gkey, []);
            groups.get(gkey).push(c);
        }
        const perLine = new Map();   // lineId cible → {gkey, bestArrival, expiry}
        for (const [gkey, comps] of groups) {
            comps.sort((a, b) => a.arrivalS - b.arrivalS);
            const f = comps[0].legs[0];
            const expiry = trip.seq[comps[0].meta.q].tDep;   // le bus quitte l'arrêt de descente
            const cur = perLine.get(f.lineId);
            if (!cur || comps[0].arrivalS < cur.bestArrival - 1e-9 ||
                (Math.abs(comps[0].arrivalS - cur.bestArrival) < 1e-9 && expiry > cur.expiry)) {
                perLine.set(f.lineId, { gkey, bestArrival: comps[0].arrivalS, expiry });
            }
        }

        for (const { gkey } of perLine.values()) {
            const comps = groups.get(gkey).slice(0, subK);
            const f = comps[0].legs[0];
            const q = comps[0].meta.q;
            const bs = stops[f.boardStop];
            const journeys = comps.map(c => formatJourney({ kind: 'ride', rideLeg: rideLegOf(q) }, c));
            choices.push({
                id: `transfer:${trip.tripId}@${stops[trip.seq[q].stop].stopId}->${f.tripId}@${bs.stopId}`,
                kind: 'transfer',
                lineId: f.lineId, base: f.base,
                tripId: f.tripId, ti: f.ti,
                fromTi: ride.ti,
                alightStop: { stopId: stops[trip.seq[q].stop].stopId, name: stops[trip.seq[q].stop].name,
                              g: trip.seq[q].stop },
                alightPos: q, tAlight: trip.seq[q].tArr,
                boardStop: { stopId: bs.stopId, name: bs.name, lat: bs.lat, lon: bs.lon, g: f.boardStop },
                boardPos: f.boardPosIdx,
                walkS: f.fromWalkS,
                tDep: f.boardS,
                expiresS: trip.seq[q].tDep,   // dernier moment : le bus quitte l'arrêt de descente
                bestArrivalS: comps[0].arrivalS,
                journeys,
            });
        }
        return choices;
    }

    // ── getChoices : énumération avec cache événementiel ───────────────────
    function computeChoices(tAbs) {
        const ph = phaseAt(tAbs);
        if (ph.mode === 'arrived') return [];
        const used = usedLinesAt(tAbs);
        let list = ph.mode === 'riding'
            ? enumerateRiding(ph.ride, tAbs, used)
            : enumerateOnFoot({ lat: ph.lat, lon: ph.lon }, tAbs, used);
        list = list.filter(c => c.expiresS >= tAbs);
        list.sort((a, b) => a.bestArrivalS - b.bestArrivalS || a.expiresS - b.expiresS);
        // Le choix engagé reste toujours visible, même hors du top nBest
        const committed = list.find(c => c.id === committedId);
        list = list.slice(0, nBest);
        if (committed && !list.includes(committed)) list[list.length - 1] = committed;
        for (const c of list) c.committed = (c.id === committedId);
        return list;
    }

    function getChoices(tAbs) {
        if (cache && tAbs >= cache.tAt && tAbs < cache.validUntil) return cache.choices;
        const choices = computeChoices(tAbs);
        const ph = phaseAt(tAbs);
        let validUntil = Math.min(
            nextTransition(tAbs),
            ...choices.map(c => c.expiresS),
            tAbs + (ph.mode === 'walking' ? 5 : 30),   // marche : la position bouge
        );
        if (!(validUntil > tAbs)) validUntil = tAbs + 1;
        cache = { tAt: tAbs, validUntil, choices };
        return choices;
    }

    // ── Engagement ─────────────────────────────────────────────────────────
    function commit(choiceId, tAbs) {
        const ch = getChoices(tAbs).find(c => c.id === choiceId);
        if (!ch || ch.expiresS < tAbs) return false;
        const ph = phaseAt(tAbs);

        if (ch.kind === 'board') {
            if (ph.mode === 'riding' || ph.mode === 'arrived') return false;
            truncateAt(tAbs);
            const bs = ch.boardStop;
            plan.push({ type: 'walk', tStart: tAbs, tEnd: tAbs + ch.walkS,
                        fromLat: ph.lat, fromLon: ph.lon, toLat: bs.lat, toLon: bs.lon });
            plan.push({ type: 'wait', tStart: tAbs + ch.walkS, tEnd: ch.tDep,
                        lat: bs.lat, lon: bs.lon, stopG: bs.g });
            plan.push({ type: 'ride', ti: ch.ti, tBoard: ch.tDep, boardPos: ch.boardPos });
        } else {
            if (ph.mode !== 'riding' || ph.ride.ti !== (ch.fromTi ?? ch.ti)) return false;
            truncateAt(tAbs);   // garde le ride courant ouvert, retire la suite
            const ride = plan[plan.length - 1];
            ride.alightPos = ch.alightPos;
            ride.tAlight   = ch.tAlight;
            const alStop = stops[tripByIdx[ride.ti].seq[ch.alightPos].stop];
            if (ch.kind === 'final') {
                plan.push({ type: 'walk', tStart: ch.tAlight, tEnd: ch.tAlight + ch.egressWalkS,
                            fromLat: alStop.lat, fromLon: alStop.lon,
                            toLat: destination.lat, toLon: destination.lon, final: true });
            } else {
                const bs = ch.boardStop;
                plan.push({ type: 'walk', tStart: ch.tAlight, tEnd: ch.tAlight + ch.walkS,
                            fromLat: alStop.lat, fromLon: alStop.lon, toLat: bs.lat, toLon: bs.lon });
                plan.push({ type: 'wait', tStart: ch.tAlight + ch.walkS, tEnd: ch.tDep,
                            lat: bs.lat, lon: bs.lon, stopG: bs.g });
                plan.push({ type: 'ride', ti: ch.ti, tBoard: ch.tDep, boardPos: ch.boardPos });
            }
        }
        committedId = choiceId;
        invalidate();
        return true;
    }

    // ── Position du bonhomme (sprite 3D) ───────────────────────────────────
    function getPassenger(tAbs) {
        const ph = phaseAt(tAbs);
        const phase = { foot: 'pre', walking: 'walk', waiting: 'wait',
                        riding: 'bus', arrived: 'arrived' }[ph.mode];
        const trip = ph.mode === 'riding' ? tripByIdx[ph.ti] : null;
        return { lat: ph.lat, lon: ph.lon, phase,
                 line_id: trip?.lineId ?? null, trip_id: trip?.tripId ?? null };
    }

    function getPlanTripIds() {
        return plan.filter(l => l.type === 'ride').map(l => tripByIdx[l.ti].tripId);
    }

    return {
        origin, destination, departS,
        tripStarts, sigmaFn, evSig,
        nStops: stops.length, nTrips: trips.length,
        reset,
        getChoices,
        commit,
        getState: phaseAt,
        getPassenger,
        getPlanTripIds,
        get committedId() { return committedId; },
    };
}

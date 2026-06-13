// Couche de données Three.js-free : reconstruit les frames (cônes p10/p50/p90)
// à partir des horaires compacts des fichiers circuit + le modèle σ partagé.
//
// Rejeu déterministe de l'horaire planifié et du modèle d'incertitude défini par
// le simulateur — aucune nouvelle prédiction n'est inventée (voir DECISIONS.md §5).
// Testable sous Node (aucun import Three.js).

// ── Modèle d'incertitude σ(Δt) → secondes ─────────────────────────────────
export function makeSigma(model) {
    if (!model || model.kind === 'power') {
        const coeffMin = model?.coeff_min ?? 3.0;
        const exp      = model?.exp ?? 0.301;
        return (dt_s) => (dt_s <= 0 ? 0 : coeffMin * Math.pow(dt_s / 60, exp) * 60);
    }
    throw new Error(`Modèle σ inconnu : ${model.kind}`);
}

// ── Horaire planifié → fonction sched(t_abs) → progress_m (linéaire par morceaux) ──
// schedule = [{t_arr, t_dep, progress_m}] (sec depuis minuit), trié et monotone.
export function makeSched(schedule) {
    const pts = [];  // [t_abs, progress]
    for (const v of schedule) {
        let ta = v.t_arr;
        if (pts.length && ta <= pts[pts.length - 1][0]) ta = pts[pts.length - 1][0] + 0.001;
        pts.push([ta, v.progress_m]);
        if (v.t_dep > ta) pts.push([v.t_dep, v.progress_m]);  // palier durant l'arrêt
    }
    const tFirst = pts[0][0];
    const tLast  = pts[pts.length - 1][0];
    const pLast  = pts[pts.length - 1][1];

    const fn = (t) => {
        if (t <= tFirst) return 0.0;
        if (t >= tLast)  return pLast;  // reste au dernier arrêt, pas de saut à length_m
        let lo = 0, hi = pts.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (pts[mid][0] <= t) lo = mid; else hi = mid;
        }
        const [t1, p1] = pts[lo];
        const [t2, p2] = pts[hi];
        return t2 === t1 ? p1 : p1 + (p2 - p1) * (t - t1) / (t2 - t1);
    };
    return { fn, tFirst, tLast };
}

// ── Construction du cône prédit à partir de « maintenant » ────────────────
// nowAbs : maintenant en sec depuis minuit. nowRel : maintenant relatif à T0
// (référence des t de trajectoire pour l'axe vertical du renderer).
//
// tFirst (optionnel) : heure de départ planifiée du terminus. L'incertitude
// d'adhérence ne s'accumule qu'en roulant : ancrée à max(now, tFirst), pas à
// now. Un bus pas encore parti ne peut PAS être en avance (p90 = p50 au
// terminus) ; il peut seulement partir en léger retard (petit σ côté retard).
// Sans tFirst, comportement historique (σ symétrique ancré à now).
export const SIGMA_DEP_LATE_S = 60;   // retard plausible au départ du terminus

export function buildCone(sched, lengthM, nowAbs, nowRel, horizonS, stepS, sigmaFn, tFirst = -Infinity) {
    const anchor      = Math.max(nowAbs, tFirst);
    const notDeparted = nowAbs < tFirst;
    const pts = [];
    let prev = null;
    const n = Math.round(horizonS / stepS);
    for (let k = 0; k <= n; k++) {
        const dt = k * stepS;
        const tAbs = nowAbs + dt;
        let p50 = sched(tAbs);
        let p10, p90;
        if (k === 0) {
            p10 = p90 = p50;
        } else {
            const dtEff  = Math.max(0, tAbs - anchor);
            const s      = sigmaFn(dtEff);
            const sLate  = s + (notDeparted ? SIGMA_DEP_LATE_S : 0);
            const sEarly = s;     // nul au terminus (dtEff=0) : aucune avance possible
            p10 = sched(tAbs - sLate);    // en retard = moins avancé sur le tracé
            p90 = sched(tAbs + sEarly);   // en avance = plus avancé
        }
        // Invariants : bornes + ordre p10 ≤ p50 ≤ p90
        p50 = Math.min(Math.max(p50, 0), lengthM);
        p10 = Math.min(Math.max(p10, 0), p50);
        p90 = Math.min(Math.max(p90, p50), lengthM);
        // Monotonie non-décroissante vs point précédent
        if (prev) {
            p10 = Math.max(p10, prev[0]);
            p50 = Math.max(Math.max(p50, prev[1]), p10);
            p90 = Math.max(Math.max(p90, prev[2]), p50);
        }
        prev = [p10, p50, p90];
        pts.push({
            t: Math.round((nowRel + dt) * 1000) / 1000,
            p10: Math.round(p10 * 100) / 100,
            p50: Math.round(p50 * 100) / 100,
            p90: Math.round(p90 * 100) / 100,
        });
    }
    return pts;
}

// ── Modèle de scénario façonné comme un player (compatible index.html) ────
// args.index : CircuitIndex. args.circuits : [CircuitData] (fichiers chargés).
export function createScheduleModel({ index, circuits }) {
    const t0       = index.t0_seconds;
    const horizon  = index.horizon_s;
    const frameInt = index.frame_interval ?? 5.0;
    const step     = index.traj_step ?? 60.0;
    const sigmaFn  = makeSigma(index.sigma);

    // Pré-compiler les passages : sched + fenêtre temporelle absolue
    const vehicles = [];  // {vehicle_id, line_id, lengthM, sched, tFirst, tLast}
    const routes   = [];
    for (const c of circuits) {
        routes.push(c.route);
        const lengthM = c.route.length_m;
        for (const trip of c.trips) {
            const { fn, tFirst, tLast } = makeSched(trip.schedule);
            vehicles.push({
                vehicle_id: trip.trip_id,
                line_id: c.line_id,
                lengthM,
                sched: fn,
                tFirst,
                tLast,
            });
        }
    }

    let now = 0;            // sec relatif à T0, dans [0, horizon]
    let playing = false;
    let speed = 1.0;
    let cached = null;
    let cachedBucket = null;

    function buildFrame(nowRel) {
        const nowAbs = t0 + nowRel;
        const winHi = nowAbs + horizon;
        const out = [];
        for (const v of vehicles) {
            // Garder les passages actifs dans la fenêtre prédite [now, now+horizon]
            if (v.tLast < nowAbs || v.tFirst > winHi) continue;
            const traj = buildCone(v.sched, v.lengthM, nowAbs, nowRel, horizon, step, sigmaFn, v.tFirst);
            out.push({ vehicle_id: v.vehicle_id, line_id: v.line_id, trajectory: traj });
        }
        return { sim_time: nowRel, vehicles: out, transfers: [], passenger: null };
    }

    function refresh(force) {
        const bucket = Math.floor(now / frameInt);
        if (force || bucket !== cachedBucket || cached === null) {
            cached = buildFrame(now);
            cachedBucket = bucket;
            return true;
        }
        return false;
    }
    refresh(true);

    return {
        routes,
        t0Seconds: t0,
        horizonS: horizon,
        get frame() { return cached; },
        get simTime() { return now; },
        get isPlaying() { return playing; },

        play()  { playing = true; },
        pause() { playing = false; },
        setSpeed(s) { speed = Math.max(0.1, s); },

        next() { now = Math.min(horizon, now + frameInt); refresh(true); },
        prev() { now = Math.max(0, now - frameInt); refresh(true); },

        seekTo(t) { now = Math.min(horizon, Math.max(0, t)); refresh(true); },

        tick(wallDelta) {
            if (!playing) return false;
            now += wallDelta * speed;
            if (now >= horizon) { now = horizon; playing = false; }
            return refresh(false);
        },
    };
}

// ── Chargement : index + tous les fichiers circuit ────────────────────────
export async function loadCircuits(baseUrl = './data') {
    const idxResp = await fetch(`${baseUrl}/circuits_index.json`);
    if (!idxResp.ok) throw new Error(`circuits_index.json indisponible (HTTP ${idxResp.status})`);
    const index = await idxResp.json();
    const circuits = await Promise.all(
        index.circuits.map(async (e) => {
            const r = await fetch(`${baseUrl}/${e.file}`);
            if (!r.ok) throw new Error(`${e.file} indisponible (HTTP ${r.status})`);
            return r.json();
        }),
    );
    return { index, circuits };
}

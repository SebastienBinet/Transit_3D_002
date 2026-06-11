// Modèle de trajets (Cas 6 et futurs cas similaires) : charge un fichier
// journeys_caseN.json + les circuits STM, filtre les passages de bus nécessaires,
// construit les cônes d'incertitude et calcule la position de chaque passager
// à tout instant absolu tAbs pour une animation fluide (mise à jour au RAF).
//
// Interface identique à createScheduleModel (compatible player dans index.html),
// avec en plus getPassengerPositions(tAbs) pour les mises à jour continues.

import { makeSched, makeSigma, buildCone } from './scenario-model.js';
import { progressToLatLon }               from './interpolation.js';
import { JOURNEY_COLORS }                 from './colors.js';

export function createJourneyModel({ journeysData, circuits }) {
    const t0      = journeysData.depart_after_s;
    const sigmaFn = makeSigma({ kind: 'power', coeff_min: 3.0, exp: 0.301 });
    const STEP    = 60;

    // Horizon = jusqu'à 5 min après l'arrivée du dernier trajet
    const lastArrival = Math.max(...journeysData.journeys.map(j => j.arrival_s));
    const horizonS    = Math.ceil(lastArrival - t0) + 300;

    // ── Trips nécessaires ────────────────────────────────────────────────
    const neededIds = new Set();
    for (const jr of journeysData.journeys) {
        for (const leg of jr.legs) {
            if (leg.type === 'bus') neededIds.add(leg.trip_id);
        }
    }

    // ── Construire vehicles + tripData depuis les circuits ───────────────
    const routes   = [];
    const vehicles = [];                        // pour buildFrame (cônes)
    const tripData = new Map();                 // trip_id → {sched, shape, line_id, …}
    const seenLine = new Set();

    for (const circ of circuits) {
        const relevant = circ.trips.filter(t => neededIds.has(t.trip_id));
        if (!relevant.length) continue;
        if (!seenLine.has(circ.line_id)) {
            routes.push(circ.route);
            seenLine.add(circ.line_id);
        }
        const lengthM = circ.route.length_m;
        for (const trip of relevant) {
            const { fn, tFirst, tLast } = makeSched(trip.schedule);
            tripData.set(trip.trip_id, {
                sched: fn, tFirst, tLast, lengthM,
                shape: circ.route.shape, line_id: circ.line_id,
            });
            vehicles.push({ vehicle_id: trip.trip_id, line_id: circ.line_id,
                            lengthM, sched: fn, tFirst, tLast });
        }
    }

    // ── Position d'un passager à tAbs (sec depuis minuit) ───────────────
    // Retourne {lat, lon, phase, line_id, trip_id} ou null hors plage.
    function passengerPos(journey, tAbs) {
        for (const leg of journey.legs) {
            if (tAbs < leg.depart_s || tAbs > leg.arrive_s) continue;
            if (leg.type === 'walk' || leg.type === 'wait') {
                const span = leg.arrive_s - leg.depart_s;
                const r    = span > 0 ? (tAbs - leg.depart_s) / span : 0;
                const lat  = leg.from_lat + r * (leg.to_lat - leg.from_lat);
                const lon  = leg.from_lon + r * (leg.to_lon - leg.from_lon);
                return { lat, lon, phase: leg.type, line_id: null, trip_id: null };
            }
            if (leg.type === 'bus') {
                const td = tripData.get(leg.trip_id);
                if (!td) return null;
                const ll = progressToLatLon(td.sched(tAbs), td.shape);
                if (!ll) return null;
                return { lat: ll.lat, lon: ll.lon, phase: 'bus',
                         line_id: leg.line_id, trip_id: leg.trip_id };
            }
        }
        // Hors de toutes les jambes : avant départ ou après arrivée
        const firstDep = journey.legs[0]?.depart_s ?? Infinity;
        if (tAbs < firstDep) {
            return { lat: journeysData.origin.lat, lon: journeysData.origin.lon,
                     phase: 'pre', line_id: null, trip_id: null };
        }
        return { lat: journeysData.destination.lat, lon: journeysData.destination.lon,
                 phase: 'arrived', line_id: null, trip_id: null };
    }

    // Pour chaque trajet : liste des trip_id qui restent à prendre (utile pour
    // que le renderer sache quels trajets sont "planifiés mais pas encore pris").
    function plannedTrips(journey, tAbs) {
        const out = [];
        for (const leg of journey.legs) {
            if (leg.type === 'bus' && leg.board_s > tAbs) out.push(leg.trip_id);
        }
        return out;
    }

    // ── Frame ─────────────────────────────────────────────────────────────
    function buildFrame(nowRel) {
        const nowAbs = t0 + nowRel;
        const winHi  = nowAbs + horizonS;
        const vehicleFrames = [];
        for (const v of vehicles) {
            if (v.tLast < nowAbs || v.tFirst > winHi) continue;
            const traj = buildCone(v.sched, v.lengthM, nowAbs, nowRel, horizonS, STEP, sigmaFn, v.tFirst);
            vehicleFrames.push({ vehicle_id: v.vehicle_id, line_id: v.line_id, trajectory: traj });
        }
        const passengers = journeysData.journeys.map((jr, i) => ({
            journey_id:    jr.rank,
            journey_idx:   i,
            color:         JOURNEY_COLORS[i % JOURNEY_COLORS.length],
            planned_trips: plannedTrips(jr, nowAbs),
            ...(passengerPos(jr, nowAbs) ?? {
                lat: journeysData.origin.lat, lon: journeysData.origin.lon,
                phase: 'pre', line_id: null, trip_id: null,
            }),
        }));
        return { sim_time: nowRel, vehicles: vehicleFrames, passengers, transfers: [] };
    }

    // ── Player state ──────────────────────────────────────────────────────
    let now = 0;
    let playing = false;
    let speed = 1.0;
    let cached = null;
    let cachedBucket = null;
    const frameInt = 5.0;

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

    // Heure de départ du terminus par trip — sert à ancrer l'incertitude
    // (un bus pas encore parti ne peut pas être en avance).
    const tripStarts = {};
    for (const [tid, td] of tripData) tripStarts[tid] = td.tFirst;

    return {
        routes,
        t0Seconds: t0,
        horizonS,
        tripStarts,
        get frame()     { return cached; },
        get simTime()   { return now; },
        get isPlaying() { return playing; },

        play()         { playing = true; },
        pause()        { playing = false; },
        setSpeed(s)    { speed = Math.max(0.1, s); },
        next()         { now = Math.min(horizonS, now + frameInt); refresh(true); },
        prev()         { now = Math.max(0, now - frameInt); refresh(true); },
        seekTo(t)      { now = Math.min(horizonS, Math.max(0, t)); refresh(true); },
        tick(wallDelta) {
            if (!playing) return false;
            now += wallDelta * speed;
            if (now >= horizonS) { now = horizonS; playing = false; }
            return refresh(false);
        },

        // Positions interpolées en temps continu (appelé au RAF, indépendamment
        // du pas de frame) pour que les sprites de passagers bougent en douceur.
        getPassengerPositions(tAbs) {
            return journeysData.journeys.map((jr, i) => ({
                journey_id: jr.rank,
                color: JOURNEY_COLORS[i % JOURNEY_COLORS.length],
                ...(passengerPos(jr, tAbs) ?? {
                    lat: journeysData.origin.lat, lon: journeysData.origin.lon,
                    phase: 'pre', line_id: null, trip_id: null,
                }),
            }));
        },
    };
}

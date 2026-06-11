import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSigma, makeSched, buildCone, createScheduleModel }
    from '../../web/js/scenario-model.js';

// ── makeSigma ─────────────────────────────────────────────────────────────
test('σ(0) = 0', () => {
    const s = makeSigma({ kind: 'power', coeff_min: 3.0, exp: 0.301 });
    assert.equal(s(0), 0);
});

test('σ(60 s) = 180 s (3 min)', () => {
    const s = makeSigma({ kind: 'power', coeff_min: 3.0, exp: 0.301 });
    assert.ok(Math.abs(s(60) - 180) < 0.001, `reçu ${s(60)}`);
});

test('σ croît avec Δt', () => {
    const s = makeSigma({ kind: 'power', coeff_min: 3.0, exp: 0.301 });
    assert.ok(s(600) > s(60));
    assert.ok(s(3600) > s(600));
});

// ── makeSched ─────────────────────────────────────────────────────────────
const schedule = [
    { t_arr: 100, t_dep: 110, progress_m: 0 },
    { t_arr: 200, t_dep: 200, progress_m: 500 },
];

test('sched : 0 avant le premier arrêt', () => {
    const { fn } = makeSched(schedule);
    assert.equal(fn(50), 0);
});

test('sched : palier durant l\'arrêt (dwell)', () => {
    const { fn } = makeSched(schedule);
    assert.equal(fn(105), 0);   // entre t_arr=100 et t_dep=110, progress reste 0
});

test('sched : interpolation linéaire entre arrêts', () => {
    const { fn } = makeSched(schedule);
    // entre (110, 0) et (200, 500) : t=155 → 250
    assert.ok(Math.abs(fn(155) - 250) < 1e-6, `reçu ${fn(155)}`);
});

test('sched : reste au dernier arrêt après la fin (pas de saut à length_m)', () => {
    const { fn } = makeSched(schedule);
    assert.equal(fn(9999), 500);
});

test('makeSched expose tFirst / tLast', () => {
    const { tFirst, tLast } = makeSched(schedule);
    assert.equal(tFirst, 100);
    assert.equal(tLast, 200);
});

// ── buildCone : invariants de trajectoire ─────────────────────────────────
const sigmaFn = makeSigma({ kind: 'power', coeff_min: 3.0, exp: 0.301 });

test('buildCone : premier point p10=p50=p90 (certitude à t=0)', () => {
    const { fn } = makeSched(schedule);
    const traj = buildCone(fn, 500, 100, 0, 120, 60, sigmaFn);
    assert.equal(traj[0].p10, traj[0].p50);
    assert.equal(traj[0].p50, traj[0].p90);
});

test('buildCone : p10 ≤ p50 ≤ p90 partout', () => {
    const { fn } = makeSched(schedule);
    const traj = buildCone(fn, 500, 100, 0, 120, 60, sigmaFn);
    for (const pt of traj) {
        assert.ok(pt.p10 <= pt.p50, `p10 ${pt.p10} > p50 ${pt.p50}`);
        assert.ok(pt.p50 <= pt.p90, `p50 ${pt.p50} > p90 ${pt.p90}`);
    }
});

test('buildCone : progression non-décroissante (p10, p50, p90)', () => {
    const { fn } = makeSched(schedule);
    const traj = buildCone(fn, 500, 100, 0, 120, 60, sigmaFn);
    for (let i = 1; i < traj.length; i++) {
        assert.ok(traj[i].p10 >= traj[i - 1].p10);
        assert.ok(traj[i].p50 >= traj[i - 1].p50);
        assert.ok(traj[i].p90 >= traj[i - 1].p90);
    }
});

test('buildCone : t strictement croissant et relatif à nowRel', () => {
    const { fn } = makeSched(schedule);
    const traj = buildCone(fn, 500, 100, 7, 120, 60, sigmaFn);
    assert.equal(traj[0].t, 7);           // nowRel
    for (let i = 1; i < traj.length; i++) {
        assert.ok(traj[i].t > traj[i - 1].t);
    }
});

test('buildCone : borné par length_m', () => {
    const { fn } = makeSched(schedule);
    const traj = buildCone(fn, 500, 100, 0, 600, 60, sigmaFn);
    for (const pt of traj) assert.ok(pt.p90 <= 500);
});

// ── buildCone avec tFirst : incertitude ancrée au départ du terminus ──────
// Horaire long : départ tFirst=1000, vitesse 1 m/s pendant 1000 s.
const farSchedule = [
    { t_arr: 1000, t_dep: 1000, progress_m: 0 },
    { t_arr: 2000, t_dep: 2000, progress_m: 1000 },
];

test('buildCone+tFirst : bus pas parti → cône plus étroit que le modèle ancré à now', () => {
    const { fn, tFirst } = makeSched(farSchedule);
    // now=100, départ à t=1000 : l'ancien modèle accumule σ(900+) au départ
    const oldTraj = buildCone(fn, 1000, 100, 0, 1800, 60, sigmaFn);
    const newTraj = buildCone(fn, 1000, 100, 0, 1800, 60, sigmaFn, tFirst);
    // Comparer la largeur du cône à t = 1060 (60 s après le départ planifié)
    const oldPt = oldTraj.find(p => p.t === 960);
    const newPt = newTraj.find(p => p.t === 960);
    assert.ok(newPt.p90 - newPt.p10 < oldPt.p90 - oldPt.p10,
        `nouveau ${newPt.p90 - newPt.p10} ≥ ancien ${oldPt.p90 - oldPt.p10}`);
});

test('buildCone+tFirst : aucune avance possible au départ du terminus (p90 = p50)', () => {
    const { fn, tFirst } = makeSched(farSchedule);
    const traj = buildCone(fn, 1000, 100, 0, 1800, 60, sigmaFn, tFirst);
    // Au point juste après le départ planifié (t=960 abs=1060) : σ_early=σ(60)
    // borne p90 ; au départ même (t=900 abs=1000), p90 = p50 = 0.
    const atDep = traj.find(p => p.t === 900);
    assert.equal(atDep.p90, atDep.p50, 'p90 devrait égaler p50 au départ');
});

test('buildCone+tFirst : invariants conservés (p10 ≤ p50 ≤ p90, monotonie)', () => {
    const { fn, tFirst } = makeSched(farSchedule);
    const traj = buildCone(fn, 1000, 100, 0, 1800, 60, sigmaFn, tFirst);
    for (let i = 0; i < traj.length; i++) {
        const pt = traj[i];
        assert.ok(pt.p10 <= pt.p50 && pt.p50 <= pt.p90);
        if (i > 0) {
            assert.ok(pt.p10 >= traj[i - 1].p10);
            assert.ok(pt.p50 >= traj[i - 1].p50);
            assert.ok(pt.p90 >= traj[i - 1].p90);
        }
    }
});

test('buildCone sans tFirst : comportement historique inchangé', () => {
    const { fn } = makeSched(schedule);
    const a = buildCone(fn, 500, 100, 0, 120, 60, sigmaFn);
    const b = buildCone(fn, 500, 100, 0, 120, 60, sigmaFn, -Infinity);
    assert.deepEqual(a, b);
});

// ── createScheduleModel : interface player ────────────────────────────────
function makeIndexAndCircuits(t0) {
    const index = {
        t0_seconds: t0,
        horizon_s: 120,
        frame_interval: 10,
        traj_step: 60,
        sigma: { kind: 'power', coeff_min: 3.0, exp: 0.301 },
        circuits: [{ line_id: 'T', file: 'circuits/T.json', n_trips: 2 }],
    };
    const circuits = [{
        line_id: 'T',
        gtfs_direction_id: null,
        route: { line_id: 'T', stops: [], shape: [
            { lat: 45.50, lon: -73.65 }, { lat: 45.50, lon: -73.60 }], length_m: 500 },
        trips: [
            { trip_id: 'early', schedule: [
                { t_arr: t0 + 100, t_dep: t0 + 110, progress_m: 0 },
                { t_arr: t0 + 200, t_dep: t0 + 200, progress_m: 500 }] },
            { trip_id: 'late', schedule: [
                { t_arr: t0 + 5000, t_dep: t0 + 5010, progress_m: 0 },
                { t_arr: t0 + 5100, t_dep: t0 + 5100, progress_m: 500 }] },
        ],
    }];
    return { index, circuits };
}

test('model : expose routes', () => {
    const model = createScheduleModel(makeIndexAndCircuits(1000));
    assert.equal(model.routes.length, 1);
    assert.equal(model.routes[0].line_id, 'T');
});

test('model : expose t0Seconds et horizonS (heure locale + grille temporelle)', () => {
    const model = createScheduleModel(makeIndexAndCircuits(25200));
    assert.equal(model.t0Seconds, 25200);   // 07:00:00
    assert.equal(model.horizonS, 120);
    // heure locale = t0 + simTime ; à sim 0 → 07:00:00
    assert.equal(model.t0Seconds + model.simTime, 25200);
});

test('model : frame initiale à sim_time 0, seuls les passages actifs présents', () => {
    const model = createScheduleModel(makeIndexAndCircuits(1000));
    const f = model.frame;
    assert.equal(f.sim_time, 0);
    // 'early' (t0+100..t0+200) chevauche [now, now+120] ; 'late' (t0+5000) non.
    const ids = f.vehicles.map(v => v.vehicle_id);
    assert.deepEqual(ids, ['early']);
});

test('model : tick avance le temps et rafraîchit', () => {
    const model = createScheduleModel(makeIndexAndCircuits(1000));
    model.play();
    const changed = model.tick(15);   // dépasse frame_interval=10
    assert.ok(changed);
    assert.ok(Math.abs(model.simTime - 15) < 1e-9);
});

test('model : seekTo borne dans [0, horizon]', () => {
    const model = createScheduleModel(makeIndexAndCircuits(1000));
    model.seekTo(9999);
    assert.equal(model.simTime, 120);
    model.seekTo(-50);
    assert.equal(model.simTime, 0);
});

test('model : tick s\'arrête en fin d\'horizon', () => {
    const model = createScheduleModel(makeIndexAndCircuits(1000));
    model.play();
    model.tick(200);
    assert.equal(model.simTime, 120);
    assert.equal(model.isPlaying, false);
});

test('model : un circuit sans passage garde sa route mais n\'ajoute aucun véhicule', () => {
    const { index, circuits } = makeIndexAndCircuits(1000);
    // Ajouter un circuit 480N sans aucun passage (trips vide)
    circuits.push({
        line_id: '480N', gtfs_direction_id: '0',
        route: { line_id: '480N', stops: [], shape: [
            { lat: 45.55, lon: -73.62 }, { lat: 45.58, lon: -73.60 }], length_m: 3000 },
        trips: [],
    });
    const model = createScheduleModel({ index, circuits });
    // La route 480N est présente (la ligne reste dessinée)
    assert.ok(model.routes.some(r => r.line_id === '480N'));
    // Aucun véhicule 480N à aucun instant
    model.seekTo(0);
    assert.ok(!model.frame.vehicles.some(v => v.line_id === '480N'));
});

test('model : un passage hors fenêtre n\'apparaît pas', () => {
    // t0 tel que 'late' (t0+5000) reste hors de [now, now+120] pour now ∈ [0,120]
    const model = createScheduleModel(makeIndexAndCircuits(0));
    model.seekTo(120);
    const ids = model.frame.vehicles.map(v => v.vehicle_id);
    assert.ok(!ids.includes('late'), `late ne devrait pas être actif : ${ids}`);
});

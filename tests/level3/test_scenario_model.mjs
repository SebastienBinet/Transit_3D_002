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

test('model : un passage hors fenêtre n\'apparaît pas', () => {
    // t0 tel que 'late' (t0+5000) reste hors de [now, now+120] pour now ∈ [0,120]
    const model = createScheduleModel(makeIndexAndCircuits(0));
    model.seekTo(120);
    const ids = model.frame.vehicles.map(v => v.vehicle_id);
    assert.ok(!ids.includes('late'), `late ne devrait pas être actif : ${ids}`);
});

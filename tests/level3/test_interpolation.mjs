import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpolate, progressToLatLon, estimateArrival } from '../../web/js/interpolation.js';

const traj = [
    { t: 0,   p10: 0,   p50: 0,   p90: 0   },
    { t: 60,  p10: 50,  p50: 100, p90: 150  },
    { t: 120, p10: 120, p50: 200, p90: 280  },
];

test('interpolate retourne le premier point pour t ≤ t0', () => {
    const r = interpolate(traj, -10);
    assert.equal(r.p50, 0);
});

test('interpolate retourne le dernier point pour t ≥ tN', () => {
    const r = interpolate(traj, 999);
    assert.equal(r.p50, 200);
});

test('interpolate à mi-chemin entre deux points', () => {
    const r = interpolate(traj, 30);
    assert.equal(r.p50, 50);
    assert.equal(r.p10, 25);
    assert.equal(r.p90, 75);
});

test('interpolate à l\'exactement un point connu', () => {
    const r = interpolate(traj, 60);
    assert.equal(r.p50, 100);
    assert.equal(r.p10, 50);
    assert.equal(r.p90, 150);
});

// estimateArrival — trajectoire à pas de 60 s, seuil entre deux points
const trajArr = [
    { t: 100, p50: 0   },
    { t: 160, p50: 600 },
    { t: 220, p50: 970 },
    { t: 280, p50: 970 },
];
const routeLen = 1000;

test('estimateArrival interpole sans sauter au step du simulateur', () => {
    // nearEnd = 970 ; pt[2] est le premier point ≥ 970
    // r = (970 - 600) / (970 - 600) = 1.0 → t = 160 + 1.0*60 = 220
    const t = estimateArrival(trajArr, routeLen);
    assert.ok(Math.abs(t - 220) < 0.001, `attendu 220, reçu ${t}`);
});

test('estimateArrival interpole au milieu de l\'intervalle', () => {
    // nearEnd = 300 ; pt[1] est le premier point ≥ 300 (p50=600)
    // r = (300 - 0) / (600 - 0) = 0.5 → t = 100 + 0.5*60 = 130
    const t = estimateArrival([
        { t: 100, p50: 0   },
        { t: 160, p50: 600 },
    ], 300 / 0.97);
    assert.ok(Math.abs(t - 130) < 0.1, `attendu ≈130, reçu ${t}`);
});

test('estimateArrival est stable entre frames — pas de saut de 60 s (TRAJ_STEP)', () => {
    // Véhicule lent : v=1 m/s, départ t=0, route_len=5000, nearEnd=4850.
    // t_exact = 4850 / 1 = 4850 s. Les trajectoires ont des points à T, T+60, T+120, …
    // Sans interpolation : tArrival saute de ~60 s toutes les 60 frames.
    // Avec interpolation : la valeur change de ~1 s par frame (stable).
    function makeTraj(T, v, tDep, routeLen, steps) {
        const pts = [];
        for (let k = 0; k <= steps; k++) {
            const t = T + k * 60;
            pts.push({ t, p50: Math.min(v * (t - tDep), routeLen) });
        }
        return pts;
    }
    const v = 1, tDep = 0, routeLen = 5000, steps = 30;
    // Vérifie la stabilité sur 120 frames consécutives, loin de l'arrivée
    for (let T = 100; T < 220; T++) {
        const tA = estimateArrival(makeTraj(T,     v, tDep, routeLen, steps), routeLen);
        const tB = estimateArrival(makeTraj(T + 1, v, tDep, routeLen, steps), routeLen);
        const delta = Math.abs(tB - tA);
        assert.ok(delta < 2, `saut de ${delta.toFixed(2)} s entre T=${T} et T=${T+1}`);
    }
});

// shape simple : segment unique est-ouest
const LAT_M = 111_000;
const lat0 = 45.50;
const lonM = LAT_M * Math.cos(lat0 * Math.PI / 180);
const shape = [
    { lat: lat0, lon: -73.650 },
    { lat: lat0, lon: -73.640 },
];
const segLen = 0.01 * lonM;  // ≈ 779 m

test('progressToLatLon retourne le début à progress=0', () => {
    const ll = progressToLatLon(0, shape);
    assert.equal(ll.lat, lat0);
    assert.equal(ll.lon, -73.650);
});

test('progressToLatLon retourne la fin au-delà de la longueur du segment', () => {
    const ll = progressToLatLon(99999, shape);
    assert.equal(ll.lat, lat0);
    assert.equal(ll.lon, -73.640);
});

test('progressToLatLon interpole à mi-segment', () => {
    const ll = progressToLatLon(segLen / 2, shape);
    assert.ok(Math.abs(ll.lon - (-73.645)) < 1e-4, `lon attendu ≈ -73.645, reçu ${ll.lon}`);
    assert.equal(ll.lat, lat0);
});

test('progressToLatLon à la fin du segment', () => {
    const ll = progressToLatLon(segLen, shape);
    assert.ok(Math.abs(ll.lon - (-73.640)) < 1e-4);
});

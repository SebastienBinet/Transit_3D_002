import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpolate, progressToLatLon } from '../../web/js/interpolation.js';

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

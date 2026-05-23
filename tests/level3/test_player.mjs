import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayer } from '../../web/js/player.js';

const frames = [
    { sim_time: 0, vehicles: [] },
    { sim_time: 5, vehicles: [] },
    { sim_time: 10, vehicles: [] },
];

test('démarre à la première frame', () => {
    const p = createPlayer(frames);
    assert.equal(p.frame.sim_time, 0);
});

test('next avance à la frame suivante', () => {
    const p = createPlayer(frames);
    p.next();
    assert.equal(p.frame.sim_time, 5);
});

test('prev ne recule pas avant la première frame', () => {
    const p = createPlayer(frames);
    p.prev();
    assert.equal(p.frame.sim_time, 0);
});

test('next ne dépasse pas la dernière frame', () => {
    const p = createPlayer(frames);
    p.next(); p.next(); p.next();
    assert.equal(p.frame.sim_time, 10);
});

test('seekTo positionne sur la dernière frame ≤ simTime', () => {
    const p = createPlayer(frames);
    p.seekTo(7);
    assert.equal(p.frame.sim_time, 5);
});

test('seekTo avant le début reste à la première frame', () => {
    const p = createPlayer(frames);
    p.seekTo(-1);
    assert.equal(p.frame.sim_time, 0);
});

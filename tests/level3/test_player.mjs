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

test('tick ne joue pas si en pause', () => {
    const p = createPlayer(frames);
    p.tick(100);
    assert.equal(p.frame.sim_time, 0);
});

test('tick avance d\'une frame quand simDelta dépasse l\'intervalle', () => {
    const p = createPlayer(frames);
    p.play();
    p.setSpeed(1);
    const changed = p.tick(6);
    assert.equal(changed, true);
    assert.equal(p.frame.sim_time, 5);
});

test('tick ne change pas de frame si simDelta insuffisant', () => {
    const p = createPlayer(frames);
    p.play();
    p.setSpeed(1);
    const changed = p.tick(3);
    assert.equal(changed, false);
    assert.equal(p.frame.sim_time, 0);
});

test('tick respecte le multiplicateur de vitesse', () => {
    const p = createPlayer(frames);
    p.play();
    p.setSpeed(2);
    p.tick(3);  // wall=3s × speed=2 → simDelta=6 → frame sim_time=5
    assert.equal(p.frame.sim_time, 5);
});

test('pause arrête l\'avance', () => {
    const p = createPlayer(frames);
    p.play();
    p.pause();
    p.tick(100);
    assert.equal(p.frame.sim_time, 0);
});

test('isPlaying reflète l\'état play/pause', () => {
    const p = createPlayer(frames);
    assert.equal(p.isPlaying, false);
    p.play();
    assert.equal(p.isPlaying, true);
    p.pause();
    assert.equal(p.isPlaying, false);
});

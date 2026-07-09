// Tests L3 (Cas 7 — mode cohorte) : getCohort décompose de façon DÉTERMINISTE
// (quantiles + plus grand reste, aucune RNG) 1000 voyageurs sur les choix de
// premier départ, puis sur leurs réalisations. Respecte l'invariant « pas de
// Monte Carlo » : deux appels identiques donnent exactement la même cohorte.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createChoiceEngine } from '../../web/js/choice-engine.js';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'data');

function loadCircuits() {
    const index = JSON.parse(readFileSync(path.join(DATA, 'circuits_index.json'), 'utf-8'));
    const circuits = index.circuits.map(e =>
        JSON.parse(readFileSync(path.join(DATA, e.file), 'utf-8')));
    return { index, circuits };
}

const { index, circuits } = loadCircuits();
const T0 = 25200;   // 7h00

function makeEngine() {
    return createChoiceEngine({
        circuits,
        sigma: index.sigma,
        originLines: ['51', '66'],
        destLines:   ['480', '144'],
        departS: T0,
    });
}

// ── La cohorte existe et pèse ~1000 ────────────────────────────────────────
test('cohorte : ~1000 agents, chacun avec un trajet', () => {
    const eng = makeEngine();
    const cohort = eng.getCohort(T0, { size: 1000 });
    assert.ok(cohort, 'cohorte nulle à 7h00');
    assert.ok(cohort.agents.length >= 990 && cohort.agents.length <= 1000,
        `attendu ~1000 agents, reçu ${cohort.agents.length}`);
    for (const a of cohort.agents) {
        assert.ok(a.path && typeof a.path.sampleAbs === 'function', 'agent sans trajet échantillonnable');
        assert.ok(Number.isFinite(a.delayS), 'delayS non fini');
        assert.ok(a.reliability >= 0 && a.reliability <= 1, `reliability hors [0,1] : ${a.reliability}`);
        assert.equal(a.rerouted, a.realIdx > 0, 'rerouted doit valoir realIdx>0');
        assert.ok(typeof a.lineId === 'string' && a.lineId.length, 'lineId manquant (teinte = 1er bus)');
    }
});

// ── Répartition uniforme 1/N sur les choix ─────────────────────────────────
test('cohorte : répartition uniforme 1/N (écart ≤ 1)', () => {
    const eng = makeEngine();
    const cohort = eng.getCohort(T0, { size: 1000 });
    const perChoice = new Map();
    for (const a of cohort.agents) perChoice.set(a.choiceIdx, (perChoice.get(a.choiceIdx) ?? 0) + 1);
    const counts = [...perChoice.values()];
    assert.equal(perChoice.size, cohort.nChoices, 'chaque choix doit avoir des agents');
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1,
        `répartition non uniforme : ${counts.join(', ')}`);
    // 1/N ± reste : chaque part vaut floor(1000/N) ou +1
    const base = Math.floor(1000 / cohort.nChoices);
    for (const c of counts) assert.ok(c === base || c === base + 1, `part ${c} ≠ ${base}/${base + 1}`);
});

// ── Déterminisme : aucun tirage aléatoire ──────────────────────────────────
test('cohorte : déterministe (deux appels identiques)', () => {
    const eng = makeEngine();
    const view = c => c.agents.map(a =>
        [a.choiceIdx, a.realIdx, a.rerouted, a.reliability, Math.round(a.delayS * 1e3)]);
    const a = view(eng.getCohort(T0, { size: 1000 }));
    const b = view(eng.getCohort(T0, { size: 1000 }));
    assert.deepEqual(a, b, 'la cohorte varie entre deux appels → RNG interdite');
});

// ── Étalement en quantiles p10..p90 (un à p10, un à p90) ────────────────────
test('cohorte : delayS croissant et symétrique dans chaque réalisation', () => {
    const eng = makeEngine();
    const cohort = eng.getCohort(T0, { size: 1000 });
    // regrouper par (choix, réalisation)
    const groups = new Map();
    for (const a of cohort.agents) {
        const k = a.choiceIdx + ':' + a.realIdx;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(a.delayS);
    }
    let sawSpread = false;
    for (const delays of groups.values()) {
        if (delays.length < 2) continue;
        for (let i = 1; i < delays.length; i++)
            assert.ok(delays[i] >= delays[i - 1], 'delayS doit croître avec le rang (quantiles)');
        // p10 < 0 < p90 : le premier part en avance, le dernier en retard
        assert.ok(delays[0] < 0 && delays[delays.length - 1] > 0,
            `étalement non centré : [${delays[0]}, ${delays[delays.length - 1]}]`);
        sawSpread = true;
    }
    assert.ok(sawSpread, 'aucun groupe étalé — étalement en quantiles absent');
});

// ── Enveloppe de vague cohérente ───────────────────────────────────────────
test('cohorte : enveloppe de vague cohérente (base = min, fin ≈ p96)', () => {
    const eng = makeEngine();
    const cohort = eng.getCohort(T0, { size: 1000 });
    for (const a of cohort.agents)
        assert.ok(cohort.baseStartS <= a.path.startS + a.delayS + 1e-6, 'baseStartS trop grand');
    // waveEndS = p96 des arrivées : couvre ≥ 90 % des agents, borne le pacing
    // (un rare traînard peut la dépasser).
    const covered = cohort.agents.filter(a => a.path.endS + a.delayS <= cohort.waveEndS + 1e-6).length;
    assert.ok(covered >= 0.9 * cohort.agents.length,
        `waveEndS ne couvre que ${covered}/${cohort.agents.length} agents`);
    assert.ok(cohort.waveEndS > cohort.baseStartS, 'vague de durée nulle');
});

// ── Le paquet se scinde aux correspondances risquées (reroute) ─────────────
test('cohorte : au moins une correspondance risquée fait diverger des agents', () => {
    const eng = makeEngine();
    const cohort = eng.getCohort(T0, { size: 1000 });
    const rerouted = cohort.agents.filter(a => a.rerouted).length;
    // Le récit de référence : la 51 (correspondance 165 serrée) scinde son paquet.
    assert.ok(rerouted > 0, 'aucun agent rerouté — la scission aux transferts a disparu');
    // Cohérence : realIdx borné par le nombre de réalisations du choix.
    const maxReal = new Map();
    for (const a of cohort.agents) maxReal.set(a.choiceIdx, Math.max(maxReal.get(a.choiceIdx) ?? 0, a.realIdx));
    for (const a of cohort.agents) assert.ok(a.realIdx <= maxReal.get(a.choiceIdx));
});

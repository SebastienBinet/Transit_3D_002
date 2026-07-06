// Tests L3 + récit (Cas 7) : moteur de choix contre les VRAIES données circuit
// (web/data/circuits/*.json). Le récit de référence (décisions du porteur) :
//   - à 7h00, l'usager a (au moins) trois choix : attendre la 51 (départ 7h05:41),
//     attendre la 66 (7h10:44), marcher vers la 103 (départ 7h11:14, marche ≈ 125 s) ;
//   - s'il ne choisit pas, la 51 part → le choix meurt et un remplaçant
//     (la 51 suivante, 7h10:41) apparaît ;
//   - la marche vers la 103 glisse avec « maintenant » puis expire quand il n'y a
//     plus le temps de marcher (≈ 7h09:09) ;
//   - la 66 part à son tour (7h10:44) ;
//   - engagé dans un choix, l'usager peut changer d'idée depuis sa position courante.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createChoiceEngine, computeChoiceCdf, makeEventSigmas, distM }
    from '../../web/js/choice-engine.js';
import { makeSigma } from '../../web/js/scenario-model.js';

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

// Départ p50 de référence (mêmes horaires que journeys_case6.json)
const DEP_51  = 25541;   // 7h05:41 — 51N à l'arrêt 50828
const DEP_66  = 25844;   // 7h10:44 — 66N à l'arrêt 50752
const DEP_103 = 25874;   // 7h11:14 — 103N à l'arrêt 50798 (marche ≈ 125 s)

// ── Récit : les trois choix initiaux ───────────────────────────────────────
test('récit : à 7h00, choix 51 / 66 / 103 présents (≤ 4 choix)', () => {
    const eng = makeEngine();
    const choices = eng.getChoices(T0);
    assert.ok(choices.length >= 3 && choices.length <= 4,
        `attendu 3-4 choix, reçu ${choices.length} : ${choices.map(c => c.id)}`);
    const byLine = Object.fromEntries(choices.map(c => [c.lineId, c]));
    assert.ok(byLine['51N'], 'choix 51N manquant');
    assert.ok(byLine['66N'], 'choix 66N manquant');
    assert.ok(byLine['103N'], 'choix 103N manquant');
    // Mêmes passages (trips) que le Cas 6 ; l'arrêt d'embarquement peut être un
    // arrêt en amont (marche minimale), donc l'heure peut précéder de peu.
    assert.equal(byLine['51N'].tripId,  '295364460');
    assert.equal(byLine['66N'].tripId,  '295424458');
    assert.equal(byLine['103N'].tripId, '295372023');
    assert.ok(Math.abs(byLine['51N'].tDep  - DEP_51)  < 360);
    assert.ok(Math.abs(byLine['66N'].tDep  - DEP_66)  < 360);
    assert.ok(Math.abs(byLine['103N'].tDep - DEP_103) < 360);
    // Ordre des expirations du récit : la 51 part, puis la marche vers la 103
    // devient impossible, puis la 66 part.
    assert.ok(byLine['51N'].expiresS < byLine['103N'].expiresS);
    assert.ok(byLine['103N'].expiresS < byLine['66N'].expiresS);
    // Marche vers la 103 : le choix « long » du récit (l'arrêt le plus proche de
    // la 103N est à 363 m de l'origine → ≈ 259 s). Les 51/66 sont au coin (< 30 s).
    // NB : le Cas 6 affichait 125 s car sa marche d'accès était mesurée vers
    // l'arrêt-graine le plus proche, pas vers l'arrêt d'embarquement réel.
    assert.ok(byLine['103N'].walkS > 100 && byLine['103N'].walkS < 300,
        `marche 103 attendue ≈ 259 s, reçue ${byLine['103N'].walkS}`);
    assert.ok(byLine['66N'].walkS < 30, `marche 66 attendue ≈ 13 s, reçue ${byLine['66N'].walkS}`);
    assert.ok(byLine['51N'].walkS < 30, `marche 51 attendue ≈ 19 s, reçue ${byLine['51N'].walkS}`);
});

test('récit : meilleure arrivée initiale ≈ 7h55:37 (cohérent avec le Cas 6)', () => {
    const eng = makeEngine();
    const best = Math.min(...eng.getChoices(T0).map(c => c.bestArrivalS));
    assert.ok(Math.abs(best - 28537.3) < 30,
        `attendu ≈ 28537 (7h55:37), reçu ${best}`);
});

test('récit : la 51 part → le choix meurt, une 51 suivante le remplace', () => {
    const eng = makeEngine();
    const avant = eng.getChoices(T0).find(c => c.lineId === '51N');
    const after = eng.getChoices(avant.expiresS + 10);
    const c51 = after.filter(c => c.lineId === '51N');
    assert.ok(!after.some(c => c.id === avant.id), 'le passage 7h05:41 devrait être expiré');
    assert.ok(c51.length === 1 && c51[0].tDep > avant.tDep,
        `remplaçant 51N plus tardif attendu, reçu ${c51.map(c => c.tDep)}`);
});

test('récit : la marche vers la 103 glisse puis le choix expire', () => {
    const eng = makeEngine();
    const c103 = eng.getChoices(T0).find(c => c.lineId === '103N');
    // Expiration = départ du bus − marche restante (glissement de la marche)
    assert.ok(Math.abs(c103.expiresS - (c103.tDep - c103.walkS)) < 1e-6);
    // Juste avant l'expiration : ce choix précis existe encore
    const before = eng.getChoices(c103.expiresS - 5).find(c => c.id === c103.id);
    assert.ok(before, 'devrait encore être attrapable');
    // Après : ce choix précis est mort (un autre embarquement 103 peut le
    // remplacer — autre arrêt encore joignable ou passage suivant, c'est honnête)
    const after = eng.getChoices(c103.expiresS + 15);
    assert.ok(!after.some(c => c.id === c103.id),
        `choix ${c103.id} encore présent après son expiration`);
});

test('récit : la 66 part à 7h10:44 — son choix expire', () => {
    const eng = makeEngine();
    const after = eng.getChoices(DEP_66 + 10);
    assert.ok(!after.some(c => c.lineId === '66N' && c.tDep === DEP_66));
    assert.ok(after.length >= 1, 'il reste toujours des choix');
});

// ── Invariants ─────────────────────────────────────────────────────────────
test('invariants : temps des legs non décroissants, arrivée cohérente', () => {
    const eng = makeEngine();
    for (const c of eng.getChoices(T0)) {
        for (const jr of c.journeys) {
            let t = -Infinity;
            for (const leg of jr.legs) {
                if (leg.slides) continue;   // marche/attente glissante : pas de temps absolu
                assert.ok(leg.depart_s >= t - 1e-6, `leg recule dans le temps (${c.id})`);
                assert.ok(leg.arrive_s >= leg.depart_s - 1e-6);
                t = leg.arrive_s;
            }
            assert.ok(Math.abs(jr.legs[jr.legs.length - 1].arrive_s - jr.arrival_s) < 1e-6);
        }
        assert.ok(c.expiresS >= T0);
        assert.ok(c.journeys.length >= 1 && c.journeys.length <= 4);
    }
});

test('invariants : CDF croissante, bornée [0,1], p90First cohérent', () => {
    const eng = makeEngine();
    for (const c of eng.getChoices(T0)) {
        const { pts, p90First } = computeChoiceCdf(c.journeys, T0, eng.evSig, T0);
        assert.ok(pts.length >= 2);
        let prev = -1;
        for (const { t, cumP } of pts) {
            assert.ok(cumP >= prev - 1e-9, 'CDF non croissante');
            assert.ok(cumP >= 0 && cumP <= 1 + 1e-9);
            prev = cumP;
        }
        assert.ok(p90First >= c.bestArrivalS - 1,
            `p90First (${p90First}) < meilleure arrivée p50 (${c.bestArrivalS})`);
    }
});

test('il reste des choix tant que les horaires couvrent la période', () => {
    // NOTE : les circuits actuels couvrent ~6h30 → 8h30. Après la re-sync des
    // données (fenêtre 10h30), étendre cette boucle au-delà de T0+1800.
    const eng = makeEngine();
    for (const t of [T0, T0 + 600, T0 + 1200, T0 + 1800]) {
        const n = eng.getChoices(t).length;
        assert.ok(n >= 1 && n <= 4, `à t=${t} : ${n} choix`);
    }
});

// ── Engagement et exécution du plan ────────────────────────────────────────
test('commit 66 : marche → attente → bus, puis choix de type transfert/final', () => {
    const eng = makeEngine();
    const c66 = eng.getChoices(T0).find(c => c.lineId === '66N');
    assert.ok(eng.commit(c66.id, T0));
    assert.equal(eng.getPassenger(T0 + 5).phase, 'walk');
    assert.equal(eng.getPassenger(T0 + 300).phase, 'wait');
    assert.equal(eng.getPassenger(c66.tDep + 60).phase, 'bus');
    const riding = eng.getChoices(c66.tDep + 120);
    assert.ok(riding.length >= 1);
    assert.ok(riding.every(c => c.kind === 'transfer' || c.kind === 'final'),
        `kinds inattendus : ${riding.map(c => c.kind)}`);
});

test('récit complet : 66 → transfert 144 → fin à pied, arrivée ≈ 7h55:37', () => {
    const eng = makeEngine();
    const c66 = eng.getChoices(T0).find(c => c.lineId === '66N');
    assert.ok(eng.commit(c66.id, T0));

    // À bord de la 66 : s'engager vers la 144N
    const t1 = DEP_66 + 120;
    const tr = eng.getChoices(t1).find(c => c.kind === 'transfer' && c.lineId === '144N');
    assert.ok(tr, `transfert 144N absent : ${eng.getChoices(t1).map(c => `${c.kind}:${c.lineId}`)}`);
    assert.ok(eng.commit(tr.id, t1));

    // À bord de la 144 : descendre et finir à pied
    const t2 = tr.tDep + 60;
    assert.equal(eng.getPassenger(t2).phase, 'bus');
    const fin = eng.getChoices(t2).find(c => c.kind === 'final');
    assert.ok(fin, `choix final absent : ${eng.getChoices(t2).map(c => `${c.kind}:${c.lineId}`)}`);
    assert.ok(eng.commit(fin.id, t2));

    assert.equal(eng.getPassenger(fin.bestArrivalS + 30).phase, 'arrived');
    assert.ok(Math.abs(fin.bestArrivalS - 28537.3) < 60,
        `arrivée attendue ≈ 28537 (7h55:37), reçue ${fin.bestArrivalS}`);
});

test('changer d\'idée : parti à pied vers la 103, revient prendre la 66', () => {
    const eng = makeEngine();
    const c103 = eng.getChoices(T0).find(c => c.lineId === '103N');
    assert.ok(eng.commit(c103.id, T0));
    const tMid = T0 + 60;   // en pleine marche (125 s)
    assert.equal(eng.getPassenger(tMid).phase, 'walk');

    const choices = eng.getChoices(tMid);
    const c66 = choices.find(c => c.lineId === '66N');
    assert.ok(c66, 'la 66 devrait rester un choix pendant la marche vers la 103');
    assert.ok(c66.committed !== true);
    assert.ok(eng.commit(c66.id, tMid));
    assert.equal(eng.getPassenger(c66.tDep + 60).phase, 'bus');
    assert.equal(eng.getPassenger(c66.tDep + 60).line_id, '66N');
});

test('reset : retour à l\'état initial', () => {
    const eng = makeEngine();
    const c = eng.getChoices(T0)[0];
    eng.commit(c.id, T0);
    eng.reset();
    assert.equal(eng.committedId, null);
    assert.equal(eng.getPassenger(T0 + 600).phase, 'pre');
    assert.ok(eng.getChoices(T0).length >= 3);
});

// ── Utilitaires ────────────────────────────────────────────────────────────
test('distM : ~111 km par degré de latitude', () => {
    assert.ok(Math.abs(distM(45.0, -73.6, 46.0, -73.6) - 111000) < 1);
});

test('makeEventSigmas : nul au passé, asymétrique avant départ', () => {
    const sigmaFn = makeSigma(index.sigma);
    const ev = makeEventSigmas(sigmaFn, { X: 1000 });
    assert.deepEqual(ev(500, 'X', 600), { early: 0, late: 0 });      // événement passé
    const before = ev(1600, 'X', 400);                               // bus pas parti
    assert.ok(before.late > before.early, 'retard possible, avance impossible');
});

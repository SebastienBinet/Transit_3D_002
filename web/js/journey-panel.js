// Vignette timeline pour le Cas 6 : une rangée par trajet sur un axe de temps commun.
// Trois modes : légende simple, timeline avec biseaux, bandes verticales.
// Three.js-free — testable sous Node (utilise uniquement DOM + Canvas 2D).
//
// Couleurs : pilule de bus = couleur du circuit (même que la carte / cônes 3D) ;
// marche, attente et bonhomme de gauche = couleur du trajet (même que le sprite 3D).
//
// Incertitude (même modèle que buildCone) : ancrée à max(now, départ terminus).
// Un bus pas encore parti ne peut pas être en avance : côté p10 nul au terminus,
// petit σ côté retard (SIGMA_DEP_LATE_S).

import { makeSigma, makeReducedSigma, SIGMA_DEP_LATE_S, REPORT_LAG_S } from './scenario-model.js';
import { LINE_COLORS, JOURNEY_COLORS } from './colors.js';

const PANEL_W   = 420;
const LEFT_GUT  = 74;   // gouttière gauche : bonhomme + heure de départ
const RIGHT_GUT = 88;   // gouttière droite : heure d'arrivée + durée
const DRAW_W    = PANEL_W - LEFT_GUT - RIGHT_GUT;
const ROW_H     = 27;
const AXIS_H    = 18;
const PILL_H    = 13;   // hauteur de la pilule de bus

// ── Bandes — constantes ────────────────────────────────────────────────────
const B_TOP_PAD   = 22;
const B_BOT_PAD   = 30;
const B_LEFT_W    = 44;
const B_RIGHT_PAD = 8;
const BANDES_H    = 440;
const B_DRAW_H    = BANDES_H - B_TOP_PAD - B_BOT_PAD;
const B_T0        = 25200;   // 7h00
const B_T_END     = 30120;   // 8h22 — marge au-dessus de 29857
const B_GRP_GAP   = 10;      // espace horizontal entre groupes
const B_BAND_HALF_MAX = 12;  // demi-largeur max d'une bande (bandes étroites)

function hex(n) { return '#' + n.toString(16).padStart(6, '0'); }
function fmtT(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h${String(m).padStart(2, '0')}`;
}

export function createJourneyPanel({ container, journeysData, tripStarts = {}, onJourneySelect }) {
    const sigmaFn    = makeSigma({ kind: 'power', coeff_min: 3.0, exp: 0.301 });
    const reducedSig = makeReducedSigma(sigmaFn, REPORT_LAG_S);
    const t0      = journeysData.depart_after_s;
    const tMin    = t0 - 60;
    const tMax    = Math.max(...journeysData.journeys.map(j => j.arrival_s)) + 360;

    let mode        = 'biseau';   // 'legend' | 'biseau' | 'bandes'
    let orderMethod = 'best';     // 'best' | 'mean'
    let pinned      = false;
    let collapsed   = false;
    let selectedIdx = null;      // null = tous, number = trajet sélectionné
    let simTime     = 0;         // secondes relatives (t0 + simTime = tAbs)

    let cvs = null, ctx = null, contentDiv = null;
    let bandsCvs = null, bandsCtx = null;
    const N = journeysData.journeys.length;
    const canvasH = AXIS_H + N * ROW_H + 6;

    // ── Coordonnée X sur le canvas biseau ────────────────────────────────────
    function tX(t) { return LEFT_GUT + (t - tMin) / (tMax - tMin) * DRAW_W; }
    function sToPx(s) { return s / (tMax - tMin) * DRAW_W; }

    // ── Coordonnée Y sur le canvas bandes ────────────────────────────────────
    // Temps plus tardif → plus haut → Y plus petit.
    function btY(t) {
        return B_TOP_PAD + (1 - (t - B_T0) / (B_T_END - B_T0)) * B_DRAW_H;
    }

    // ── σ asymétrique d'un événement bus (board/alight) au temps tE ──────────
    function eventSigmas(tE, tripId, nowAbs) {
        if (tE <= nowAbs) return { early: 0, late: 0 };
        const tFirst      = tripStarts[tripId];
        const notDeparted = tFirst != null && nowAbs < tFirst;
        const anchor      = tFirst != null ? Math.max(nowAbs, tFirst) : nowAbs;
        const dt          = Math.max(0, tE - anchor);
        const s = notDeparted ? sigmaFn(dt) : reducedSig(dt);
        return { early: s, late: s + (notDeparted ? SIGMA_DEP_LATE_S : 0) };
    }

    // ── Build HTML ────────────────────────────────────────────────────────────
    function build() {
        container.innerHTML = '';
        container.style.width = PANEL_W + 'px';

        const hdr = document.createElement('div');
        hdr.style.cssText = 'display:flex; align-items:center; gap:5px; margin-bottom:5px;';

        const title = document.createElement('span');
        title.style.cssText = 'flex:1; color:#aac; font-weight:bold; font-size:11px;';
        title.textContent = 'Trajets 51∩66 → 480∩144';

        const modeEl = document.createElement('select');
        modeEl.style.cssText = 'background:#1a2a3a; color:#cdd; border:1px solid #446; padding:2px 4px; border-radius:4px; font-size:10px; font-family:monospace;';
        [['legend', 'Légende'], ['biseau', 'Biseaux'], ['bandes', 'Bandes']].forEach(([v, l]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = l; modeEl.appendChild(o);
        });
        modeEl.value = mode;
        modeEl.onchange = e => { mode = e.target.value; renderContent(); };

        const pinBtn = mkBtn('📌', 'Fantôme — interactions 3D passent au travers');
        pinBtn.onclick = () => {
            pinned = !pinned;
            container.style.opacity  = pinned ? '0.28' : '';
            container.style.pointerEvents = pinned ? 'none' : '';
            pinBtn.style.pointerEvents = 'auto';
            pinBtn.style.opacity = '1';
        };

        const colBtn = mkBtn('▲', 'Replier la vignette');
        colBtn.onclick = () => {
            collapsed = !collapsed;
            contentDiv.style.display = collapsed ? 'none' : '';
            colBtn.textContent = collapsed ? '▼' : '▲';
            colBtn.title = collapsed ? 'Déplier la vignette' : 'Replier la vignette';
        };

        hdr.append(title, modeEl, pinBtn, colBtn);
        contentDiv = document.createElement('div');
        contentDiv.id = 'jp-content';
        container.append(hdr, contentDiv);
        renderContent();
    }

    function mkBtn(label, title) {
        const b = document.createElement('button');
        b.textContent = label; b.title = title;
        b.style.cssText = 'padding:2px 5px; font-size:11px; min-width:26px;';
        return b;
    }

    function mkSelect(opts, value, title, onchange) {
        const sel = document.createElement('select');
        sel.style.cssText = 'background:#1a2a3a; color:#cdd; border:1px solid #446; padding:2px 4px; border-radius:4px; font-size:10px; font-family:monospace;';
        sel.title = title;
        opts.forEach(([v, l]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = l; sel.appendChild(o);
        });
        sel.value = value;
        sel.onchange = e => onchange(e.target.value);
        return sel;
    }

    // ── Rendu du contenu ──────────────────────────────────────────────────────
    function renderContent() {
        if (!contentDiv) return;
        contentDiv.innerHTML = '';
        cvs = null; ctx = null;
        bandsCvs = null; bandsCtx = null;
        if (mode === 'legend') { renderLegend(); return; }
        if (mode === 'bandes') { renderBandesCanvas(); return; }
        renderTimelineCanvas();
    }

    // ── Légende simple ────────────────────────────────────────────────────────
    function renderLegend() {
        journeysData.journeys.forEach((jr, i) => {
            const color = hex(JOURNEY_COLORS[i % JOURNEY_COLORS.length]);
            const busLegs = jr.legs.filter(l => l.type === 'bus');
            const names = busLegs.map(l => l.base).join(' → ');
            const arrH  = Math.floor(jr.arrival_s / 3600);
            const arrM  = Math.floor((jr.arrival_s % 3600) / 60);
            const row = document.createElement('div');
            row.style.cssText = 'font-size:11px; line-height:1.85; cursor:pointer; border-radius:3px; padding:0 3px;';
            row.innerHTML =
                `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};margin-right:5px;vertical-align:middle"></span>`
                + `Trajet ${jr.rank} · ${names} · arr. ${arrH}h${String(arrM).padStart(2, '0')}`;
            row.onclick = () => toggleSelect(i);
            contentDiv.appendChild(row);
        });
        const foot = document.createElement('div');
        foot.style.cssText = 'margin-top:5px; color:#888; font-size:10px;';
        foot.textContent = 'Axe vertical = temps';
        contentDiv.appendChild(foot);
        applyLegendHighlight();
    }

    function applyLegendHighlight() {
        if (!contentDiv || mode !== 'legend') return;
        const rows = contentDiv.querySelectorAll('div[style*="cursor"]');
        rows.forEach((row, i) => {
            row.style.opacity = (selectedIdx === null || selectedIdx === i) ? '1' : '0.3';
            row.style.background = selectedIdx === i ? 'rgba(80,100,140,0.3)' : '';
        });
    }

    // ── Canvas timeline (biseau) ──────────────────────────────────────────────
    function renderTimelineCanvas() {
        cvs = document.createElement('canvas');
        cvs.width  = PANEL_W;
        cvs.height = canvasH;
        cvs.style.cssText = `width:${PANEL_W}px; height:${canvasH}px; display:block; cursor:pointer;`;
        ctx = cvs.getContext('2d');
        cvs.onclick = e => {
            const rect = cvs.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const ri = Math.floor((y - AXIS_H) / ROW_H);
            if (ri >= 0 && ri < N) toggleSelect(ri);
        };
        contentDiv.appendChild(cvs);
        draw();
    }

    function draw() {
        if (!ctx) return;
        const nowAbs = t0 + simTime;
        ctx.clearRect(0, 0, PANEL_W, canvasH);

        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        const TICK = 900;
        const firstTick = Math.ceil(tMin / TICK) * TICK;
        for (let t = firstTick; t <= tMax; t += TICK) {
            const x = tX(t);
            if (x < LEFT_GUT - 1 || x > PANEL_W - RIGHT_GUT + 1) continue;
            ctx.fillStyle = '#2a3a50';
            ctx.fillRect(x, AXIS_H - 6, 1, canvasH - AXIS_H + 6);
            ctx.fillStyle = '#778899';
            ctx.fillText(fmtT(t), x, 10);
        }

        journeysData.journeys.forEach((jr, ri) => { drawRow(jr, ri, nowAbs); });

        const xNow = tX(nowAbs);
        if (xNow >= LEFT_GUT && xNow <= PANEL_W - RIGHT_GUT) {
            ctx.save();
            ctx.strokeStyle = '#ffee55'; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.75;
            ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.moveTo(xNow, 0); ctx.lineTo(xNow, canvasH); ctx.stroke();
            ctx.restore();
        }
    }

    function drawRow(jr, ri, nowAbs) {
        const y0   = AXIS_H + ri * ROW_H;
        const yMid = y0 + ROW_H / 2;
        const jCol = hex(JOURNEY_COLORS[ri % JOURNEY_COLORS.length]);
        const dim  = (selectedIdx !== null && selectedIdx !== ri);
        const alpha = dim ? 0.25 : 1.0;

        ctx.save();
        ctx.globalAlpha = alpha;

        if (selectedIdx === ri) {
            ctx.fillStyle = 'rgba(80,100,140,0.18)';
            ctx.fillRect(0, y0, PANEL_W, ROW_H);
        }

        drawBonhomme(10, yMid, jCol);
        ctx.fillStyle = '#99bbdd'; ctx.font = '10px monospace'; ctx.textAlign = 'right';
        ctx.fillText(fmtT(jr.legs[0].depart_s), LEFT_GUT - 4, yMid + 3);

        ctx.textAlign = 'left';
        ctx.fillStyle = '#99bbdd';
        ctx.fillText(fmtT(jr.arrival_s), PANEL_W - RIGHT_GUT + 3, yMid + 3);
        const durMin = Math.round((jr.arrival_s - jr.legs[0].depart_s) / 60);
        ctx.fillStyle = '#556677';
        ctx.fillText(`${durMin}min`, PANEL_W - RIGHT_GUT + 40, yMid + 3);

        for (let li = 0; li < jr.legs.length; li++) {
            const leg = jr.legs[li];
            if (leg.type === 'walk')       drawWalk(leg, y0, yMid, jCol, jr.legs, li, nowAbs);
            else if (leg.type === 'wait')  drawWait(leg, yMid, jCol);
            else if (leg.type === 'bus')   drawBus(leg, y0, yMid, nowAbs);
        }
        ctx.restore();
    }

    function drawBonhomme(x, yMid, col) {
        ctx.save();
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
        const yTop = yMid - 6.5;
        ctx.beginPath(); ctx.arc(x, yTop + 1.8, 1.8, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(x, yTop + 3.6); ctx.lineTo(x, yTop + 8.5); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - 3, yTop + 5.5); ctx.lineTo(x + 3, yTop + 5.5); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, yTop + 8.5); ctx.lineTo(x - 2.5, yTop + 13);
        ctx.moveTo(x, yTop + 8.5); ctx.lineTo(x + 2.5, yTop + 13);
        ctx.stroke();
        ctx.restore();
    }

    function drawWalk(leg, y0, yMid, jCol, legs, li, nowAbs) {
        const x1 = tX(leg.depart_s), x2 = tX(leg.arrive_s);
        ctx.fillStyle = jCol;
        for (let dx = x1 + 1; dx <= x2 - 1; dx += 5) {
            ctx.beginPath(); ctx.arc(dx, yMid, 1.8, 0, Math.PI * 2); ctx.fill();
        }
    }

    function drawWait(leg, yMid, jCol) {
        const x1 = tX(leg.depart_s), x2 = tX(leg.arrive_s);
        ctx.save();
        ctx.strokeStyle = jCol; ctx.globalAlpha *= 0.35; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x1, yMid); ctx.lineTo(x2, yMid); ctx.stroke();
        ctx.restore();
    }

    function drawBus(leg, y0, yMid, nowAbs) {
        const boardS  = leg.depart_s ?? leg.board_s;
        const alightS = leg.arrive_s ?? leg.alight_s;
        const x1 = tX(boardS), x2 = tX(alightS);
        const col = hex(LINE_COLORS[leg.line_id] ?? 0x888888);
        drawBiseau(leg, yMid, col, nowAbs, boardS, alightS, x1, x2);
    }

    // ── Biseau ────────────────────────────────────────────────────────────────
    function drawBiseau(leg, yMid, col, nowAbs, boardS, alightS, x1, x2) {
        const pillY = yMid - PILL_H / 2;
        const pillB = yMid + PILL_H / 2;
        const sgB = eventSigmas(boardS,  leg.trip_id, nowAbs);
        const sgA = eventSigmas(alightS, leg.trip_id, nowAbs);

        const pts = [
            [x1 + sToPx(sgB.late),  pillY],
            [x2 + sToPx(sgA.late),  pillY],
            [x2 - sToPx(sgA.early), pillB],
            [x1 - sToPx(sgB.early), pillB],
        ];

        ctx.fillStyle = col;
        ctx.beginPath(); ctx.moveTo(...pts[0]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(...pts[i]);
        ctx.closePath(); ctx.fill();

        const midX = (x1 + x2) / 2;
        if (x2 - x1 > 14) {
            ctx.fillStyle = '#fff'; ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center';
            ctx.fillText(leg.base, midX, yMid + 3);
        }
    }

    // ── Bandes ────────────────────────────────────────────────────────────────

    function groupJourneys() {
        const map = new Map();
        journeysData.journeys.forEach((jr, idx) => {
            const key = jr.legs.find(l => l.type === 'bus')?.line_id ?? '?';
            if (!map.has(key)) map.set(key, []);
            map.get(key).push({ jr, idx });
        });
        for (const g of map.values()) g.sort((a, b) => a.jr.arrival_s - b.jr.arrival_s);
        const arr = [...map.entries()].map(([key, items]) => ({
            key, items,
            bestArrival: items[0].jr.arrival_s,
            bestNBus:    items[0].jr.n_bus,
            meanArrival: items.reduce((s, x) => s + x.jr.arrival_s, 0) / items.length,
        }));
        if (orderMethod === 'mean') {
            arr.sort((a, b) => a.meanArrival - b.meanArrival || a.key.localeCompare(b.key));
        } else {
            arr.sort((a, b) => a.bestArrival - b.bestArrival || a.bestNBus - b.bestNBus || a.key.localeCompare(b.key));
        }
        return arr;
    }

    function computeBandW(groups) {
        const totalJ   = groups.reduce((s, g) => s + g.items.length, 0);
        const gapTotal = B_GRP_GAP * Math.max(0, groups.length - 1);
        return Math.floor((PANEL_W - B_LEFT_W - B_RIGHT_PAD - gapTotal) / Math.max(1, totalJ));
    }

    function renderBandesCanvas() {
        // Barre de sous-options propre aux bandes
        const bar = document.createElement('div');
        bar.style.cssText = 'display:flex; gap:5px; margin-bottom:4px;';
        bar.append(
            mkSelect(
                [['best', 'Meilleure arr.'], ['mean', 'Arr. moy.']],
                orderMethod, 'Ordre des groupes (gauche → droite)',
                v => { orderMethod = v; drawBandes(); }),
        );
        contentDiv.appendChild(bar);

        bandsCvs = document.createElement('canvas');
        bandsCvs.width  = PANEL_W;
        bandsCvs.height = BANDES_H;
        bandsCvs.style.cssText = `width:${PANEL_W}px; height:${BANDES_H}px; display:block; cursor:pointer;`;
        bandsCtx = bandsCvs.getContext('2d');
        bandsCvs.onclick = e => {
            const rect   = bandsCvs.getBoundingClientRect();
            const xClick = e.clientX - rect.left;
            const groups = groupJourneys();
            const bandW  = computeBandW(groups);
            let xCursor  = B_LEFT_W;
            for (const g of groups) {
                for (let ci = 0; ci < g.items.length; ci++) {
                    const xc = xCursor + (ci + 0.5) * bandW;
                    if (Math.abs(xClick - xc) <= bandW / 2) { toggleSelect(g.items[ci].idx); return; }
                }
                xCursor += g.items.length * bandW + B_GRP_GAP;
            }
        };
        contentDiv.appendChild(bandsCvs);
        drawBandes();
    }

    function drawBandes() {
        if (!bandsCtx) return;
        const c      = bandsCtx;
        const nowAbs = t0 + simTime;
        const groups = groupJourneys();
        const bandW  = computeBandW(groups);
        const halfW  = Math.min(bandW / 2 - 1, B_BAND_HALF_MAX);   // bande étroite, centrée dans sa colonne

        c.clearRect(0, 0, PANEL_W, BANDES_H);

        // Grille horizontale et étiquettes de temps (axe gauche)
        c.font = '9px monospace'; c.textAlign = 'right';
        const firstTick = Math.ceil(B_T0 / 900) * 900;
        for (let t = firstTick; t <= B_T_END; t += 900) {
            const y = btY(t);
            c.fillStyle = '#243040';
            c.fillRect(B_LEFT_W - 1, y, PANEL_W - B_LEFT_W - B_RIGHT_PAD + 1, 1);
            c.fillStyle = '#778899';
            c.fillText(fmtT(t), B_LEFT_W - 4, y + 3);
        }

        // Curseur "maintenant"
        const yNow = btY(nowAbs);
        if (yNow >= B_TOP_PAD && yNow <= B_TOP_PAD + B_DRAW_H) {
            c.save();
            c.strokeStyle = '#ffee55'; c.lineWidth = 1.5; c.globalAlpha = 0.75;
            c.setLineDash([3, 3]);
            c.beginPath(); c.moveTo(B_LEFT_W, yNow); c.lineTo(PANEL_W - B_RIGHT_PAD, yNow); c.stroke();
            c.restore();
        }

        // Groupes et colonnes
        let xCursor = B_LEFT_W;
        for (const g of groups) {
            const gWidth = g.items.length * bandW;

            // Séparateur vertical entre groupes
            if (xCursor > B_LEFT_W) {
                c.fillStyle = '#1e2d3e';
                c.fillRect(xCursor - Math.round(B_GRP_GAP / 2), B_TOP_PAD, 1, B_DRAW_H);
            }

            // Étiquette du groupe (1er bus) au-dessus de la grille
            const gCol = hex(LINE_COLORS[g.key] ?? 0x888888);
            c.font = 'bold 9px monospace'; c.textAlign = 'center'; c.fillStyle = gCol;
            c.fillText(g.key, xCursor + gWidth / 2, B_TOP_PAD - 6);

            g.items.forEach(({ jr, idx }, ci) => {
                const xc = xCursor + (ci + 0.5) * bandW;
                drawJourneyBand(c, jr, idx, xc, halfW, nowAbs);
                // Rang en bas
                c.font = '8px monospace'; c.textAlign = 'center';
                c.fillStyle = selectedIdx === idx ? '#aabbdd' : '#556677';
                c.fillText(`#${jr.rank}`, xc, BANDES_H - 4);
            });

            xCursor += gWidth + B_GRP_GAP;
        }
    }

    function drawJourneyBand(c, jr, idx, xCenter, halfW, nowAbs) {
        const busLegs = jr.legs.filter(l => l.type === 'bus');
        const dim   = selectedIdx !== null && selectedIdx !== idx;
        const alpha = dim ? 0.18 : 1.0;

        c.save();
        c.globalAlpha = alpha;

        busLegs.forEach((leg, bi) => {
            const boardS  = leg.board_s  ?? leg.depart_s;
            const alightS = leg.alight_s ?? leg.arrive_s;
            const sgB = eventSigmas(boardS,  leg.trip_id, nowAbs);
            const sgA = eventSigmas(alightS, leg.trip_id, nowAbs);
            const col = hex(LINE_COLORS[leg.line_id] ?? 0x888888);

            // Hexagone symétrique : p90 à la pointe (haut et bas), p10 aux épaules.
            // Arrivée (haut) : pointe haute = p90 (pire cas), épaules = p10.
            // Départ  (bas)  : p90 au centre (notch vers le haut), p10 aux coins bas.
            const yTopApex = btY(alightS + sgA.late);   // pointe haute = p90 arrivée
            const yTopBody = btY(alightS - sgA.early);  // épaules haut = p10 arrivée
            const yBotApex = btY(boardS  + sgB.late);   // notch centre = p90 départ
            const yBotBody = btY(boardS  - sgB.early);  // coins bas = p10 départ

            c.fillStyle = col;
            c.beginPath();
            c.moveTo(xCenter,          yTopApex);
            c.lineTo(xCenter + halfW,  yTopBody);
            c.lineTo(xCenter + halfW,  yBotBody);
            c.lineTo(xCenter,          yBotApex);
            c.lineTo(xCenter - halfW,  yBotBody);
            c.lineTo(xCenter - halfW,  yTopBody);
            c.closePath();
            c.fill();

            // Numéro de ligne au centre du corps (médiane p50→p50)
            const yMid50 = (btY(boardS) + btY(alightS)) / 2;
            if (btY(boardS) - btY(alightS) > 14) {
                c.fillStyle = 'rgba(255,255,255,0.9)';
                c.font = 'bold 8px monospace'; c.textAlign = 'center';
                c.fillText(leg.base, xCenter, yMid50 + 3);
            }

            // Trait de connexion vers le bus suivant (p50 alight → p50 board suivant)
            if (bi < busLegs.length - 1) {
                const nextLeg    = busLegs[bi + 1];
                const nextBoardS = nextLeg.board_s ?? nextLeg.depart_s;
                c.save();
                c.strokeStyle = '#aabbcc'; c.lineWidth = 1; c.globalAlpha *= 0.5;
                c.setLineDash([2, 3]);
                c.beginPath();
                c.moveTo(xCenter, btY(alightS));
                c.lineTo(xCenter, btY(nextBoardS));
                c.stroke();
                c.restore();
            }
        });

        c.restore();

        // ── Zones de risque de correspondance ─────────────────────────────────
        // Pour chaque paire de bus consécutifs, la zone de risque est l'intervalle
        // de temps où l'incertitude d'arrivée du bus A chevauche celle de départ
        // du bus B — c.-à-d. la région où les deux bandes s'interpénètrent.
        //   zone = [arrivéeA ∓ σ] ∩ [départB ∓ σ]
        //        = [ max(alightA − σA_early, boardB − σB_early),
        //            min(alightA + σA_late,  boardB + σB_late) ]
        // Bornes utiles : haut = pointe p90 d'arrivée de A ; bas = notch p10 de
        // départ de B. La zone rétrécit quand σ diminue et disparaît sans risque.
        const pulse = 0.35 + 0.2 * Math.abs(Math.sin(Date.now() / 500));
        for (let bi = 0; bi < busLegs.length - 1; bi++) {
            const legA    = busLegs[bi];
            const legB    = busLegs[bi + 1];
            const alightA = legA.alight_s ?? legA.arrive_s;
            const boardB  = legB.board_s  ?? legB.depart_s;
            const sgA = eventSigmas(alightA, legA.trip_id, nowAbs);
            const sgB = eventSigmas(boardB,  legB.trip_id, nowAbs);

            const tRiskLo = Math.max(alightA - sgA.early, boardB - sgB.early);
            const tRiskHi = Math.min(alightA + sgA.late,  boardB + sgB.late);
            if (tRiskLo >= tRiskHi) continue;   // aucun chevauchement → aucun risque

            const yHi = btY(tRiskHi);   // temps plus tardif → plus haut (Y plus petit)
            const yLo = btY(tRiskLo);   // temps plus tôt  → plus bas  (Y plus grand)

            c.save();
            c.globalAlpha = (dim ? 0.4 : 1.0) * pulse;
            c.fillStyle = '#ff2020';
            c.fillRect(xCenter - halfW, yHi, halfW * 2, yLo - yHi);
            // Bordures horizontales nettes aux limites de la zone
            c.globalAlpha = (dim ? 0.5 : 1.0) * Math.min(pulse + 0.2, 1);
            c.strokeStyle = '#ff5555';
            c.lineWidth = 1;
            c.setLineDash([]);
            c.beginPath();
            c.moveTo(xCenter - halfW, yHi); c.lineTo(xCenter + halfW, yHi);
            c.moveTo(xCenter - halfW, yLo); c.lineTo(xCenter + halfW, yLo);
            c.stroke();
            c.restore();
        }
    }

    // ── Utilitaires ───────────────────────────────────────────────────────────
    function roundRect(ctx, x, y, w, h, r) {
        if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
        r = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
    }

    function findPreceding(legs, li, type) {
        for (let i = li - 1; i >= 0; i--) {
            if (legs[i].type === type) return legs[i];
            if (legs[i].type !== 'walk' && legs[i].type !== 'wait') break;
        }
        return null;
    }

    // ── Sélection d'un trajet ─────────────────────────────────────────────────
    function toggleSelect(idx) {
        selectedIdx = (selectedIdx === idx) ? null : idx;
        const tripIds = selectedIdx !== null
            ? journeysData.journeys[selectedIdx].legs
                .filter(l => l.type === 'bus').map(l => l.trip_id)
            : null;
        onJourneySelect?.(tripIds);
        if (mode === 'legend') applyLegendHighlight();
        else if (mode === 'bandes') drawBandes();
        else draw();
    }

    // ── API publique ──────────────────────────────────────────────────────────
    build();

    return {
        update(st) {
            simTime = st;
            if (mode === 'bandes' && bandsCtx) { drawBandes(); return; }
            if (mode !== 'legend' && ctx) draw();
        },
        dispose() {
            container.innerHTML = '';
            cvs = null; ctx = null;
            bandsCvs = null; bandsCtx = null;
        },
    };
}

// Vignette timeline pour le Cas 6 : une rangée par trajet sur un axe de temps commun.
// Trois modes : légende simple, timeline avec moustaches (option A), timeline avec biseaux.
// Three.js-free — testable sous Node (utilise uniquement DOM + Canvas 2D).
//
// Couleurs : pilule de bus = couleur du circuit (même que la carte / cônes 3D) ;
// marche, attente et bonhomme de gauche = couleur du trajet (même que le sprite 3D).
//
// Incertitude (même modèle que buildCone) : ancrée à max(now, départ terminus).
// Un bus pas encore parti ne peut pas être en avance : côté p10 nul au terminus,
// petit σ côté retard (SIGMA_DEP_LATE_S).

import { makeSigma, SIGMA_DEP_LATE_S } from './scenario-model.js';
import { LINE_COLORS, JOURNEY_COLORS } from './colors.js';

const PANEL_W   = 420;
const LEFT_GUT  = 74;   // gouttière gauche : bonhomme + heure de départ
const RIGHT_GUT = 88;   // gouttière droite : heure d'arrivée + durée
const DRAW_W    = PANEL_W - LEFT_GUT - RIGHT_GUT;
const ROW_H     = 27;
const AXIS_H    = 18;
const PILL_H    = 13;   // hauteur de la pilule de bus

function hex(n) { return '#' + n.toString(16).padStart(6, '0'); }
function fmtT(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h${String(m).padStart(2, '0')}`;
}

export function createJourneyPanel({ container, journeysData, tripStarts = {}, onJourneySelect }) {
    const sigmaFn = makeSigma({ kind: 'power', coeff_min: 3.0, exp: 0.301 });
    const t0      = journeysData.depart_after_s;
    const tMin    = t0 - 60;
    const tMax    = Math.max(...journeysData.journeys.map(j => j.arrival_s)) + 360;

    let mode        = 'biseau';   // 'legend' | 'biseau'
    let pinned      = false;
    let collapsed   = false;
    let selectedIdx = null;      // null = tous, number = trajet sélectionné
    let simTime     = 0;         // secondes relatives (t0 + simTime = tAbs)

    let cvs = null, ctx = null, contentDiv = null;
    const N = journeysData.journeys.length;
    const canvasH = AXIS_H + N * ROW_H + 6;

    // ── Coordonnée X sur le canvas ───────────────────────────────────────────
    function tX(t) { return LEFT_GUT + (t - tMin) / (tMax - tMin) * DRAW_W; }
    function sToPx(s) { return s / (tMax - tMin) * DRAW_W; }

    // ── σ asymétrique d'un événement bus (board/alight) au temps tE ──────────
    // Retourne {early, late} en secondes. tFirst = départ planifié du terminus.
    function eventSigmas(tE, tripId, nowAbs) {
        const tFirst = tripStarts[tripId];
        const anchor = tFirst != null ? Math.max(nowAbs, tFirst) : nowAbs;
        const dt     = Math.max(0, tE - anchor);
        if (tE <= nowAbs) return { early: 0, late: 0 };   // événement passé : certitude
        const s = sigmaFn(dt);
        const notDeparted = tFirst != null && nowAbs < tFirst;
        return { early: s, late: s + (notDeparted ? SIGMA_DEP_LATE_S : 0) };
    }

    // ── Build HTML ────────────────────────────────────────────────────────────
    function build() {
        container.innerHTML = '';
        container.style.width = PANEL_W + 'px';

        // En-tête
        const hdr = document.createElement('div');
        hdr.style.cssText = 'display:flex; align-items:center; gap:5px; margin-bottom:5px;';

        const title = document.createElement('span');
        title.style.cssText = 'flex:1; color:#aac; font-weight:bold; font-size:11px;';
        title.textContent = 'Trajets 51∩66 → 480∩144';

        const modeEl = document.createElement('select');
        modeEl.style.cssText = 'background:#1a2a3a; color:#cdd; border:1px solid #446; padding:2px 4px; border-radius:4px; font-size:10px; font-family:monospace;';
        [['legend', 'Légende'], ['biseau', 'Biseaux']].forEach(([v, l]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = l; modeEl.appendChild(o);
        });
        modeEl.value = mode;
        modeEl.onchange = e => { mode = e.target.value; renderContent(); };

        // Bouton 📌 : fantôme (laisser passer les interactions 3D sous la vignette)
        const pinBtn = mkBtn('📌', 'Fantôme — interactions 3D passent au travers');
        pinBtn.onclick = () => {
            pinned = !pinned;
            container.style.opacity  = pinned ? '0.28' : '';
            container.style.pointerEvents = pinned ? 'none' : '';
            pinBtn.style.pointerEvents = 'auto';  // lui-même toujours cliquable
            pinBtn.style.opacity = '1';
        };

        // Bouton ▲ : replier/déplier
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

    // ── Rendu du contenu (change selon le mode) ───────────────────────────────
    function renderContent() {
        if (!contentDiv) return;
        contentDiv.innerHTML = '';
        cvs = null; ctx = null;
        if (mode === 'legend') { renderLegend(); return; }
        renderTimelineCanvas();   // mode biseau
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

    // ── Canvas timeline ───────────────────────────────────────────────────────
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

    // ── Dessin de la timeline ─────────────────────────────────────────────────
    function draw() {
        if (!ctx) return;
        const nowAbs = t0 + simTime;

        ctx.clearRect(0, 0, PANEL_W, canvasH);

        // Axe de temps — tirets toutes les 15 min
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

        // Rangées
        journeysData.journeys.forEach((jr, ri) => {
            drawRow(jr, ri, nowAbs);
        });

        // Curseur "maintenant"
        const xNow = tX(nowAbs);
        if (xNow >= LEFT_GUT && xNow <= PANEL_W - RIGHT_GUT) {
            ctx.save();
            ctx.strokeStyle = '#ffee55';
            ctx.lineWidth = 1.5;
            ctx.globalAlpha = 0.75;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(xNow, 0);
            ctx.lineTo(xNow, canvasH);
            ctx.stroke();
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

        // Fond sélectionné
        if (selectedIdx === ri) {
            ctx.fillStyle = 'rgba(80,100,140,0.18)';
            ctx.fillRect(0, y0, PANEL_W, ROW_H);
        }

        // Gouttière gauche : bonhomme (couleur du trajet) + heure départ
        drawBonhomme(10, yMid, jCol);
        ctx.fillStyle = '#99bbdd';
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        ctx.fillText(fmtT(jr.legs[0].depart_s), LEFT_GUT - 4, yMid + 3);

        // Gouttière droite : arrivée + durée
        ctx.textAlign = 'left';
        ctx.fillStyle = '#99bbdd';
        ctx.fillText(fmtT(jr.arrival_s), PANEL_W - RIGHT_GUT + 3, yMid + 3);
        const durMin = Math.round((jr.arrival_s - jr.legs[0].depart_s) / 60);
        ctx.fillStyle = '#556677';
        ctx.fillText(`${durMin}min`, PANEL_W - RIGHT_GUT + 40, yMid + 3);

        // Jambes
        for (let li = 0; li < jr.legs.length; li++) {
            const leg = jr.legs[li];

            if (leg.type === 'walk') {
                drawWalk(leg, y0, yMid, jCol, jr.legs, li, nowAbs);
            } else if (leg.type === 'wait') {
                drawWait(leg, yMid, jCol);
            } else if (leg.type === 'bus') {
                drawBus(leg, y0, yMid, nowAbs);
            }
        }

        ctx.restore();
    }

    // Mini bonhomme allumette (même silhouette que le sprite 3D), ~13 px de haut
    function drawBonhomme(x, yMid, col) {
        ctx.save();
        ctx.strokeStyle = col;
        ctx.fillStyle = col;
        ctx.lineWidth = 1.4;
        ctx.lineCap = 'round';
        const yTop = yMid - 6.5;
        ctx.beginPath(); ctx.arc(x, yTop + 1.8, 1.8, 0, Math.PI * 2); ctx.fill();   // tête
        ctx.beginPath(); ctx.moveTo(x, yTop + 3.6); ctx.lineTo(x, yTop + 8.5); ctx.stroke();  // corps
        ctx.beginPath(); ctx.moveTo(x - 3, yTop + 5.5); ctx.lineTo(x + 3, yTop + 5.5); ctx.stroke();  // bras
        ctx.beginPath();
        ctx.moveTo(x, yTop + 8.5); ctx.lineTo(x - 2.5, yTop + 13);
        ctx.moveTo(x, yTop + 8.5); ctx.lineTo(x + 2.5, yTop + 13);
        ctx.stroke();   // jambes
        ctx.restore();
    }

    function drawWalk(leg, y0, yMid, jCol, legs, li, nowAbs) {
        const x1 = tX(leg.depart_s);
        const x2 = tX(leg.arrive_s);
        // Série de points — couleur du trajet (c'est le passager qui marche)
        ctx.fillStyle = jCol;
        for (let dx = x1 + 1; dx <= x2 - 1; dx += 5) {
            ctx.beginPath();
            ctx.arc(dx, yMid, 1.8, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function drawWait(leg, yMid, jCol) {
        const x1 = tX(leg.depart_s);
        const x2 = tX(leg.arrive_s);
        ctx.save();
        ctx.strokeStyle = jCol;
        ctx.globalAlpha *= 0.35;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x1, yMid);
        ctx.lineTo(x2, yMid);
        ctx.stroke();
        ctx.restore();
    }

    function drawBus(leg, y0, yMid, nowAbs) {
        const boardS  = leg.depart_s ?? leg.board_s;
        const alightS = leg.arrive_s ?? leg.alight_s;
        const x1 = tX(boardS);
        const x2 = tX(alightS);
        const pillY = yMid - PILL_H / 2;
        // Couleur du CIRCUIT — identique au tracé sur la carte et aux cônes 3D
        const col = hex(LINE_COLORS[leg.line_id] ?? 0x888888);

        drawBiseau(leg, yMid, col, nowAbs, boardS, alightS, x1, x2);
    }

    // ── Biseau ────────────────────────────────────────────────────────────────
    // La pilule devient un quadrilatère : arête du haut = frontière « retard »
    // (p10 du temps décalé vers la droite), arête du bas = frontière « avance »
    // (p90 du temps décalé vers la gauche). Au terminus, early=0 → coin bas-gauche
    // exactement à l'heure planifiée ; seul un petit retard penche le coin haut-gauche.
    function drawBiseau(leg, yMid, col, nowAbs, boardS, alightS, x1, x2) {
        const pillY = yMid - PILL_H / 2;
        const pillB = yMid + PILL_H / 2;
        const sgB = eventSigmas(boardS,  leg.trip_id, nowAbs);
        const sgA = eventSigmas(alightS, leg.trip_id, nowAbs);

        // Sommets (sens horaire) :
        // Haut = côté « plus tard » (+late) ; bas = côté « plus tôt » (−early)
        const pts = [
            [x1 + sToPx(sgB.late),  pillY],   // haut-gauche : board p90 (retard)
            [x2 + sToPx(sgA.late),  pillY],   // haut-droit  : alight p90 (retard)
            [x2 - sToPx(sgA.early), pillB],   // bas-droit   : alight p10 (avance)
            [x1 - sToPx(sgB.early), pillB],   // bas-gauche  : board p10 (avance)
        ];

        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(...pts[0]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(...pts[i]);
        ctx.closePath();
        ctx.fill();

        // Numéro de ligne au centre de la pilule p50
        const midX = (x1 + x2) / 2;
        if (x2 - x1 > 14) {
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 8px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(leg.base, midX, yMid + 3);
        }
    }

    // ── Utilitaires ───────────────────────────────────────────────────────────
    function roundRect(ctx, x, y, w, h, r) {
        if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
        r = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
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
        else draw();
    }

    // ── API publique ──────────────────────────────────────────────────────────
    build();

    return {
        update(st) {
            simTime = st;
            if (mode !== 'legend' && ctx) draw();
        },
        dispose() {
            container.innerHTML = '';
            cvs = null; ctx = null;
        },
    };
}

// Panneau du Cas 7 : colonnes de CHOIX vivants sur une fenêtre temporelle
// glissante (90 min de futur, 15 min de passé — la ligne « maintenant » reste
// à hauteur fixe, le diagramme coule vers le bas). Section CDF à gauche.
//
// - une colonne = une prochaine action (choix) fournie par choice-engine ;
// - clic sur une colonne vivante = s'engager (commit) ;
// - un choix mort reste affiché, estompé ; sa largeur décroît jusqu'à 0 en
//   15 min puis il est retiré ; les nouveaux choix entrent à droite ;
// - transitions douces (animation de largeur au mur d'horloge).
//
// DOM + Canvas 2D seulement — la logique de simulation vit dans choice-engine.js.

import { LINE_COLORS } from './colors.js';

const PANEL_W  = 420;
const CDF_W    = 155;
const H        = 460;
const TOP_PAD  = 22;
const BOT_PAD  = 16;
const LEFT_W   = 44;    // axe des heures
const RIGHT_PAD = 8;
const DRAW_H   = H - TOP_PAD - BOT_PAD;

const PAST_S   = 900;    // 15 min de passé sous la ligne « maintenant »
const FUT_S    = 5400;   // 90 min de futur au-dessus
const SPAN_S   = PAST_S + FUT_S;
const DEAD_S   = 900;    // un choix mort disparaît en 15 min

const COL_MAX_W   = 72;  // largeur max d'une colonne (px)
const BAND_HALF_MAX = 12;
const CDF_LPAD    = 6;

const USER_COLOR = '#ffdd22';   // couleur de l'usager (marches, attentes)

function hex(n) { return '#' + n.toString(16).padStart(6, '0'); }
function fmtT(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return `${h}h${String(m).padStart(2, '0')}`;
}
function strokeLabel(ctx, text, x, y, fill, lw = 3) {
    ctx.save();
    ctx.lineWidth = lw; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
    ctx.restore();
}

export function createChoicePanel({ container, engine, t0, onCommit, onHighlightChoice }) {
    let pinned = false, collapsed = false;
    let bandsCvs = null, bandsCtx = null, cdfCvs = null, cdfCtx = null;
    let statusEl = null, contentDiv = null;
    let lastWall = null;

    // Colonnes suivies : {id, choice, state:'live'|'dead', diedS, commitS, u}
    // u = facteur de largeur animé (0 → 1 à la naissance ; suit la cible à la mort).
    let cols = [];

    // Colonne survolée (id) — lie visuellement la bande (droite) et sa CDF (gauche) :
    // survoler l'une met l'autre en évidence et estompe les autres colonnes.
    let hoveredId = null;

    // ── Fenêtre glissante ──────────────────────────────────────────────────
    function btY(t, nowAbs) {
        const tLo = nowAbs - PAST_S;
        return TOP_PAD + (1 - (t - tLo) / SPAN_S) * DRAW_H;
    }
    const Y_NOW = TOP_PAD + (1 - PAST_S / SPAN_S) * DRAW_H;   // fixe à l'écran

    // ── Construction DOM ───────────────────────────────────────────────────
    function mkBtn(label, title) {
        const b = document.createElement('button');
        b.textContent = label; b.title = title;
        b.style.cssText = 'padding:2px 5px; font-size:11px; min-width:26px;';
        return b;
    }

    function build() {
        container.innerHTML = '';
        container.style.width = (PANEL_W + CDF_W) + 'px';

        const hdr = document.createElement('div');
        hdr.style.cssText = 'display:flex; align-items:center; gap:5px; margin-bottom:3px;';
        const title = document.createElement('span');
        title.style.cssText = 'flex:1; color:#aac; font-weight:bold; font-size:11px;';
        title.textContent = 'Choix — 51∩66 → 480∩144';

        const pinBtn = mkBtn('📌', 'Fantôme — interactions 3D passent au travers');
        pinBtn.onclick = () => {
            pinned = !pinned;
            container.style.opacity = pinned ? '0.28' : '';
            container.style.pointerEvents = pinned ? 'none' : '';
            pinBtn.style.pointerEvents = 'auto';
            pinBtn.style.opacity = '1';
        };
        const colBtn = mkBtn('▲', 'Replier la vignette');
        colBtn.onclick = () => {
            collapsed = !collapsed;
            contentDiv.style.display = collapsed ? 'none' : '';
            colBtn.textContent = collapsed ? '▼' : '▲';
        };
        hdr.append(title, pinBtn, colBtn);

        statusEl = document.createElement('div');
        statusEl.style.cssText = 'color:#8aa; font-size:10px; margin-bottom:4px; font-family:monospace;';
        statusEl.textContent = 'Cliquer une colonne pour s\'engager dans ce choix.';

        contentDiv = document.createElement('div');
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex; gap:0; align-items:flex-start;';

        cdfCvs = document.createElement('canvas');
        cdfCvs.width = CDF_W; cdfCvs.height = H;
        cdfCvs.style.cssText = `width:${CDF_W}px; height:${H}px; display:block;`;
        cdfCtx = cdfCvs.getContext('2d');

        cdfCvs.style.cursor = 'pointer';

        bandsCvs = document.createElement('canvas');
        bandsCvs.width = PANEL_W; bandsCvs.height = H;
        bandsCvs.style.cssText = `width:${PANEL_W}px; height:${H}px; display:block; cursor:pointer;`;
        bandsCtx = bandsCvs.getContext('2d');

        // Clic : s'engager. Survol : lier bande ↔ CDF. Les deux canvas partagent
        // la même disposition de colonnes, d'où le lien dans les deux sens.
        bandsCvs.onclick     = e => commitCol(colAtBandX(evX(e, bandsCvs)));
        cdfCvs.onclick       = e => commitCol(colAtCdfX(evX(e, cdfCvs)));
        bandsCvs.onmousemove = e => { const c = colAtBandX(evX(e, bandsCvs)); setHover(c ? c.id : null); };
        cdfCvs.onmousemove   = e => { const c = colAtCdfX(evX(e, cdfCvs));   setHover(c ? c.id : null); };
        bandsCvs.onmouseleave = () => setHover(null);
        cdfCvs.onmouseleave   = () => setHover(null);

        wrapper.append(cdfCvs, bandsCvs);
        contentDiv.appendChild(wrapper);
        container.append(hdr, statusEl, contentDiv);
    }

    const evX = (e, cvs) => e.clientX - cvs.getBoundingClientRect().left;

    // Disposition des colonnes avec, pour chacune, sa plage X côté bandes ET côté
    // CDF (alignées proportionnellement) — sert au survol et au clic des deux côtés.
    function columnRanges() {
        const bandDrawable = PANEL_W - LEFT_W - RIGHT_PAD;
        const cdfDrawable  = CDF_W - CDF_LPAD;
        return layout().map(({ col, x, w }) => ({
            col, x, w,
            cdfX: CDF_LPAD + ((x - LEFT_W) / bandDrawable) * cdfDrawable,
            cdfW: (w / bandDrawable) * cdfDrawable,
        }));
    }
    function colAtBandX(x) {
        for (const r of columnRanges()) if (x >= r.x && x < r.x + r.w) return r.col;
        return null;
    }
    function colAtCdfX(x) {
        for (const r of columnRanges()) if (x >= r.cdfX && x < r.cdfX + r.cdfW) return r.col;
        return null;
    }

    function setHover(id) {
        if (hoveredId === id) return;
        hoveredId = id;
        emitHighlight();
        redraw();   // reflète immédiatement, même en pause
    }

    // Choix effectivement mis en évidence : le survolé s'il y en a un, sinon
    // le choix engagé (sélection persistante), sinon rien.
    function effectiveChoice() {
        if (hoveredId != null) {
            const col = cols.find(c => c.id === hoveredId);
            if (col && col.state === 'live') return col.choice;
        }
        const committed = cols.find(c => c.choice.committed);
        return committed ? committed.choice : null;
    }
    let _lastEmitId = undefined;
    function emitHighlight() {
        const ch = effectiveChoice();
        const id = ch ? ch.id : null;
        if (id === _lastEmitId) return;   // éviter les ré-émissions inutiles
        _lastEmitId = id;
        onHighlightChoice?.(ch);
    }

    // Multiplicateur d'opacité de survol : la colonne survolée reste pleine,
    // les autres s'estompent (mise en évidence de la paire bande ↔ CDF).
    function hoverMul(col) {
        if (hoveredId == null) return 1;
        return col.id === hoveredId ? 1 : 0.22;
    }

    function commitCol(col) {
        if (!col || col.state !== 'live' || col.choice.committed) return;
        const tAbs = t0 + lastSimTime;
        if (engine.commit(col.id, tAbs)) {
            col.commitS = tAbs;
            col.choice = engine.getChoices(tAbs).find(c => c.id === col.id) ?? col.choice;
            onCommit?.(engine.getPlanTripIds());
            _lastEmitId = undefined;   // forcer la ré-émission (la sélection a changé)
            emitHighlight();
        }
    }

    function redraw() {
        if (collapsed || !bandsCtx) return;
        const tAbs = t0 + lastSimTime;
        drawBands(tAbs);
        drawCdf(tAbs);
    }

    // ── Synchronisation des colonnes avec le moteur ────────────────────────
    function syncCols(tAbs) {
        const live = engine.getChoices(tAbs);
        const liveIds = new Set(live.map(c => c.id));
        for (const col of cols) {
            if (col.state === 'live' && !liveIds.has(col.id)) {
                col.state = 'dead';
                col.diedS = tAbs;
            } else if (col.state === 'live') {
                const fresh = live.find(c => c.id === col.id);
                const wasCommitted = col.choice.committed;
                col.choice = fresh;
                if (fresh.committed && !wasCommitted) col.commitS = tAbs;
                if (!fresh.committed) col.commitS = null;
            }
        }
        const known = new Set(cols.map(c => c.id));
        for (const c of live) {
            if (!known.has(c.id)) {
                cols.push({ id: c.id, choice: c, state: 'live', diedS: null,
                            commitS: c.committed ? tAbs : null, u: 0.02 });
            }
        }
        cols = cols.filter(col => !(col.state === 'dead'
            && (col.u < 0.01 || tAbs - col.diedS > DEAD_S)));
    }

    // Animation des largeurs (au mur d'horloge — indépendant de la vitesse sim)
    function animate(tAbs, wallDt) {
        for (const col of cols) {
            const target = col.state === 'live'
                ? 1
                : Math.max(0, 1 - (tAbs - col.diedS) / DEAD_S);
            col.u += (target - col.u) * Math.min(1, wallDt * 3);
        }
    }

    // Disposition : x et largeur de chaque colonne (les nouvelles à droite)
    function layout() {
        const drawable = PANEL_W - LEFT_W - RIGHT_PAD;
        const totalU = cols.reduce((s, c) => s + c.u, 0);
        const unit = Math.min(COL_MAX_W, drawable / Math.max(1, totalU));
        let x = LEFT_W;
        const out = [];
        for (const col of cols) {
            const w = unit * col.u;
            out.push({ col, x, w });
            x += w;
        }
        return out;
    }

    // ── Dessin d'une colonne (bandes) ──────────────────────────────────────
    // anchor des legs glissants : maintenant (vivant), commit (engagé), mort (figé).
    function colAnchor(col, tAbs) {
        if (col.commitS != null) return col.commitS;
        if (col.state === 'dead') return col.diedS;
        return tAbs;
    }

    function drawColumn(c, col, x, w, tAbs) {
        if (w < 3) return;
        const ch    = col.choice;
        const xc    = x + w / 2;
        const halfW = Math.min(w / 2 - 1.5, BAND_HALF_MAX);
        const dead  = col.state === 'dead';
        const alpha = (dead ? 0.32 * Math.max(0.3, col.u) : 1.0) * hoverMul(col);
        const anchor = colAnchor(col, tAbs);
        const jr = ch.journeys[0];

        // Fond de mise en évidence quand survolée (lie visuellement à sa CDF)
        if (col.id === hoveredId) {
            c.save();
            c.globalAlpha = 0.10; c.fillStyle = '#ffffff';
            c.fillRect(x, TOP_PAD - 14, w, DRAW_H + 14);
            c.restore();
        }

        c.save();
        c.globalAlpha = alpha;

        // Étiquette : numéro de la ligne cible (couleur du circuit)
        const gCol = hex(LINE_COLORS[ch.lineId] ?? 0x888888);
        c.font = 'bold 9px monospace'; c.textAlign = 'center';
        c.fillStyle = gCol;
        const label = (ch.kind === 'final' ? '→fin' : ch.base) + (ch.committed ? ' ✓' : '');
        if (w > 18) c.fillText(label, xc, TOP_PAD - 6);

        // Legs — position temporelle : les legs `slides` sont ancrés à `anchor`
        let tCursor = anchor;
        const busLegs = [];
        for (const leg of jr.legs) {
            let tA, tB;
            if (leg.slides) {
                if (leg.type === 'walk') { tA = tCursor; tB = tCursor + leg.walk_s; }
                else                     { tA = tCursor; tB = leg.until_s; }
                tCursor = tB;
            } else {
                tA = leg.depart_s; tB = leg.arrive_s;
                tCursor = tB;
            }
            if (tB < tA) tB = tA;
            if (leg.type === 'walk')      drawWalk(c, xc, tA, tB, tAbs);
            else if (leg.type === 'wait') drawWait(c, xc, tA, tB, tAbs);
            else busLegs.push({ ...leg });
        }

        // Hexagones de bus (p10/p90 aux pointes, comme le Cas 6)
        for (const leg of busLegs) {
            const sgB = engine.evSig(leg.board_s,  leg.trip_id, tAbs);
            const sgA = engine.evSig(leg.alight_s, leg.trip_id, tAbs);
            const col2 = hex(LINE_COLORS[leg.line_id] ?? 0x888888);
            const yTopApex = btY(leg.alight_s + sgA.late,  tAbs);
            const yTopBody = btY(leg.alight_s - sgA.early, tAbs);
            const yBotApex = btY(leg.board_s  + sgB.late,  tAbs);
            const yBotBody = btY(leg.board_s  - sgB.early, tAbs);
            c.fillStyle = col2;
            c.beginPath();
            c.moveTo(xc,         yTopApex);
            c.lineTo(xc + halfW, yTopBody);
            c.lineTo(xc + halfW, yBotBody);
            c.lineTo(xc,         yBotApex);
            c.lineTo(xc - halfW, yBotBody);
            c.lineTo(xc - halfW, yTopBody);
            c.closePath();
            c.fill();
            const yMid = (btY(leg.board_s, tAbs) + btY(leg.alight_s, tAbs)) / 2;
            if (w > 18 && btY(leg.board_s, tAbs) - btY(leg.alight_s, tAbs) > 14) {
                c.font = 'bold 8px monospace'; c.textAlign = 'center';
                strokeLabel(c, leg.base, xc, yMid + 3, 'rgba(255,255,255,0.95)');
            }
        }

        // Rectangles de risque sur les transferts serrés (chevauchement p10/p90)
        const pulse = 0.4 + 0.25 * Math.abs(Math.sin(Date.now() / 500));
        for (let i = 0; i < busLegs.length - 1; i++) {
            const a = busLegs[i], b = busLegs[i + 1];
            const sgA = engine.evSig(a.alight_s, a.trip_id, tAbs);
            const sgB = engine.evSig(b.board_s,  b.trip_id, tAbs);
            const tLo = b.board_s - sgB.early;
            const tHi = a.alight_s + sgA.late;
            if (tLo >= tHi) continue;
            const yT = btY(tHi, tAbs), yB = btY(tLo, tAbs);
            c.save();
            c.globalAlpha = alpha * pulse;
            c.fillStyle = '#ff2020';
            c.fillRect(xc - halfW, yT, halfW * 2, yB - yT);
            c.restore();
        }

        // Cadre autour de la colonne engagée
        if (ch.committed && w > 8) {
            c.strokeStyle = USER_COLOR; c.lineWidth = 1;
            c.setLineDash([]);
            c.strokeRect(x + 1, TOP_PAD - 14, w - 2, DRAW_H + 14);
        }
        c.restore();
    }

    function drawWalk(c, xc, tA, tB, tAbs) {
        const yA = btY(tA, tAbs), yB = btY(tB, tAbs);
        c.save();
        c.fillStyle = USER_COLOR;
        for (let y = yA; y > yB; y -= 5) {
            c.beginPath(); c.arc(xc, y, 1.6, 0, Math.PI * 2); c.fill();
        }
        c.restore();
    }

    function drawWait(c, xc, tA, tB, tAbs) {
        const yA = btY(tA, tAbs), yB = btY(tB, tAbs);
        if (yA - yB < 1) return;
        c.save();
        c.strokeStyle = USER_COLOR; c.globalAlpha *= 0.35; c.lineWidth = 1.2;
        c.beginPath(); c.moveTo(xc, yA); c.lineTo(xc, yB); c.stroke();
        c.restore();
    }

    // ── Canvas bandes ──────────────────────────────────────────────────────
    function drawBands(tAbs) {
        const c = bandsCtx;
        c.clearRect(0, 0, PANEL_W, H);

        // Grille des heures (défile avec la fenêtre)
        c.font = '9px monospace'; c.textAlign = 'right';
        const tLo = tAbs - PAST_S, tHi = tAbs + FUT_S;
        for (let t = Math.ceil(tLo / 900) * 900; t <= tHi; t += 900) {
            const y = btY(t, tAbs);
            if (y < TOP_PAD - 1 || y > TOP_PAD + DRAW_H + 1) continue;
            c.fillStyle = '#243040';
            c.fillRect(LEFT_W - 1, y, PANEL_W - LEFT_W - RIGHT_PAD + 1, 1);
            c.fillStyle = '#778899';
            c.fillText(fmtT(t), LEFT_W - 4, y + 3);
        }

        // Colonnes
        for (const { col, x, w } of layout()) drawColumn(c, col, x, w, tAbs);

        // Ligne « maintenant » (hauteur fixe)
        c.save();
        c.strokeStyle = '#ffee55'; c.lineWidth = 1.5; c.globalAlpha = 0.75;
        c.setLineDash([3, 3]);
        c.beginPath(); c.moveTo(LEFT_W, Y_NOW); c.lineTo(PANEL_W - RIGHT_PAD, Y_NOW); c.stroke();
        c.restore();

        // États particuliers
        const st = engine.getState(tAbs);
        if (st.mode === 'arrived') {
            c.font = 'bold 11px monospace'; c.textAlign = 'center';
            strokeLabel(c, `Arrivé ✓`, (LEFT_W + PANEL_W) / 2, Y_NOW - 10, '#66ff99');
        } else if (!cols.some(cl => cl.state === 'live')) {
            c.fillStyle = '#99aabb'; c.font = '10px monospace'; c.textAlign = 'center';
            c.fillText('Aucun trajet possible dans les horaires chargés', (LEFT_W + PANEL_W) / 2, Y_NOW - 10);
        }
    }

    // ── Canvas CDF ─────────────────────────────────────────────────────────
    function drawCdf(tAbs) {
        const c = cdfCtx;
        c.clearRect(0, 0, CDF_W, H);
        c.fillStyle = '#0d1824';
        c.fillRect(0, 0, CDF_W, H);

        const tLo = tAbs - PAST_S, tHi = tAbs + FUT_S;
        c.font = '8px monospace'; c.textAlign = 'right';
        for (let t = Math.ceil(tLo / 900) * 900; t <= tHi; t += 900) {
            const y = btY(t, tAbs);
            if (y < TOP_PAD - 1 || y > TOP_PAD + DRAW_H + 1) continue;
            c.fillStyle = '#1b2a3a';
            c.fillRect(CDF_LPAD, y, CDF_W - CDF_LPAD, 1);
        }
        c.fillStyle = '#556677'; c.font = 'bold 8px monospace'; c.textAlign = 'center';
        c.fillText("prob. d'arrivée", CDF_W / 2, 12);

        // Curseur « maintenant »
        c.save();
        c.strokeStyle = '#ffee55'; c.lineWidth = 1; c.globalAlpha = 0.45;
        c.setLineDash([3, 3]);
        c.beginPath(); c.moveTo(CDF_LPAD, Y_NOW); c.lineTo(CDF_W, Y_NOW); c.stroke();
        c.restore();

        // Une tranche par colonne, alignée proportionnellement sur les bandes
        const bandDrawable = PANEL_W - LEFT_W - RIGHT_PAD;
        const cdfDrawable  = CDF_W - CDF_LPAD;
        for (const { col, x, w } of layout()) {
            if (col.state !== 'live' || w < 6) continue;
            const ch = col.choice;
            const xBase = CDF_LPAD + ((x - LEFT_W) / bandDrawable) * cdfDrawable;
            const maxW  = (w / bandDrawable) * cdfDrawable - 3;
            if (maxW < 4) continue;
            const { pts, p90First } = engine.choiceCdf(ch, tAbs, tLo);
            if (pts.length < 2) continue;
            const gCol = hex(LINE_COLORS[ch.lineId] ?? 0x888888);
            const hm = hoverMul(col);

            // Fond de mise en évidence quand survolée (lie visuellement à sa bande)
            if (col.id === hoveredId) {
                c.save();
                c.globalAlpha = 0.10; c.fillStyle = '#ffffff';
                c.fillRect(xBase, TOP_PAD - 12, maxW + 3, DRAW_H + 12);
                c.restore();
            }

            c.save();
            c.beginPath();
            c.moveTo(xBase, btY(pts[0].t, tAbs));
            c.lineTo(xBase, btY(pts[pts.length - 1].t, tAbs));
            for (let i = pts.length - 1; i >= 0; i--) {
                c.lineTo(xBase + pts[i].cumP * maxW, btY(pts[i].t, tAbs));
            }
            c.closePath();
            c.fillStyle = gCol; c.globalAlpha = 0.18 * hm;
            c.fill();

            c.beginPath();
            pts.forEach(({ t, cumP }, i) => {
                const px = xBase + cumP * maxW;
                const py = btY(t, tAbs);
                if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
            });
            c.globalAlpha = 0.9 * hm; c.strokeStyle = gCol; c.lineWidth = 1.5;
            c.stroke();
            c.restore();

            // Marqueur « p90 le plus tôt » + heure
            if (p90First != null && p90First <= tHi && p90First >= tLo) {
                const yM = btY(p90First, tAbs);
                c.save();
                c.globalAlpha = hm;
                c.strokeStyle = gCol; c.lineWidth = 1.5;
                c.beginPath(); c.moveTo(xBase, yM); c.lineTo(xBase + maxW, yM); c.stroke();
                if (maxW > 26) {
                    const lbl = fmtT(p90First);
                    c.font = 'bold 8px monospace'; c.textAlign = 'center';
                    const cx = xBase + maxW / 2;
                    const wl = c.measureText(lbl).width;
                    c.fillStyle = 'rgba(8,14,22,0.92)';
                    c.fillRect(cx - wl / 2 - 2, yM - 6, wl + 4, 11);
                    c.fillStyle = gCol;
                    c.fillText(lbl, cx, yM + 2.5);
                }
                c.restore();
            }
        }
    }

    // ── Ligne d'état ───────────────────────────────────────────────────────
    function updateStatus(tAbs) {
        const st = engine.getState(tAbs);
        const txt = {
            foot:    'À pied — cliquer une colonne pour s\'engager.',
            walking: 'En marche… (changer d\'idée = cliquer un autre choix)',
            waiting: 'En attente à l\'arrêt…',
            riding:  'À bord — choisir où descendre.',
            arrived: `Arrivé à ${fmtT(tAbs)} ✓`,
        }[st.mode] ?? '';
        const mode3d = st.mode === 'riding' && st.ti != null;
        statusEl.textContent = mode3d
            ? `À bord de la ${engine.getPassenger(tAbs).line_id ?? ''} — choisir où descendre.`
            : txt;
    }

    // ── API ────────────────────────────────────────────────────────────────
    let lastSimTime = 0;

    build();

    return {
        update(simTime) {
            lastSimTime = simTime;
            const tAbs = t0 + simTime;
            const wallNow = performance.now();
            const wallDt = lastWall != null ? Math.min(0.25, (wallNow - lastWall) / 1000) : 0.016;
            lastWall = wallNow;
            syncCols(tAbs);
            animate(tAbs, wallDt);
            if (!collapsed) {
                drawBands(tAbs);
                drawCdf(tAbs);
                updateStatus(tAbs);
            }
        },
        reset() {
            cols = [];
            lastWall = null;
        },
        dispose() {
            container.innerHTML = '';
            bandsCvs = null; bandsCtx = null; cdfCvs = null; cdfCtx = null;
        },
    };
}

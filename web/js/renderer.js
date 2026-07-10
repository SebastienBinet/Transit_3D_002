// Seul fichier qui importe Three.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { progressToLatLon, estimateArrival, estimateTimeAtProgress, interpolate, progressToHeading, shapeCumulativeDist, densifyTrajFull } from './interpolation.js';
import { create as createWindowsMode } from './viz-mode-windows.js';
import { create as createForkMode }   from './viz-mode-fork.js';
import { create as createWalkMode }   from './viz-mode-walk.js';
import { createAnimatedFlag } from './flag-animation.js';
import { logEvent } from './diagnostics.js';
import { LINE_COLORS } from './colors.js';

const SUGGEST_THRESHOLD = 0.50;
const TIME_SCALE = 2.5;
const LAT_M = 111_000;
const WALKING_SPEED_MPS = 1.4;   // vitesse de marche typique
const MAX_ROT_PER_S = Math.PI / 2; // 90°/s — limite de rotation des icônes d'autobus

let scene, camera, webglRenderer, controls, labelRenderer;
// timeGroup : groupe décalé en Y = −currentSimTime × TIME_SCALE à 60 fps.
// Tous les objets espace-temps (trajectoires, drapeaux d'arrivée, viz modes, bonhomme)
// y sont ajoutés avec une position Y absolue (t × TIME_SCALE).
// Le décalage continu élimine les sauts discrets sans rebuilder les géométries.
let timeGroup;
// Grille temporelle : un rectangle (aux dimensions de la carte) toutes les 30 min,
// avec l'heure locale étiquetée aux 4 coins. Dans timeGroup → glisse avec le temps.
let timeGridGroup = null;
const timeGridLabels = [];   // CSS2DObject — visibilité gérée séparément des Line
let latCenter, lonCenter, lonM;
let vehicleObjects = []; // dans timeGroup — vidés/reconstruits à chaque frame
let groundObjects  = []; // dans scene (Y = 0) — icônes d'autobus + drapeaux au sol
let stopSpheresGroup = null; // pastilles d'arrêts au sol — masquées en mode cohorte
let nowPlane;
let pendingFrame = null;
export let lastDrawMs = 0;

const animatedFlags = []; // { handle, urgencyFn } — animés à 60 fps en temps réel

// Rotation actuelle par véhicule — persistante entre frames pour le rate-limiting
const busRotations = new Map();
let _prevDrawNow = 0;

let currentSimTime = 0;
export function updateSimTime(t) { currentSimTime = t; }

// ── Sprites de passagers (Cas 6 et futurs cas de trajets) ─────────────────
// Mis à jour à chaque tick RAF via _getPassengerPositions(tAbs), indépendamment
// du pas de frame (position fluide même entre deux frames de simulation).
const passengerSprites = [];  // Three.Sprite[], dans scene (Y=0)
let _getPassengerPositions = null;  // (tAbs) => [{lat,lon,color,phase}] | null
let _t0ForPassengers = 0;           // secondes depuis minuit pour tAbs = t0 + simTime

// Initialise les sprites de passagers. Appelé après init() depuis index.html.
export function initPassengers(count, colors) {
    for (const s of passengerSprites) { scene.remove(s); s.material.map?.dispose(); s.material.dispose(); }
    passengerSprites.length = 0;
    for (let i = 0; i < count; i++) {
        const s = makePersonSprite(colors[i] ?? 0xffffff);
        s.scale.set(180, 270, 1);   // légèrement plus petit que les cas 1/2
        s.visible = false;
        scene.add(s);
        passengerSprites.push(s);
    }
}

// Enregistre la fonction de position continue. null = désactiver.
export function setPassengerSource(fn) { _getPassengerPositions = fn; }

// Fixe t0 (sec depuis minuit) : tAbs = t0 + currentSimTime envoyé à la source.
export function setPassengerT0(t0) { _t0ForPassengers = t0; }

// Surlignage sélectif d'un sous-ensemble de trips (Cas 6 : clic sur trajet dans la vignette).
// null = pas de filtre (tous égaux). Set<trip_id> = seuls ces trips sont pleine opacité.
let _highlightedJourneyTripIds = null;
export function setJourneyHighlight(tripIds) {
    _highlightedJourneyTripIds = tripIds ? new Set(tripIds) : null;
}

// ── Flux de bonhommes de surlignage (Cas 7) ───────────────────────────────
// Un choix survolé/sélectionné anime un flux de bonhommes le long de son trajet,
// en TEMPS MACHINE (mur d'horloge), indépendant de play/pause et de la vitesse
// sim ×N. Trois modes : 'spacetime' (montent l'axe du temps sur la trajectoire
// 3D), 'ground' (au sol, sur le tracé géographique) ou 'both' (les deux + une
// ligne verticale reliant chaque paire sol↔espace-temps).
const STREAM_CAP = 150;             // nb max de bonhommes affichés
const streamFigures = [];           // pool de { ground:Sprite, sky:Sprite, line:Line }
const streamGlows = [];             // halos aux arrêts (attente) — 1 par grappe
let _streamReals = null;            // [{prob, path, cum}] | null — réalisations du choix
let _streamMode = 'ground';         // 'spacetime' | 'ground' | 'both'
let _streamSpacingS = 1;            // espacement des bonhommes en temps-trajet (s)
let _streamSpeedMul = 100;          // vitesse machine : temps-trajet / temps-mur

// Fixe (ou efface) les RÉALISATIONS à animer : [{prob, path}] (item 4). Chaque
// bonhomme est réparti sur une réalisation selon sa probabilité → le paquet se
// scinde aux correspondances risquées. Un simple trajet = une réalisation prob 1.
export function setHighlightStream(reals) {
    if (!reals || !reals.length) { _streamReals = null; return; }
    let c = 0;
    _streamReals = reals.filter(r => r.path).map(r => { c += r.prob; return { prob: r.prob, path: r.path, cum: c }; });
    if (!_streamReals.length) _streamReals = null;
}
export function setStreamParams({ mode, spacingS, speedMul } = {}) {
    if (mode != null)     _streamMode = mode;
    if (spacingS != null) _streamSpacingS = Math.max(1, spacingS);
    if (speedMul != null) _streamSpeedMul = Math.max(1, speedMul);
}

// ── Cohorte (mode « 1000 bonhommes ») ──────────────────────────────────────
// À l'entrée du mode on lâche `size` voyageurs au départ ; ils se répartissent
// sur les options (moteur getCohort, déterministe par quantiles), avancent le
// long de leur trajectoire en TEMPS MACHINE, et quand tous sont arrivés la
// vague se relance (recalculée au « maintenant » courant). Rendu efficace via
// THREE.Points (un seul draw call par couche) pour tenir 1000+ figures.
// COULEUR = premier bus emprunté (même palette LINE_COLORS que les CDF du
// panneau, les tracés carte et les cônes 3D) : le « bleu » du CDF = l'essaim
// bleu. Le RISQUE se lit à la CONCENTRATION — un essaim compact et vif arrive
// groupé (fiable) ; une traînée diffuse et étalée = correspondances ratées,
// arrivées dispersées (risqué). Les retardataires reroutés gardent leur couleur
// de 1er bus : c'est la dispersion, pas une teinte à part, qui dit le risque.
const COHORT_DRAW = 180;       // bonhommes DESSINÉS (sous-échantillon lisible du 1000)
const COHORT_JITTER = 130;     // dispersion locale (m) — sépare une foule en nuage lisible
const COHORT_CELL = 220;       // taille de cellule pour regrouper les halos de densité
let _cohort = null;            // { agents, baseStartS, waveEndS } | null
let _cohortActive = false;
let _cohortMode = 'ground';    // partage l'axe sol / espace-temps / les-deux
let _cohortSpeedMul = 100;
let _cohortSource = null;      // (nowAbs) => cohort|null — reconstruction à la relance
let _cohortWall0 = 0;          // origine temps-mur de la vague (ms)
let _cohortCycle = -1;         // n° de vague courante (détection de relance)
let cohortGround = null, cohortSky = null, cohortLines = null;
const cohortGlows = [];        // halos de densité par (couleur, cellule)
let _cohortPosG = null, _cohortPosS = null, _cohortLinePos = null;
let _cohortDraw = null;        // sous-échantillon dessiné [{a, jx, jz, hex}]
let _discTex = null, _cohortGlowTex = null;

export function setCohortSource(fn) { _cohortSource = fn; }
export function setCohortParams({ mode, speedMul } = {}) {
    if (mode != null)     _cohortMode = mode;
    if (speedMul != null) _cohortSpeedMul = Math.max(1, speedMul);
}
export function setCohortActive(on) {
    _cohortActive = !!on;
    if (stopSpheresGroup) stopSpheresGroup.visible = !_cohortActive;   // pastilles d'arrêts masquées en cohorte
    if (_cohortActive) {
        _cohortWall0 = performance.now();
        _cohortCycle = -1;
        if (_cohortSource) applyCohort(_cohortSource(_t0ForPassengers + currentSimTime));
    } else if (cohortGround) {
        cohortGround.visible = cohortSky.visible = cohortLines.visible = false;
        for (const g of cohortGlows) g.visible = false;
    }
}

// Disque doux pour les points (rond, bord fondu).
function discTexture() {
    if (_discTex) return _discTex;
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.65, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    _discTex = new THREE.CanvasTexture(c);
    return _discTex;
}

// Halo doux BLANC (teintable par material.color) pour la densité locale.
function cohortGlowTexture() {
    if (_cohortGlowTex) return _cohortGlowTex;
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.32)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    _cohortGlowTex = new THREE.CanvasTexture(c);
    return _cohortGlowTex;
}

function cohortHex(a) { return LINE_COLORS[a.lineId] ?? 0xffffff; }
function hexToRgb(hex) { return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]; }

function makeCohortObjects() {
    const mkPts = () => {
        const mat = new THREE.PointsMaterial({ size: 165, map: discTexture(), vertexColors: true,
            transparent: true, opacity: 0.82, depthWrite: false, sizeAttenuation: true, alphaTest: 0.28 });
        const p = new THREE.Points(new THREE.BufferGeometry(), mat);
        p.visible = false; p.frustumCulled = false; scene.add(p); return p;
    };
    cohortGround = mkPts();
    cohortSky = mkPts();
    cohortLines = new THREE.LineSegments(new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.18 }));
    cohortLines.visible = false; cohortLines.frustumCulled = false; scene.add(cohortLines);
}
function ensureCohortGlows(n) {
    while (cohortGlows.length < n) {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: cohortGlowTexture(),
            transparent: true, depthWrite: false }));
        s.visible = false; scene.add(s); cohortGlows.push(s);
    }
}

// (Re)construit les tampons : sous-échantillonne 1 sur ~stride (la résolution
// vient des 1000, la LISIBILITÉ du sous-échantillon), applique un jitter
// déterministe (angle d'or) pour éclater les foules, fixe la couleur = 1er bus.
function applyCohort(cohort) {
    _cohort = cohort;
    if (!cohort) { if (cohortGround) { cohortGround.visible = cohortSky.visible = cohortLines.visible = false; for (const g of cohortGlows) g.visible = false; } return; }
    if (!cohortGround) makeCohortObjects();
    const agents = cohort.agents;
    const stride = Math.max(1, Math.round(agents.length / COHORT_DRAW));
    const draw = [];
    for (let i = 0; i < agents.length; i += stride) {
        const k = draw.length;
        const ang = k * 2.399963229728653;                       // angle d'or
        const rad = COHORT_JITTER * Math.sqrt(((k % 64) + 0.5) / 64);
        draw.push({ a: agents[i], jx: Math.cos(ang) * rad, jz: Math.sin(ang) * rad, hex: cohortHex(agents[i]) });
    }
    _cohortDraw = draw;
    const n = draw.length;
    _cohortPosG = new Float32Array(n * 3);
    _cohortPosS = new Float32Array(n * 3);
    _cohortLinePos = new Float32Array(n * 6);
    const col = new Float32Array(n * 3);
    const lineCol = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
        const [r, g, b] = hexToRgb(draw[i].hex);
        col[3 * i] = r; col[3 * i + 1] = g; col[3 * i + 2] = b;
        lineCol[6 * i] = r;     lineCol[6 * i + 1] = g; lineCol[6 * i + 2] = b;
        lineCol[6 * i + 3] = r; lineCol[6 * i + 4] = g; lineCol[6 * i + 5] = b;
    }
    cohortGround.geometry.setAttribute('position', new THREE.BufferAttribute(_cohortPosG, 3));
    cohortGround.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    cohortSky.geometry.setAttribute('position', new THREE.BufferAttribute(_cohortPosS, 3));
    cohortSky.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    cohortLines.geometry.setAttribute('position', new THREE.BufferAttribute(_cohortLinePos, 3));
    cohortLines.geometry.setAttribute('color', new THREE.BufferAttribute(lineCol, 3));
}

// Une frame de cohorte (appelée depuis la boucle RAF, temps-machine `now` en ms).
function renderCohortFrame(now) {
    const waveDur0 = Math.max(1, _cohort.waveEndS - _cohort.baseStartS);
    const wallTau = ((now - _cohortWall0) / 1000) * _cohortSpeedMul;
    const nowAbs = _t0ForPassengers + currentSimTime;
    const cyc = Math.floor(wallTau / waveDur0);
    if (cyc !== _cohortCycle) {                    // relance immédiate (aucun silence)
        _cohortCycle = cyc;
        if (_cohortSource && cyc > 0) { const fresh = _cohortSource(nowAbs); if (fresh) applyCohort(fresh); }
    }
    const draw = _cohortDraw, n = draw.length;
    const waveDur = Math.max(1, _cohort.waveEndS - _cohort.baseStartS);
    const phase = wallTau % waveDur;
    const wSimT = _cohort.baseStartS + phase;
    const FEET_Y = 118 * (150 / 180);
    const showG = _cohortMode === 'ground' || _cohortMode === 'both';
    const showS = _cohortMode === 'spacetime' || _cohortMode === 'both';
    const showLine = _cohortMode === 'both';
    const OFF = -1e7;
    // clusters de densité par (couleur, cellule) → halos
    const clusters = new Map();
    for (let i = 0; i < n; i++) {
        const d = draw[i], a = d.a;
        const tq = wSimT - a.delayS;               // temps-trajet interrogé
        let gx = 0, gz = 0, gy = OFF, sy = OFF, vis = false;
        if (tq >= a.path.startS && tq <= a.path.endS) {
            const pos = a.path.sampleAbs(tq);
            if (pos) {
                const w = geoPos(pos.lat, pos.lon);
                gx = w.x + d.jx; gz = w.z + d.jz; gy = FEET_Y;
                sy = (tq - nowAbs) * TIME_SCALE + FEET_Y;
                vis = true;
                const key = a.lineId + ',' + Math.round(gx / COHORT_CELL) + ',' + Math.round(gz / COHORT_CELL);
                let e = clusters.get(key);
                if (!e) { e = { sx: 0, sz: 0, sy: 0, cnt: 0, hex: d.hex }; clusters.set(key, e); }
                e.sx += gx; e.sz += gz; e.sy += sy; e.cnt++;
            }
        }
        _cohortPosG[3 * i] = showG && vis ? gx : 0;
        _cohortPosG[3 * i + 1] = showG && vis ? gy : OFF;
        _cohortPosG[3 * i + 2] = showG && vis ? gz : 0;
        _cohortPosS[3 * i] = showS && vis ? gx : 0;
        _cohortPosS[3 * i + 1] = showS && vis ? sy : OFF;
        _cohortPosS[3 * i + 2] = showS && vis ? gz : 0;
        if (showLine && vis) {
            _cohortLinePos[6 * i] = gx;     _cohortLinePos[6 * i + 1] = gy; _cohortLinePos[6 * i + 2] = gz;
            _cohortLinePos[6 * i + 3] = gx; _cohortLinePos[6 * i + 4] = sy; _cohortLinePos[6 * i + 5] = gz;
        } else {
            _cohortLinePos[6 * i] = 0; _cohortLinePos[6 * i + 1] = OFF; _cohortLinePos[6 * i + 2] = 0;
            _cohortLinePos[6 * i + 3] = 0; _cohortLinePos[6 * i + 4] = OFF; _cohortLinePos[6 * i + 5] = 0;
        }
    }
    cohortGround.geometry.attributes.position.needsUpdate = true;
    cohortSky.geometry.attributes.position.needsUpdate = true;
    cohortLines.geometry.attributes.position.needsUpdate = true;
    cohortGround.visible = showG;
    cohortSky.visible = showS;
    cohortLines.visible = showLine;

    // Halos de densité : une concentration locale d'une couleur « floute » en
    // clair dans sa teinte (intensité log ∝ nombre). Deux couleurs au même
    // endroit = deux halos superposés → on voit les deux présentes.
    ensureCohortGlows(clusters.size);
    let gi = 0;
    for (const e of clusters.values()) {
        if (e.cnt < 2) continue;                    // halo seulement s'il y a concentration
        const s = cohortGlows[gi++];
        const inten = Math.log(e.cnt + 1);
        s.visible = true;
        s.material.color.setHex(e.hex);
        s.material.opacity = Math.min(0.5, 0.13 * inten);
        const sz = 260 + 180 * inten;
        s.scale.set(sz, sz, 1);
        s.position.set(e.sx / e.cnt, showG ? FEET_Y + 4 : e.sy / e.cnt, e.sz / e.cnt);
    }
    for (; gi < cohortGlows.length; gi++) cohortGlows[gi].visible = false;
}

function ensureStreamFigures(n) {
    while (streamFigures.length < n) {
        const mk = () => { const s = makePersonSprite(0xffee66); s.scale.set(150, 225, 1); s.visible = false; scene.add(s); return s; };
        const lgeo = new THREE.BufferGeometry();
        lgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
        const line = new THREE.Line(lgeo, new THREE.LineBasicMaterial({ color: 0xffee66, transparent: true, opacity: 0.35 }));
        line.visible = false;
        scene.add(line);
        streamFigures.push({ ground: mk(), sky: mk(), line });
    }
}

function makeGlowSprite() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,238,102,0.95)');
    g.addColorStop(0.5, 'rgba(255,220,60,0.35)');
    g.addColorStop(1, 'rgba(255,220,60,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    const mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const s = new THREE.Sprite(mat); s.visible = false; scene.add(s);
    return s;
}
function ensureStreamGlows(n) { while (streamGlows.length < n) streamGlows.push(makeGlowSprite()); }

function clearStreamSprites() {
    for (const f of streamFigures) {
        for (const s of [f.ground, f.sky]) { scene?.remove(s); s.material.map?.dispose(); s.material.dispose(); }
        scene?.remove(f.line); f.line.geometry.dispose(); f.line.material.dispose();
    }
    for (const g of streamGlows) { scene?.remove(g); g.material.map?.dispose(); g.material.dispose(); }
    streamFigures.length = 0;
    streamGlows.length = 0;
    _streamReals = null;
    for (const o of [cohortGround, cohortSky, cohortLines]) {
        if (o) { scene?.remove(o); o.geometry.dispose(); o.material.map?.dispose?.(); o.material.dispose(); }
    }
    for (const g of cohortGlows) { scene?.remove(g); g.material.map?.dispose?.(); g.material.dispose(); }
    cohortGlows.length = 0;
    cohortGround = cohortSky = cohortLines = null;
    _cohort = null; _cohortActive = false; _cohortSource = null; _cohortDraw = null;
}

function clearPassengers() {
    for (const s of passengerSprites) { scene?.remove(s); s.material.map?.dispose(); s.material.dispose(); }
    passengerSprites.length = 0;
    _getPassengerPositions = null;
    _t0ForPassengers = 0;
    _highlightedJourneyTripIds = null;
    clearStreamSprites();
}

// Affichage du ruban d'incertitude p10–p90. Décoché par défaut (lecture allégée).
let showUncertainty = false;
export function setShowUncertainty(v) { showUncertainty = !!v; refreshTimeGridVisible(); }

// Affichage de la ligne médiane p50. Coché par défaut. Quand p50 ET p10–p90 sont
// décochés, aucune trajectoire 3D n'est dessinée : il ne reste que les tracés au
// sol et la position courante des autobus.
let showP50 = true;
export function setShowP50(v) { showP50 = !!v; refreshTimeGridVisible(); }

// La grille temporelle n'a de sens que si au moins une couche espace-temps
// (p50 ou p10–p90) est affichée ; sinon il ne reste que la carte au sol.
function refreshTimeGridVisible() {
    if (!timeGridGroup) return;
    timeGridGroup.visible = showP50 || showUncertainty;
    // La visibilité fine de chaque label (temps passé) est gérée dans la boucle RAF.
}

// sec depuis minuit → heure locale lisible "7h30" (modulo 24 h).
function formatLocalClock(totalSec) {
    const s = ((Math.round(totalSec) % 86400) + 86400) % 86400;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h${m.toString().padStart(2, '0')}`;
}

// Construit un rectangle horizontal toutes les 30 min entre t0 et t0+2·horizon
// (couvre toute la plage qui défilera), aux dimensions de la carte, avec l'heure
// locale aux 4 coins. Ajouté dans timeGroup pour glisser avec le temps.
function buildTimeGrid(t0, horizonS, bounds) {
    timeGridGroup = new THREE.Group();
    timeGridLabels.length = 0;

    const xMin = (bounds.lon_min - lonCenter) * lonM;
    const xMax = (bounds.lon_max - lonCenter) * lonM;
    const zNorth = -(bounds.lat_max - latCenter) * LAT_M;
    const zSouth = -(bounds.lat_min - latCenter) * LAT_M;
    const corners = [[xMin, zNorth], [xMax, zNorth], [xMax, zSouth], [xMin, zSouth]];

    const STEP_S = 1800;   // 30 minutes
    const startMark = Math.floor(t0 / STEP_S) * STEP_S;
    const endMark   = t0 + 2 * horizonS;
    for (let tAbs = startMark; tAbs <= endMark + 1; tAbs += STEP_S) {
        const y = (tAbs - t0) * TIME_SCALE;
        const ring = new THREE.LineLoop(
            new THREE.BufferGeometry().setFromPoints(
                corners.map(([x, z]) => new THREE.Vector3(x, y, z))),
            new THREE.LineBasicMaterial({ color: 0x5577aa, opacity: 0.30, transparent: true }),
        );
        timeGridGroup.add(ring);

        const text = formatLocalClock(tAbs);
        const tAbsRel = tAbs - t0;   // secondes relatives à T0 (seuil de masquage)
        for (const [x, z] of corners) {
            const div = document.createElement('div');
            div.className = 'time-grid-label';
            div.textContent = text;
            const label = new CSS2DObject(div);
            label.position.set(x, y, z);
            label.tAbsRel = tAbsRel;
            timeGridGroup.add(label);
            timeGridLabels.push(label);
        }
    }
    timeGroup.add(timeGridGroup);
    refreshTimeGridVisible();
}

// timedObjects : uniquement les lignes de connexion dont le sommet inférieur
// doit rester ancré à Y = 0 monde (bottom = currentSimTime × TIME_SCALE dans timeGroup)
const timedObjects = [];

let activeVizMode = null;
let vizCtx = null;

function geoPos(lat, lon) {
    return new THREE.Vector3(
        (lon - lonCenter) * lonM, 0, -(lat - latCenter) * LAT_M,
    );
}

// Y absolu dans timeGroup — le décalage timeGroup.position.y ramène à l'espace relatif
function worldPos(lat, lon, t) {
    return new THREE.Vector3(
        (lon - lonCenter) * lonM,
        t * TIME_SCALE,
        -(lat - latCenter) * LAT_M,
    );
}

function disposeObj(obj) {
    obj.traverse(child => {
        child.geometry?.dispose();
        if (child.material) { child.material.map?.dispose(); child.material.dispose(); }
    });
}

function clearVehicles() {
    for (const obj of vehicleObjects) { timeGroup.remove(obj); disposeObj(obj); }
    vehicleObjects = [];
    for (const obj of groundObjects)  { scene.remove(obj);     disposeObj(obj); }
    groundObjects = [];
    timedObjects.length = 0;
    animatedFlags.length = 0;
}

// Double-passe pour épaisseur visuelle (WebGL ignore linewidth > 1)
function addBoldLine(pts, color, opacity) {
    const g1 = new THREE.BufferGeometry().setFromPoints(pts);
    const l1 = new THREE.Line(g1, new THREE.LineBasicMaterial({ color, opacity, transparent: true }));
    l1.renderOrder = 1;
    timeGroup.add(l1); vehicleObjects.push(l1);
    const g2 = new THREE.BufferGeometry().setFromPoints(pts);
    const l2 = new THREE.Line(g2, new THREE.LineBasicMaterial({ color: 0xffffff, opacity: opacity * 0.40, transparent: true }));
    l2.renderOrder = 1;
    timeGroup.add(l2); vehicleObjects.push(l2);
}

// Sprite bonhomme billboard (toujours face caméra) — représente le voyageur
function makePersonSprite(color) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 96;
    const ctx = c.getContext('2d');
    const hex = '#' + color.toString(16).padStart(6, '0');
    ctx.strokeStyle = hex; ctx.fillStyle = hex;
    ctx.lineWidth = 7; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(32, 14, 12, 0, Math.PI * 2); ctx.fill();   // tête
    ctx.beginPath(); ctx.moveTo(32, 26); ctx.lineTo(32, 60); ctx.stroke(); // corps
    ctx.beginPath(); ctx.moveTo(10, 40); ctx.lineTo(54, 40); ctx.stroke(); // bras
    ctx.beginPath();
    ctx.moveTo(32, 60); ctx.lineTo(14, 90);
    ctx.moveTo(32, 60); ctx.lineTo(50, 90);
    ctx.stroke(); // jambes
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(260, 390, 1); // proportionnel au canvas 64:96
    return sprite;
}

// Sprite billboard affichant l'heure estimée de départ d'un bus depuis un arrêt.
// Symbole ▶ + temps en format m:ss, couleur du circuit.
// Placé à gauche (−X, côté Ouest) du point de départ dans le diagramme espace-temps.
function makeDepartureLabel(THREE, timeS, color) {
    const mins = Math.floor(timeS / 60);
    const secs = Math.round(timeS % 60);
    const text = `▶ ${mins}:${secs.toString().padStart(2, '0')}`;
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    const hex = '#' + color.toString(16).padStart(6, '0');
    ctx.font = 'bold 28px monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = hex;
    ctx.fillText(text, 128, 32);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(768, 192, 1);
    return sprite;
}

// Icône d'autobus pour la vue carte (Y = 0)
function makeBusIcon(color) {
    const emissive = new THREE.Color(color).multiplyScalar(0.35);
    const mat = (h, w, d) => new THREE.Mesh(
        new THREE.BoxGeometry(h, w, d),
        new THREE.MeshLambertMaterial({ color, emissive }),
    );
    const body = mat(200, 80, 120);
    const roof = mat(155, 40, 100);
    roof.position.y = 60;
    const group = new THREE.Group();
    group.add(body, roof);
    group.position.y = 40;
    group.rotation.y = Math.PI / 2;
    return group;
}

const DWELL_THRESHOLD_S = 300; // seuil dwell ≥ 5 min pour afficher arrivée + départ distincts

function makeStopMarker(color) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
    ctx.font = 'bold 48px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('▶', 32, 36);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(150, 150, 1);
    sprite.renderOrder = 3;
    return sprite;
}

export function init(canvas, config) {
    const { routes, transferWindows: tw = [], mapBackground = null, stopEvents: se = [], timeGrid = null } = config;

    timeGridGroup = null;
    timeGridLabels.length = 0;
    clearPassengers();

    const allLats = routes.flatMap(r => r.shape.map(p => p.lat));
    const allLons = routes.flatMap(r => r.shape.map(p => p.lon));
    latCenter = (Math.min(...allLats) + Math.max(...allLats)) / 2;
    lonCenter = (Math.min(...allLons) + Math.max(...allLons)) / 2;
    lonM = LAT_M * Math.cos(latCenter * Math.PI / 180);
    currentSimTime = 0;
    busRotations.clear();
    _prevDrawNow = 0;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a12);
    scene.fog = new THREE.Fog(0x0a0a12, 14000, 32000);

    timeGroup = new THREE.Group();
    scene.add(timeGroup);

    const w = canvas.clientWidth || canvas.width || 800;
    const h = canvas.clientHeight || canvas.height || 600;
    camera = new THREE.PerspectiveCamera(55, w / h, 10, 50000);
    camera.position.set(1500, 7500, 9000);

    webglRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    webglRenderer.setSize(w, h, false);
    webglRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Renderer CSS2D pour les étiquettes d'heure (texte HTML net, superposé au canvas).
    // Créé une seule fois et réutilisé ; on vide ses div lors d'un changement de scène.
    if (!labelRenderer) {
        labelRenderer = new CSS2DRenderer();
        labelRenderer.domElement.style.cssText =
            'position:absolute; top:0; left:0; pointer-events:none; z-index:1;';
        canvas.parentElement.appendChild(labelRenderer.domElement);
    }
    labelRenderer.domElement.replaceChildren();   // retirer les étiquettes de la scène précédente
    labelRenderer.setSize(w, h);

    controls = new OrbitControls(camera, webglRenderer.domElement);
    controls.target.set(-400, 3000, 1100);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.update();

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const sun = new THREE.DirectionalLight(0xffffff, 0.7);
    sun.position.set(3000, 8000, 5000);
    scene.add(sun);

    // Fond de carte raster optionnel (tuiles OSM composées) — sous tous les autres objets à Y=−1
    if (mapBackground) {
        const { url, bounds } = mapBackground;
        const w_m = (bounds.lon_max - bounds.lon_min) * lonM;
        const h_m = (bounds.lat_max - bounds.lat_min) * LAT_M;
        const tex = new THREE.TextureLoader().load(url);
        tex.colorSpace = THREE.SRGBColorSpace;
        // flipY = true (défaut) : image-nord → plan +Y → monde -Z = Nord ✓ (convention Z inversée)
        const plane = new THREE.Mesh(
            new THREE.PlaneGeometry(w_m, h_m),
            new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.65, depthWrite: false }),
        );
        plane.renderOrder = -1;
        plane.rotation.x = -Math.PI / 2;
        plane.position.set(
            (bounds.lon_center - lonCenter) * lonM, -1,
            -(bounds.lat_center - latCenter) * LAT_M,
        );
        scene.add(plane);
    } else {
        scene.add(new THREE.GridHelper(10000, 20, 0x223344, 0x1a2a36));
    }

    // Tracés géographiques au sol (scene, Y=0 permanent). Les pastilles d'arrêts
    // vont dans un groupe pour pouvoir les masquer en mode cohorte (elles sont
    // teintées par la même palette LINE_COLORS que l'essaim et le brouilleraient).
    stopSpheresGroup = new THREE.Group();
    for (const route of routes) {
        const pts = route.shape.map(p => geoPos(p.lat, p.lon));
        scene.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(pts),
            new THREE.LineBasicMaterial({ color: LINE_COLORS[route.line_id] ?? 0x555555, opacity: 0.65, transparent: true }),
        ));
        const stopMat = new THREE.MeshBasicMaterial({ color: LINE_COLORS[route.line_id] ?? 0x555555 });
        for (const stop of route.stops) {
            const mesh = new THREE.Mesh(new THREE.SphereGeometry(45, 8, 8), stopMat);
            mesh.position.copy(geoPos(stop.position.lat, stop.position.lon));
            stopSpheresGroup.add(mesh);
        }
    }
    scene.add(stopSpheresGroup);

    // Marqueurs d'arrêts planifiés dans le diagramme espace-temps (timeGroup)
    for (const ev of se) {
        const route = routes.find(r => r.line_id === ev.line_id);
        if (!route) continue;
        const color = LINE_COLORS[ev.line_id] ?? 0x888888;
        const ll = progressToLatLon(ev.progress_m, route.shape);
        if (!ll) continue;
        const dwell = ev.t_dep - ev.t_arr;

        if (dwell >= DWELL_THRESHOLD_S) {
            // Attente longue (≥5 min) : ligne verticale + marqueurs d'arrivée et de départ
            const posArr = worldPos(ll.lat, ll.lon, ev.t_arr);
            const posDep = worldPos(ll.lat, ll.lon, ev.t_dep);
            const dwellLine = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints([posArr, posDep]),
                new THREE.LineBasicMaterial({ color, opacity: 0.85, transparent: true }),
            );
            dwellLine.renderOrder = 2;
            timeGroup.add(dwellLine);
            const mArr = makeStopMarker(color);
            mArr.position.copy(posArr);
            timeGroup.add(mArr);
            const mDep = makeStopMarker(color);
            mDep.position.copy(posDep);
            timeGroup.add(mDep);
        } else {
            // Passage rapide : marqueur unique au milieu du passage
            const tMid = (ev.t_arr + ev.t_dep) / 2;
            const posMid = worldPos(ll.lat, ll.lon, tMid);
            const m = makeStopMarker(color);
            m.position.copy(posMid);
            timeGroup.add(m);
        }
    }

    // Cônes des arrêts de transfert
    for (const win of tw) {
        const connLine = win.connector_vehicle_id.split('-')[0];
        const color = LINE_COLORS[connLine] ?? 0xffffff;
        const l42Route = routes.find(r => r.line_id === 'L42');
        const stop = l42Route?.stops.find(s => s.stop_id === win.stop_id);
        if (!stop) continue;
        const cone = new THREE.Mesh(
            new THREE.CylinderGeometry(0, 80, 220, 6),
            new THREE.MeshLambertMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(0.35) }),
        );
        cone.position.copy(geoPos(stop.position.lat, stop.position.lon));
        cone.position.y = 110;
        scene.add(cone);
    }

    nowPlane = new THREE.Mesh(
        new THREE.PlaneGeometry(12000, 12000),
        new THREE.MeshBasicMaterial({ color: 0x88aaff, transparent: true, opacity: 0.06, side: THREE.DoubleSide }),
    );
    nowPlane.rotation.x = Math.PI / 2;
    scene.add(nowPlane);
    nowPlane.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-6000, 0, 0), new THREE.Vector3(6000, 0, 0),
        ]),
        new THREE.LineBasicMaterial({ color: 0x88aaff, opacity: 0.5, transparent: true }),
    ));

    // Grille temporelle (étages de 30 min) — uniquement pour les cas avec horaires réels.
    if (timeGrid && timeGrid.bounds) {
        buildTimeGrid(timeGrid.t0Seconds, timeGrid.horizonS, timeGrid.bounds);
    }

    window.addEventListener('resize', () => {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        camera.aspect = w / h; camera.updateProjectionMatrix();
        webglRenderer.setSize(w, h, false);
        labelRenderer.setSize(w, h);
    });

    // vizCtx.scene = timeGroup : les modes viz ajoutent leurs objets dans l'espace-temps.
    // registerTimed(mesh, tAbsolu) : smooth Y entre les frames (sphères de marge, etc.)
    function registerTimed(obj, tAbs) { timedObjects.push({ obj, tAbs }); }
    vizCtx = { scene: timeGroup, routes, transferWindows: tw, worldPos, geoPos, progressToLatLon, estimateArrival, registerTimed };

    let _lastRafTs = 0;
    (function loop() {
        requestAnimationFrame(loop);
        const now = performance.now();
        const rafMs = _lastRafTs > 0 ? now - _lastRafTs : 0;
        _lastRafTs = now;

        if (pendingFrame) {
            const t0 = performance.now();
            const frameSim = pendingFrame.frame.sim_time;
            drawFrame(pendingFrame.frame, pendingFrame.routes);
            pendingFrame = null;
            lastDrawMs = performance.now() - t0;
            logEvent('drawFrame', { frameSim, currentSimTime, drawMs: Math.round(lastDrawMs * 10) / 10 });
        }

        // Décalage temporel lisse : toute la scène espace-temps glisse sans saut
        timeGroup.position.y = -currentSimTime * TIME_SCALE;

        // Masquer les étiquettes des étages déjà passés (CSS2DRenderer ignore la visibilité parent)
        if (timeGridLabels.length) {
            const gridOn = showP50 || showUncertainty;
            for (const label of timeGridLabels) {
                label.visible = gridOn && label.tAbsRel > currentSimTime;
            }
        }

        // Mise à jour lisse des objets temporels entre les frames
        for (const item of timedObjects) {
            if (item._isLine) {
                // Ligne de connexion : sommet bas ancré à Y=0 monde
                const pos = item.obj.geometry.attributes.position;
                pos.setY(0, currentSimTime * TIME_SCALE);
                pos.needsUpdate = true;
            } else if (item.tAbs != null) {
                // Objet enregistré par registerTimed : Y absolu calculé depuis tAbs
                item.obj.position.y = item.tAbs * TIME_SCALE;
            }
        }

        // Sprites de passagers — mis à jour à chaque tick RAF pour un mouvement fluide
        if (_getPassengerPositions && passengerSprites.length) {
            const tAbs = _t0ForPassengers + currentSimTime;
            const positions = _getPassengerPositions(tAbs);
            const wallT = now / 1000;

            // Regrouper par position (précision ~11 m) pour détecter les superpositions
            const groups = new Map();
            for (let i = 0; i < passengerSprites.length; i++) {
                const pos = positions[i];
                if (!pos || pos.lat == null) { passengerSprites[i].visible = false; continue; }
                const key = pos.lat.toFixed(4) + ',' + pos.lon.toFixed(4);
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push({ i, pos });
            }

            // Y cible : décaler le sprite pour mettre les pieds au sol (Y=0)
            // Sprite: scale 180×270, canvas 64×96, pieds à px 90 → offset = 270/2 − (6/96)*270 ≈ 118
            const FEET_Y = 118;
            const CIRCLE_R = 2;        // mètres
            const PERIOD_S = 2.0;      // secondes par tour complet

            for (const members of groups.values()) {
                const N = members.length;
                for (let k = 0; k < N; k++) {
                    const { i, pos } = members[k];
                    const base = geoPos(pos.lat, pos.lon);
                    const sprite = passengerSprites[i];
                    sprite.visible = true;
                    if (N >= 2) {
                        const angle = (2 * Math.PI * k / N) + (2 * Math.PI * wallT / PERIOD_S);
                        sprite.position.set(
                            base.x + CIRCLE_R * Math.sin(angle),
                            FEET_Y,
                            base.z + CIRCLE_R * Math.cos(angle),
                        );
                    } else {
                        sprite.position.set(base.x, FEET_Y, base.z);
                    }
                }
            }
        }

        // Flux de bonhommes de surlignage — TEMPS MACHINE (mur), indépendant de
        // play/pause et de la vitesse sim. Bonhommes espacés de _streamSpacingS en
        // temps-trajet, avançant à _streamSpeedMul × le temps mur, en boucle.
        if (_cohortActive && _cohort) {
            renderCohortFrame(now);
            for (const f of streamFigures) { f.ground.visible = f.sky.visible = f.line.visible = false; }
            for (const g of streamGlows) g.visible = false;
        } else if (_streamReals) {
            if (cohortGround) { cohortGround.visible = cohortSky.visible = cohortLines.visible = false; for (const g of cohortGlows) g.visible = false; }
            const maxDur = Math.max(..._streamReals.map(r => r.path.durationS));
            const nFig   = Math.min(STREAM_CAP, Math.max(2, Math.ceil(maxDur / _streamSpacingS)));
            ensureStreamFigures(nFig);
            const tau      = (now / 1000) * _streamSpeedMul;   // temps-trajet parcouru (s)
            const FEET_Y   = 118 * (150 / 180);                // offset pieds, échelle réduite
            const STACK_STEP = 42;                             // empilement léger à l'attente
            const showG    = _streamMode === 'ground' || _streamMode === 'both';
            const showS    = _streamMode === 'spacetime' || _streamMode === 'both';
            const showLine = _streamMode === 'both';

            // Passe 1 : positions de chaque bonhomme (+ phase). Chaque bonhomme est
            // affecté à une réalisation par suite bas-discrépance (répartition ≈
            // proportionnelle aux probabilités) → le paquet se scinde aux transferts.
            const data = [];
            for (let i = 0; i < streamFigures.length; i++) {
                const f = streamFigures[i];
                const u = (i * 0.6180339887498949) % 1;
                const real = i < nFig ? _streamReals.find(r => u < r.cum) : null;
                if (!real) { f.ground.visible = f.sky.visible = f.line.visible = false; continue; }
                const dur  = real.path.durationS;
                const tRel = ((tau + i * _streamSpacingS) % dur + dur) % dur;
                const tAbs = real.path.startS + tRel;
                const pos  = real.path.sampleAbs(tAbs);
                if (!pos) { f.ground.visible = f.sky.visible = f.line.visible = false; continue; }
                const base = geoPos(pos.lat, pos.lon);
                const skyY = (tAbs - _t0ForPassengers - currentSimTime) * TIME_SCALE + FEET_Y;
                data.push({ f, x: base.x, z: base.z, skyY, phase: pos.phase, tRel });
            }

            // Passe 2 : grappes d'ATTENTE (même arrêt) → rang d'empilement + halo.
            // Nb de bonhommes empilés ∝ durée d'attente (à espacement fixe) → la
            // hauteur de la colonne et l'intensité (log) du halo rendent l'attente.
            const clusters = new Map();
            for (const d of data) {
                if (d.phase !== 'wait') continue;
                const key = Math.round(d.x / 6) + ',' + Math.round(d.z / 6);
                if (!clusters.has(key)) clusters.set(key, []);
                clusters.get(key).push(d);
            }
            const rankOf = new Map();
            for (const items of clusters.values()) {
                items.sort((a, b) => a.tRel - b.tRel);
                items.forEach((d, k) => rankOf.set(d, k));
            }

            // Passe 3 : placer sol / espace-temps / ligne
            for (const d of data) {
                const k  = rankOf.get(d) ?? 0;
                const gY = FEET_Y + (d.phase === 'wait' ? k * STACK_STEP : 0);
                d.f.ground.visible = showG; if (showG) d.f.ground.position.set(d.x, gY, d.z);
                d.f.sky.visible    = showS; if (showS) d.f.sky.position.set(d.x, d.skyY, d.z);
                d.f.line.visible   = showLine;
                if (showLine) {
                    const p = d.f.line.geometry.attributes.position;
                    p.setXYZ(0, d.x, gY, d.z); p.setXYZ(1, d.x, d.skyY, d.z);
                    p.needsUpdate = true;
                }
            }

            // Passe 4 : halo par grappe d'attente (intensité logarithmique)
            ensureStreamGlows(clusters.size);
            let ci = 0;
            for (const items of clusters.values()) {
                const g = streamGlows[ci++]; const N = items.length; const inten = Math.log(N + 1);
                const d0 = items[0];
                const gy = showG ? FEET_Y : items.reduce((s, it) => s + it.skyY, 0) / N;
                g.visible = true;
                g.material.opacity = Math.min(0.85, 0.18 * inten);
                const sz = 130 + 90 * inten;
                g.scale.set(sz, sz, 1);
                g.position.set(d0.x, gy, d0.z);
            }
            for (; ci < streamGlows.length; ci++) streamGlows[ci].visible = false;
        } else {
            if (cohortGround) { cohortGround.visible = cohortSky.visible = cohortLines.visible = false; for (const g of cohortGlows) g.visible = false; }
            for (const f of streamFigures) { f.ground.visible = f.sky.visible = f.line.visible = false; }
            for (const g of streamGlows) g.visible = false;
        }

        // Animation des drapeaux — temps RÉEL (pas sim) pour vitesse indépendante du ×N
        const realTime = now / 1000;
        for (const { handle, urgencyFn } of animatedFlags) {
            handle.update(realTime, urgencyFn());
        }

        logEvent('tick', { simTime: currentSimTime, tGroupY: timeGroup.position.y, rafMs: Math.round(rafMs * 10) / 10 });

        controls.update();
        webglRenderer.render(scene, camera);
        labelRenderer.render(scene, camera);
    })();
}

export function getAzimuthalAngle() { return controls ? controls.getAzimuthalAngle() : 0; }

export function setVizMode(name) {
    activeVizMode?.dispose();
    activeVizMode = null;
    timedObjects.length = 0;
    if (!vizCtx) return;
    if (name === 'windows') activeVizMode = createWindowsMode(THREE, vizCtx);
    else if (name === 'fork')    activeVizMode = createForkMode(THREE, vizCtx);
    else if (name === 'walk')    activeVizMode = createWalkMode(THREE, { scene });
}

export function renderFrame(frame, routes) {
    pendingFrame = { frame, routes };
}

// Distance euclidienne (m) entre deux {lat,lon} — précise pour <10 km
function distM(ll1, ll2) {
    const dy = (ll2.lat - ll1.lat) * LAT_M;
    const dx = (ll2.lon - ll1.lon) * lonM;
    return Math.sqrt(dx * dx + dy * dy);
}

// Retourne true si le passager (sur L42) peut encore atteindre le circuit connecteur.
// Cas 1 : L42 livre le passager à l'arrêt de correspondance avant la fermeture de la fenêtre.
// Cas 2 (repli) : le passager peut marcher depuis sa position courante jusqu'à un arrêt
//   en aval du bus connecteur avant que celui-ci ne l'atteigne.
function isCircuitReachable(T, l42Traj, l42Shape, l42Route, connVeh, connRoute, tw) {
    // Arrêt de correspondance sur la route du connecteur
    const tStop = connRoute.stops.find(s => s.stop_id === tw.stop_id);
    if (!tStop) return true;

    // Cas 1 : L42 arrive à cet arrêt avant la fermeture de la fenêtre ?
    const l42Stop = l42Route?.stops.find(s => s.stop_id === tw.stop_id);
    if (l42Stop) {
        const tL42AtStop = estimateTimeAtProgress(l42Traj, l42Stop.progress_m);
        if (tL42AtStop !== null && tL42AtStop <= tw.t_close) return true;
    }

    // Cas 2 : marche à pied depuis la position actuelle de L42 vers un arrêt en aval
    const l42Cur = interpolate(l42Traj, T);
    if (!l42Cur) return false;
    const l42Ll = progressToLatLon(l42Cur.p50, l42Shape);
    if (!l42Ll) return false;

    const transferProgress = tStop.progress_m;
    const connCur = interpolate(connVeh.trajectory, T);
    const connProgress = connCur?.p50 ?? 0;
    for (const stop of connRoute.stops) {
        if (stop.progress_m <= Math.max(connProgress, transferProgress)) continue;
        const walkTime = distM(l42Ll, stop.position) / WALKING_SPEED_MPS;
        const busETA = estimateTimeAtProgress(connVeh.trajectory, stop.progress_m);
        if (busETA !== null && T + walkTime <= busETA) return true;
    }
    return false;
}

function drawFrame(frame, routes) {
    // currentSimTime n'est PAS touché ici — seul updateSimTime() y écrit,
    // ce qui empêche les sauts inverses causés par l'écrasement de la valeur lisse.
    const nowDraw = performance.now();
    const wallDelta = _prevDrawNow > 0 ? (nowDraw - _prevDrawNow) / 1000 : 0;
    _prevDrawNow = nowDraw;

    clearVehicles();

    const shapeByLine = Object.fromEntries(routes.map(r => [r.line_id, r.shape]));
    const probL33 = frame.transfers?.find(t => t.to_vehicle_id === 'L33-util')?.probability ?? 0;
    const suggestedConnector = probL33 >= SUGGEST_THRESHOLD ? 'L33-util' : 'L17-util';
    // Mode "récit" : scénarios jouet avec L42/L17/L33 identifiés.
    // Hors récit (ex. scenario STM réel), tous les véhicules reçoivent un style uniforme.
    const isStoryMode = frame.vehicles.some(v => v.vehicle_id === 'L42-util');

    // Mode "trajets" (Cas 6 et similaires) : frame.passengers liste les voyageurs.
    // Les trip_ids actifs (passager dedans) sont en pleine opacité ; les planifiés
    // (pas encore pris) à 60 % ; les autres à 25 %.
    const journeyPassengers = frame.passengers ?? [];
    const isJourneyMode = journeyPassengers.length > 0;
    const activeTripIds = isJourneyMode
        ? new Set(journeyPassengers.filter(p => p.phase === 'bus').map(p => p.trip_id).filter(Boolean))
        : null;
    const plannedTripIds = isJourneyMode
        ? new Set(journeyPassengers.flatMap(p => p.planned_trips ?? []))
        : null;

    function vehicleStyle(vid) {
        if (isJourneyMode) {
            const inHighlight = _highlightedJourneyTripIds === null || _highlightedJourneyTripIds.has(vid);
            // Choix surligné (Cas 7) : les autres bus s'effacent fortement pour
            // laisser le trajet du choix ressortir (« surtout réduire les autres »).
            if (!inHighlight) return { lineOp: 0.035, bandOp: 0.0, bold: false };
            if (activeTripIds.has(vid))  return { lineOp: 1.0,  bandOp: 0.35, bold: true };
            if (plannedTripIds.has(vid)) return { lineOp: 0.60, bandOp: 0.20, bold: false };
            return { lineOp: 0.25, bandOp: 0.08, bold: false };
        }
        if (!isStoryMode) return { lineOp: 0.85, bandOp: 0.20, bold: false };
        if (vid === 'L42-util')          return { lineOp: 1.0, bandOp: 0.35, bold: true };
        if (vid === suggestedConnector)   return { lineOp: 1.0, bandOp: 0.30, bold: true };
        if (vid === 'L33-util' || vid === 'L17-util') return { lineOp: 0.40, bandOp: 0.12, bold: false };
        return { lineOp: 0.40, bandOp: 0.10, bold: false };
    }

    // En mode COHORTE, on efface la flotte d'autobus (icônes au sol + cônes p50) :
    // elle est teintée par la même palette LINE_COLORS que l'essaim et le noierait.
    // On garde la carte et les tracés (persistants) pour le contexte géographique.
    if (!_cohortActive) for (const vehicle of frame.vehicles) {
        const shape = shapeByLine[vehicle.line_id];
        if (!shape) continue;
        const color = LINE_COLORS[vehicle.line_id] ?? 0x888888;
        const traj  = vehicle.trajectory;
        const style = vehicleStyle(vehicle.vehicle_id);

        // Densification : insère les sommets de shape entre chaque pas de 60 s pour que
        // les lignes 3D suivent les virages de la route. Inutile si rien n'est dessiné.
        const drawBand = showUncertainty && style.bandOp > 0.01;
        const dtraj = (showP50 || drawBand)
            ? densifyTrajFull(traj, shapeCumulativeDist(shape))
            : null;

        // Trajectoire p50 (dans timeGroup, Y absolu)
        if (showP50 && dtraj.length >= 2) {
            const p50pts = dtraj.map(pt => {
                const ll = progressToLatLon(pt.p50, shape);
                return worldPos(ll.lat, ll.lon, pt.t);
            });
            if (style.bold) {
                addBoldLine(p50pts, color, style.lineOp);
            } else {
                const geo = new THREE.BufferGeometry().setFromPoints(p50pts);
                const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, opacity: style.lineOp, transparent: true }));
                line.renderOrder = 1;
                timeGroup.add(line); vehicleObjects.push(line);
            }
        }

        // Bande d'incertitude p10–p50–p90 (3 colonnes : la ligne p50 est sur l'arête centrale)
        if (drawBand && dtraj.length >= 2) {
            const verts = [];
            for (const pt of dtraj) {
                const lo  = progressToLatLon(pt.p10, shape);
                const mid = progressToLatLon(pt.p50, shape);
                const hi  = progressToLatLon(pt.p90, shape);
                verts.push(worldPos(lo.lat, lo.lon, pt.t));
                verts.push(worldPos(mid.lat, mid.lon, pt.t));
                verts.push(worldPos(hi.lat, hi.lon, pt.t));
            }
            const positions = new Float32Array(verts.length * 3);
            verts.forEach((v, i) => { positions[i*3]=v.x; positions[i*3+1]=v.y; positions[i*3+2]=v.z; });
            const indices = [];
            for (let i = 0; i < dtraj.length - 1; i++) {
                const a=i*3, b=i*3+1, c=i*3+2, d=(i+1)*3, e=(i+1)*3+1, f=(i+1)*3+2;
                indices.push(a, b, d,  b, e, d);  // bande inférieure : p10 → p50
                indices.push(b, c, e,  c, f, e);  // bande supérieure : p50 → p90
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geo.setIndex(indices);
            geo.computeVertexNormals();
            const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
                color: style.bold ? 0xffffff : color,
                transparent: true, opacity: style.bandOp, side: THREE.DoubleSide, depthWrite: false,
            }));
            timeGroup.add(mesh); vehicleObjects.push(mesh);
        }

        // Icône d'autobus au niveau de la carte (scene, Y=0) — position actuelle interpolée.
        // On utilise currentSimTime (live, lissé) plutôt que frame.sim_time (discret) :
        // l'icône avance en continu même si le cône n'est rebâti que tous les frame_interval.
        const cur = interpolate(traj, Math.max(currentSimTime, frame.sim_time));
        if (cur) {
            const ll = progressToLatLon(cur.p50, shape);
            if (ll) {
                const icon = makeBusIcon(color);
                icon.position.copy(geoPos(ll.lat, ll.lon));

                // Cap : direction du tracé à la position courante, taux max 90°/s
                const targetHeading = progressToHeading(cur.p50, shape);
                const prevRot = busRotations.get(vehicle.vehicle_id) ?? targetHeading;
                let rotDiff = targetHeading - prevRot;
                while (rotDiff >  Math.PI) rotDiff -= 2 * Math.PI;
                while (rotDiff < -Math.PI) rotDiff += 2 * Math.PI;
                const maxDelta = MAX_ROT_PER_S * wallDelta;
                const newRot = prevRot + Math.max(-maxDelta, Math.min(maxDelta, rotDiff));
                busRotations.set(vehicle.vehicle_id, newRot);
                icon.rotation.y = newRot;

                scene.add(icon); groundObjects.push(icon);
            }
        }
    }

    // Sprite bonhomme (billboard) — position géographique au sol (Y=0, dans scene)
    const passenger = frame.passenger;
    if (passenger) {
        const lineId = passenger.vehicle_id.split('-')[0];
        const shape  = shapeByLine[lineId];
        if (shape) {
            const ll = progressToLatLon(passenger.progress_m, shape);
            if (ll) {
                const color  = LINE_COLORS[lineId] ?? 0x4488ff;
                const sprite = makePersonSprite(color);
                sprite.position.copy(geoPos(ll.lat, ll.lon));
                sprite.position.y += 250; // légèrement au-dessus du sol
                scene.add(sprite); groundObjects.push(sprite);
            }
        }
    }

    // Drapeaux d'arrivée à G4 — animés par le vent. Réservé au mode récit (L42/L17/L33).
    const l42Veh   = frame.vehicles.find(v => v.vehicle_id === 'L42-util');
    const l42Shape = shapeByLine['L42'];
    const twList   = vizCtx?.transferWindows ?? [];

    if (!isStoryMode) {
        activeVizMode?.update(frame);
        return;
    }

    for (const connId of ['L33-util', 'L17-util']) {
        const connVeh   = frame.vehicles.find(v => v.vehicle_id === connId);
        const connRoute = routes.find(r => r.line_id === connId.split('-')[0]);
        if (!connVeh || !connRoute) continue;

        // Couleur du drapeau : rouge si le circuit est hors d'atteinte
        const twConn = twList.find(w => w.connector_vehicle_id === connId);
        const l42Route = routes.find(r => r.line_id === 'L42');
        const reachable = (l42Veh && l42Shape && twConn)
            ? isCircuitReachable(frame.sim_time, l42Veh.trajectory, l42Shape, l42Route, connVeh, connRoute, twConn)
            : true;
        const flagColor = reachable ? null : 0xff2222;

        const destStop = connRoute.stops.at(-1);
        const gp = geoPos(destStop.position.lat, destStop.position.lon);
        const connIdx = connId === 'L33-util' ? 0 : 1;
        const tArrival = estimateArrival(connVeh.trajectory, connRoute.length_m);

        // Drapeau au sol (scene, Y=0 permanent)
        const fg = createAnimatedFlag(THREE, { phase: connIdx * 2.0, flagColor });
        fg.group.position.copy(gp);
        scene.add(fg.group); groundObjects.push(fg.group);
        if (tArrival != null) {
            animatedFlags.push({ handle: fg,
                urgencyFn: () => Math.max(0, 1 - (tArrival - currentSimTime) / 300) });
        }

        if (tArrival == null) continue;

        // Drapeau à l'heure d'arrivée (timeGroup, Y absolu = tArrival × TIME_SCALE)
        const fa = createAnimatedFlag(THREE, { phase: connIdx * 2.0 + 1.2, flagColor });
        fa.group.position.set(gp.x, tArrival * TIME_SCALE, gp.z);
        timeGroup.add(fa.group); vehicleObjects.push(fa.group);
        animatedFlags.push({ handle: fa,
            urgencyFn: () => Math.max(0, 1 - (tArrival - currentSimTime) / 300) });

        // Ligne verticale entre les deux drapeaux (dans timeGroup)
        // Sommet bas : Y = currentSimTime × TIME_SCALE (ancré à Y=0 monde, mis à jour chaque tick)
        // Sommet haut : Y = tArrival × TIME_SCALE (fixe)
        const linePts = [
            new THREE.Vector3(gp.x, currentSimTime * TIME_SCALE, gp.z),
            new THREE.Vector3(gp.x, tArrival * TIME_SCALE, gp.z),
        ];
        const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
        const connLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({
            color: 0xffffff, opacity: 0.35, transparent: true,
        }));
        timeGroup.add(connLine); vehicleObjects.push(connLine);
        timedObjects.push({ obj: connLine, _isLine: true });
    }

    // Étiquettes de départ — une par fenêtre de correspondance (dans timeGroup)
    for (const tw of twList) {
        const connLine = tw.connector_vehicle_id.split('-')[0];
        const color = LINE_COLORS[connLine] ?? 0xffffff;
        let stopPos = null;
        for (const route of routes) {
            const s = route.stops.find(s => s.stop_id === tw.stop_id);
            if (s) { stopPos = s.position; break; }
        }
        if (!stopPos) continue;
        const gp = geoPos(stopPos.lat, stopPos.lon);
        const label = makeDepartureLabel(THREE, tw.t_close, color);
        label.position.set(gp.x, tw.t_close * TIME_SCALE, gp.z);
        timeGroup.add(label); vehicleObjects.push(label);
    }

    activeVizMode?.update(frame);
}

export function dispose() {
    clearVehicles();
    activeVizMode?.dispose();
    controls?.dispose();
    webglRenderer?.dispose();
}

// Seul fichier qui importe Three.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { progressToLatLon, estimateArrival, estimateTimeAtProgress, interpolate, progressToHeading } from './interpolation.js';
import { create as createWindowsMode } from './viz-mode-windows.js';
import { create as createForkMode }   from './viz-mode-fork.js';
import { create as createWalkMode }   from './viz-mode-walk.js';
import { createAnimatedFlag } from './flag-animation.js';
import { logEvent } from './diagnostics.js';

const LINE_COLORS = {
    L42: 0x4488ff, L17: 0xff8844, L33: 0x44cc44,
    // Lignes STM réelles
    "51": 0x4488ff, "165": 0xff8844, "11":  0x44cc44,
    "711": 0xdd44dd, "129": 0xffcc00, "155": 0x44ccdd,
};
const SUGGEST_THRESHOLD = 0.50;
const TIME_SCALE = 5.0;
const LAT_M = 111_000;
const WALKING_SPEED_MPS = 1.4;   // vitesse de marche typique
const MAX_ROT_PER_S = Math.PI / 2; // 90°/s — limite de rotation des icônes d'autobus

let scene, camera, webglRenderer, controls;
// timeGroup : groupe décalé en Y = −currentSimTime × TIME_SCALE à 60 fps.
// Tous les objets espace-temps (trajectoires, drapeaux d'arrivée, viz modes, bonhomme)
// y sont ajoutés avec une position Y absolue (t × TIME_SCALE).
// Le décalage continu élimine les sauts discrets sans rebuilder les géométries.
let timeGroup;
let latCenter, lonCenter, lonM;
let vehicleObjects = []; // dans timeGroup — vidés/reconstruits à chaque frame
let groundObjects  = []; // dans scene (Y = 0) — icônes d'autobus + drapeaux au sol
let nowPlane;
let pendingFrame = null;
export let lastDrawMs = 0;

const animatedFlags = []; // { handle, urgencyFn } — animés à 60 fps en temps réel

// Rotation actuelle par véhicule — persistante entre frames pour le rate-limiting
const busRotations = new Map();
let _prevDrawNow = 0;

let currentSimTime = 0;
export function updateSimTime(t) { currentSimTime = t; }

// timedObjects : uniquement les lignes de connexion dont le sommet inférieur
// doit rester ancré à Y = 0 monde (bottom = currentSimTime × TIME_SCALE dans timeGroup)
const timedObjects = [];

let activeVizMode = null;
let vizCtx = null;

function geoPos(lat, lon) {
    return new THREE.Vector3(
        (lon - lonCenter) * lonM, 0, (lat - latCenter) * LAT_M,
    );
}

// Y absolu dans timeGroup — le décalage timeGroup.position.y ramène à l'espace relatif
function worldPos(lat, lon, t) {
    return new THREE.Vector3(
        (lon - lonCenter) * lonM,
        t * TIME_SCALE,
        (lat - latCenter) * LAT_M,
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
    timeGroup.add(l1); vehicleObjects.push(l1);
    const g2 = new THREE.BufferGeometry().setFromPoints(pts);
    const l2 = new THREE.Line(g2, new THREE.LineBasicMaterial({ color: 0xffffff, opacity: opacity * 0.40, transparent: true }));
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

export function init(canvas, config) {
    const { routes, transferWindows: tw = [], mapBackground = null } = config;

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

    controls = new OrbitControls(camera, webglRenderer.domElement);
    controls.target.set(-400, 3000, -1100);
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
        tex.flipY = false; // sans flipY=false, le nord de l'image apparaît au sud en vue de dessus
        const plane = new THREE.Mesh(
            new THREE.PlaneGeometry(w_m, h_m),
            new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.65 }),
        );
        plane.rotation.x = -Math.PI / 2;
        plane.position.set(
            (bounds.lon_center - lonCenter) * lonM, -1,
            (bounds.lat_center - latCenter) * LAT_M,
        );
        scene.add(plane);
    } else {
        scene.add(new THREE.GridHelper(10000, 20, 0x223344, 0x1a2a36));
    }

    // Tracés géographiques au sol (scene, Y=0 permanent)
    for (const route of routes) {
        const pts = route.shape.map(p => geoPos(p.lat, p.lon));
        scene.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(pts),
            new THREE.LineBasicMaterial({ color: LINE_COLORS[route.line_id] ?? 0x555555, opacity: 0.65, transparent: true }),
        ));
        for (const stop of route.stops) {
            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(45, 8, 8),
                new THREE.MeshBasicMaterial({ color: LINE_COLORS[route.line_id] ?? 0x555555 }),
            );
            mesh.position.copy(geoPos(stop.position.lat, stop.position.lon));
            scene.add(mesh);
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

    window.addEventListener('resize', () => {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        camera.aspect = w / h; camera.updateProjectionMatrix();
        webglRenderer.setSize(w, h, false);
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

        // Animation des drapeaux — temps RÉEL (pas sim) pour vitesse indépendante du ×N
        const realTime = now / 1000;
        for (const { handle, urgencyFn } of animatedFlags) {
            handle.update(realTime, urgencyFn());
        }

        logEvent('tick', { simTime: currentSimTime, tGroupY: timeGroup.position.y, rafMs: Math.round(rafMs * 10) / 10 });

        controls.update();
        webglRenderer.render(scene, camera);
    })();
}

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

    function vehicleStyle(vid) {
        if (vid === 'L42-util')          return { lineOp: 1.0, bandOp: 0.35, bold: true };
        if (vid === suggestedConnector)   return { lineOp: 1.0, bandOp: 0.30, bold: true };
        if (vid === 'L33-util' || vid === 'L17-util') return { lineOp: 0.40, bandOp: 0.12, bold: false };
        return { lineOp: 0.40, bandOp: 0.10, bold: false };
    }

    for (const vehicle of frame.vehicles) {
        const shape = shapeByLine[vehicle.line_id];
        if (!shape) continue;
        const color = LINE_COLORS[vehicle.line_id] ?? 0x888888;
        const traj  = vehicle.trajectory;
        const style = vehicleStyle(vehicle.vehicle_id);

        // Trajectoire p50 (dans timeGroup, Y absolu)
        const p50pts = traj.map(pt => {
            const ll = progressToLatLon(pt.p50, shape);
            return worldPos(ll.lat, ll.lon, pt.t);
        });
        if (p50pts.length >= 2) {
            if (style.bold) {
                addBoldLine(p50pts, color, style.lineOp);
            } else {
                const geo = new THREE.BufferGeometry().setFromPoints(p50pts);
                const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, opacity: style.lineOp, transparent: true }));
                timeGroup.add(line); vehicleObjects.push(line);
            }
        }

        // Bande d'incertitude p10–p90
        if (traj.length >= 2 && style.bandOp > 0.01) {
            const verts = [];
            for (const pt of traj) {
                const lo = progressToLatLon(pt.p10, shape);
                const hi = progressToLatLon(pt.p90, shape);
                verts.push(worldPos(lo.lat, lo.lon, pt.t));
                verts.push(worldPos(hi.lat, hi.lon, pt.t));
            }
            const positions = new Float32Array(verts.length * 3);
            verts.forEach((v, i) => { positions[i*3]=v.x; positions[i*3+1]=v.y; positions[i*3+2]=v.z; });
            const indices = [];
            for (let i = 0; i < traj.length - 1; i++) {
                const a=i*2, b=i*2+1, c=i*2+2, d=i*2+3;
                indices.push(a,b,c, b,d,c);
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geo.setIndex(indices);
            geo.computeVertexNormals();
            const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
                color: style.bold ? 0xffffff : color,
                transparent: true, opacity: style.bandOp, side: THREE.DoubleSide,
            }));
            timeGroup.add(mesh); vehicleObjects.push(mesh);
        }

        // Icône d'autobus au niveau de la carte (scene, Y=0) — position actuelle interpolée
        const cur = interpolate(traj, frame.sim_time);
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

    // Drapeaux d'arrivée à G4 — animés par le vent
    const l42Veh   = frame.vehicles.find(v => v.vehicle_id === 'L42-util');
    const l42Shape = shapeByLine['L42'];
    const twList   = vizCtx?.transferWindows ?? [];

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

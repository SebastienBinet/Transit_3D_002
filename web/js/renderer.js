// Seul fichier qui importe Three.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { progressToLatLon } from './interpolation.js';

const LINE_COLORS = {
    L42: 0x4488ff,
    L17: 0xff8844,
    L33: 0x44cc44,
};

// Seuil en-dessous duquel on recommande L17 plutôt que L33
const SUGGEST_THRESHOLD = 0.50;

const TIME_SCALE = 5.0;
const LAT_M = 111_000;

let scene, camera, webglRenderer, controls;
let latCenter, lonCenter, lonM;
let vehicleObjects = [];
let busMarker = null;
let nowPlane;
let checkerTexture = null;

function worldPos(lat, lon, simTime) {
    return new THREE.Vector3(
        (lon - lonCenter) * lonM,
        simTime * TIME_SCALE,
        (lat - latCenter) * LAT_M,
    );
}

function clearVehicles() {
    for (const obj of vehicleObjects) {
        scene.remove(obj);
        obj.traverse(child => {
            child.geometry?.dispose();
            // Ne pas disposer la texture damier partagée
            if (child.material) {
                if (child.material.map && child.material.map !== checkerTexture)
                    child.material.map.dispose();
                child.material.dispose();
            }
        });
    }
    vehicleObjects = [];
    if (busMarker) {
        scene.remove(busMarker);
        busMarker.traverse(c => { c.geometry?.dispose(); c.material?.dispose(); });
        busMarker = null;
    }
}

// Forme de bus stylisée (carrosserie + toit)
function makeBusMarker() {
    const group = new THREE.Group();
    const bodyGeo = new THREE.BoxGeometry(280, 90, 130);
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0xffee44, emissive: 0x997700 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    group.add(body);
    const roofGeo = new THREE.BoxGeometry(220, 45, 110);
    const roofMat = new THREE.MeshLambertMaterial({ color: 0xffee44, emissive: 0x997700 });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.y = 67;
    group.add(roof);
    // Halo de sélection
    const haloGeo = new THREE.SphereGeometry(180, 16, 16);
    const haloMat = new THREE.MeshBasicMaterial({ color: 0xffff88, transparent: true, opacity: 0.08 });
    group.add(new THREE.Mesh(haloGeo, haloMat));
    return group;
}

// Texture damier (créée une seule fois)
function getCheckerTexture() {
    if (checkerTexture) return checkerTexture;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
            ctx.fillStyle = (x + y) % 2 === 0 ? '#111' : '#fff';
            ctx.fillRect(x * 16, y * 16, 16, 16);
        }
    }
    checkerTexture = new THREE.CanvasTexture(canvas);
    return checkerTexture;
}

// Drapeau damier de course (pôle + tissu) ancré à la position donnée
function makeFinishFlag(position) {
    const group = new THREE.Group();
    // Pôle
    const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(10, 10, 450, 6),
        new THREE.MeshLambertMaterial({ color: 0xdddddd }),
    );
    pole.position.y = 225;
    group.add(pole);
    // Tissu damier
    const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(220, 140),
        new THREE.MeshBasicMaterial({ map: getCheckerTexture(), side: THREE.DoubleSide }),
    );
    flag.position.set(110, 450, 0);   // accroché au sommet du pôle, s'étend à droite
    flag.rotation.y = Math.PI / 6;    // léger angle pour la visibilité
    group.add(flag);
    group.position.copy(position);
    return group;
}

// Longueur totale d'un tracé polylinéaire (en mètres)
function shapeLen(shape) {
    const lm = LAT_M * Math.cos(shape[0].lat * Math.PI / 180);
    let len = 0;
    for (let i = 1; i < shape.length; i++) {
        const dy = (shape[i].lat - shape[i - 1].lat) * LAT_M;
        const dx = (shape[i].lon - shape[i - 1].lon) * lm;
        len += Math.sqrt(dy * dy + dx * dx);
    }
    return len;
}

// Heure d'arrivée estimée (p50) à la fin du tracé d'un véhicule
function estimateArrival(vehicle, routeLen) {
    const nearEnd = routeLen * 0.97;
    for (const pt of vehicle.trajectory) {
        if (pt.p50 >= nearEnd) return pt.t;
    }
    return vehicle.trajectory.at(-1)?.t ?? null;
}

// Marqueur d'arrêt-clé (transfert / destination)
function makeStopMarker(pos, color, label) {
    const group = new THREE.Group();
    // Pilier vertical depuis Y=0 jusqu'à la position
    const pillarPts = [new THREE.Vector3(0, -pos.y, 0), new THREE.Vector3(0, 0, 0)];
    const pillarGeo = new THREE.BufferGeometry().setFromPoints(pillarPts);
    const pillarMat = new THREE.LineBasicMaterial({ color, opacity: 0.4, transparent: true });
    group.add(new THREE.Line(pillarGeo, pillarMat));
    // Sphère à Y=0 (sol géographique)
    const sGeo = new THREE.SphereGeometry(80, 16, 16);
    const sMat = new THREE.MeshLambertMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(0.4) });
    const sphere = new THREE.Mesh(sGeo, sMat);
    sphere.position.y = -pos.y;
    group.add(sphere);
    group.position.copy(pos);
    return group;
}

export function init(canvas, config) {
    const { routes } = config;

    const allLats = routes.flatMap(r => r.shape.map(p => p.lat));
    const allLons = routes.flatMap(r => r.shape.map(p => p.lon));
    latCenter = (Math.min(...allLats) + Math.max(...allLats)) / 2;
    lonCenter = (Math.min(...allLons) + Math.max(...allLons)) / 2;
    lonM = LAT_M * Math.cos(latCenter * Math.PI / 180);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a12);
    scene.fog = new THREE.Fog(0x0a0a12, 14000, 32000);

    const w = canvas.clientWidth || canvas.width || 800;
    const h = canvas.clientHeight || canvas.height || 600;
    camera = new THREE.PerspectiveCamera(55, w / h, 10, 50000);
    camera.position.set(1500, 5000, 9000);

    webglRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    webglRenderer.setSize(w, h, false);
    webglRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    controls = new OrbitControls(camera, webglRenderer.domElement);
    controls.target.set(0, 4500, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.update();

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const sun = new THREE.DirectionalLight(0xffffff, 0.7);
    sun.position.set(3000, 8000, 5000);
    scene.add(sun);

    const grid = new THREE.GridHelper(10000, 20, 0x223344, 0x1a2a36);
    scene.add(grid);

    // Tracés géographiques au sol (Y=0)
    for (const route of routes) {
        const pts = route.shape.map(p => worldPos(p.lat, p.lon, 0));
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({
            color: LINE_COLORS[route.line_id] ?? 0x555555,
            opacity: 0.35, transparent: true,
        });
        scene.add(new THREE.Line(geo, mat));

        for (const stop of route.stops) {
            const pos = worldPos(stop.position.lat, stop.position.lon, 0);
            const geo = new THREE.SphereGeometry(35, 8, 8);
            const mat = new THREE.MeshBasicMaterial({ color: LINE_COLORS[route.line_id] ?? 0x555555 });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.copy(pos);
            scene.add(mesh);
        }
    }

    // Marqueurs des arrêts de transfert (P1 et P3) plus visibles
    const shapeByLine = Object.fromEntries(routes.map(r => [r.line_id, r.shape]));
    const L42shape = shapeByLine['L42'];
    if (L42shape) {
        // P1 = 1er arrêt de L42 (index 1)
        const p1Stop = routes.find(r => r.line_id === 'L42')?.stops[1];
        if (p1Stop) {
            const pos = worldPos(p1Stop.position.lat, p1Stop.position.lon, 0);
            const geo = new THREE.CylinderGeometry(0, 60, 180, 6);
            const mat = new THREE.MeshLambertMaterial({ color: 0xff8844, emissive: 0x662200 });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.copy(pos);
            mesh.position.y = 90;
            scene.add(mesh);
        }
        // P3 = 3e arrêt de L42 (index 3)
        const p3Stop = routes.find(r => r.line_id === 'L42')?.stops[3];
        if (p3Stop) {
            const pos = worldPos(p3Stop.position.lat, p3Stop.position.lon, 0);
            const geo = new THREE.CylinderGeometry(0, 60, 180, 6);
            const mat = new THREE.MeshLambertMaterial({ color: 0x44cc44, emissive: 0x115511 });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.copy(pos);
            mesh.position.y = 90;
            scene.add(mesh);
        }
    }

    const planeGeo = new THREE.PlaneGeometry(12000, 12000);
    const planeMat = new THREE.MeshBasicMaterial({
        color: 0x88aaff, transparent: true, opacity: 0.04, side: THREE.DoubleSide,
    });
    nowPlane = new THREE.Mesh(planeGeo, planeMat);
    nowPlane.rotation.x = Math.PI / 2;
    scene.add(nowPlane);

    const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-6000, 0, 0), new THREE.Vector3(6000, 0, 0),
    ]);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x88aaff, opacity: 0.3, transparent: true });
    nowPlane.add(new THREE.Line(lineGeo, lineMat));

    window.addEventListener('resize', () => {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        webglRenderer.setSize(w, h, false);
    });

    (function loop() {
        requestAnimationFrame(loop);
        controls.update();
        webglRenderer.render(scene, camera);
    })();
}

export function renderFrame(frame, routes) {
    clearVehicles();

    if (nowPlane) nowPlane.position.y = frame.sim_time * TIME_SCALE;

    const shapeByLine = Object.fromEntries(routes.map(r => [r.line_id, r.shape]));

    // Décision de trajet suggéré
    const probL33 = frame.transfers?.find(t => t.to_vehicle_id === 'L33-util')?.probability ?? 0;
    const suggestedConnector = probL33 >= SUGGEST_THRESHOLD ? 'L33-util' : 'L17-util';

    // Opacité et apparence selon le rôle du véhicule
    function vehicleStyle(vid) {
        if (vid === 'L42-util') return { lineOp: 1.0, bandOp: 0.20, bold: true };
        if (vid === suggestedConnector) return { lineOp: 0.95, bandOp: 0.18, bold: true };
        // Autre connecteur (non suggéré) : très atténué
        if (vid === 'L33-util' || vid === 'L17-util') return { lineOp: 0.18, bandOp: 0.04, bold: false };
        // Bus précédents / suivants
        return { lineOp: 0.25, bandOp: 0.05, bold: false };
    }

    for (const vehicle of frame.vehicles) {
        const shape = shapeByLine[vehicle.line_id];
        if (!shape) continue;
        const color = LINE_COLORS[vehicle.line_id] ?? 0x888888;
        const traj = vehicle.trajectory;
        const style = vehicleStyle(vehicle.vehicle_id);

        // Ligne p50
        const p50pts = traj.map(pt => {
            const ll = progressToLatLon(pt.p50, shape);
            return worldPos(ll.lat, ll.lon, pt.t);
        });
        if (p50pts.length >= 2) {
            const lineColor = style.bold ? 0xffffff : color;
            const geo = new THREE.BufferGeometry().setFromPoints(p50pts);
            const mat = new THREE.LineBasicMaterial({ color: lineColor, opacity: style.lineOp, transparent: true });
            const line = new THREE.Line(geo, mat);
            scene.add(line);
            vehicleObjects.push(line);

            // Double trait pour les trajets suggérés (effet "gras")
            if (style.bold) {
                const geo2 = new THREE.BufferGeometry().setFromPoints(p50pts);
                const mat2 = new THREE.LineBasicMaterial({ color, opacity: 0.6, transparent: true });
                const line2 = new THREE.Line(geo2, mat2);
                scene.add(line2);
                vehicleObjects.push(line2);
            }
        }

        // Ruban d'incertitude p10–p90
        if (traj.length >= 2 && style.bandOp > 0.01) {
            const verts = [];
            for (const pt of traj) {
                const lo = progressToLatLon(pt.p10, shape);
                const hi = progressToLatLon(pt.p90, shape);
                verts.push(worldPos(lo.lat, lo.lon, pt.t));
                verts.push(worldPos(hi.lat, hi.lon, pt.t));
            }
            const positions = new Float32Array(verts.length * 3);
            verts.forEach((v, i) => {
                positions[i * 3]     = v.x;
                positions[i * 3 + 1] = v.y;
                positions[i * 3 + 2] = v.z;
            });
            const indices = [];
            for (let i = 0; i < traj.length - 1; i++) {
                const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
                indices.push(a, b, c,  b, d, c);
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geo.setIndex(indices);
            geo.computeVertexNormals();
            const mat = new THREE.MeshBasicMaterial({
                color: style.bold ? 0xffffff : color,
                transparent: true,
                opacity: style.bandOp,
                side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(geo, mat);
            scene.add(mesh);
            vehicleObjects.push(mesh);
        }
    }

    // Marqueur de position du passager (sur L42-util)
    const L42util = frame.vehicles.find(v => v.vehicle_id === 'L42-util');
    if (L42util?.trajectory.length) {
        const pt0 = L42util.trajectory[0];  // position actuelle (p10=p50=p90)
        const ll = progressToLatLon(pt0.p50, shapeByLine['L42']);
        if (ll) {
            busMarker = makeBusMarker();
            busMarker.position.copy(worldPos(ll.lat, ll.lon, frame.sim_time));
            busMarker.rotation.y = Math.PI / 2;
            scene.add(busMarker);
        }
    }

    // Drapeaux d'arrivée : un au sol (géographie), un à l'heure estimée d'arrivée
    const connectorLineId = suggestedConnector.startsWith('L33') ? 'L33' : 'L17';
    const connectorRoute = routes.find(r => r.line_id === connectorLineId);
    const connectorVehicle = frame.vehicles.find(v => v.vehicle_id === suggestedConnector);

    if (connectorRoute && connectorVehicle) {
        const destStop = connectorRoute.stops.at(-1);
        const destLat = destStop.position.lat;
        const destLon = destStop.position.lon;
        const groundPos = worldPos(destLat, destLon, 0);

        // Drapeau au sol
        const flagGround = makeFinishFlag(groundPos);
        scene.add(flagGround);
        vehicleObjects.push(flagGround);

        // Heure d'arrivée estimée → drapeau dans la dimension temps
        const routeLength = shapeLen(connectorRoute.shape);
        const tArrival = estimateArrival(connectorVehicle, routeLength);
        if (tArrival != null) {
            const arrivalPos = worldPos(destLat, destLon, tArrival);
            const flagArrival = makeFinishFlag(arrivalPos);
            scene.add(flagArrival);
            vehicleObjects.push(flagArrival);

            // Ligne verticale reliant les deux drapeaux
            const connGeo = new THREE.BufferGeometry().setFromPoints([
                groundPos.clone(), arrivalPos.clone(),
            ]);
            const connMat = new THREE.LineBasicMaterial({
                color: 0xffffff, opacity: 0.25, transparent: true,
            });
            const connLine = new THREE.Line(connGeo, connMat);
            scene.add(connLine);
            vehicleObjects.push(connLine);
        }
    }
}

export function dispose() {
    clearVehicles();
    controls?.dispose();
    webglRenderer?.dispose();
}

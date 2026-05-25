// Seul fichier qui importe Three.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { progressToLatLon, estimateArrival } from './interpolation.js';
import { create as createWindowsMode } from './viz-mode-windows.js';
import { create as createForkMode }   from './viz-mode-fork.js';

const LINE_COLORS = {
    L42: 0x4488ff,
    L17: 0xff8844,
    L33: 0x44cc44,
};

const SUGGEST_THRESHOLD = 0.50;
const TIME_SCALE = 5.0;
const LAT_M = 111_000;

let scene, camera, webglRenderer, controls;
let latCenter, lonCenter, lonM;
let vehicleObjects = [];
let nowPlane;
let checkerTexture = null;
let pendingFrame = null;
export let lastDrawMs = 0;

// Gestion du mode de visualisation
let activeVizMode = null;
let vizCtx = null;

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
            if (child.material) {
                if (child.material.map && child.material.map !== checkerTexture)
                    child.material.map.dispose();
                child.material.dispose();
            }
        });
    }
    vehicleObjects = [];
}

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

function makeFinishFlag(position) {
    const group = new THREE.Group();
    const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(10, 10, 450, 6),
        new THREE.MeshLambertMaterial({ color: 0xdddddd }),
    );
    pole.position.y = 225;
    group.add(pole);
    const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(220, 140),
        new THREE.MeshBasicMaterial({ map: getCheckerTexture(), side: THREE.DoubleSide }),
    );
    flag.position.set(110, 450, 0);
    flag.rotation.y = Math.PI / 6;
    group.add(flag);
    group.position.copy(position);
    return group;
}

function makeStopMarker(pos, color) {
    const group = new THREE.Group();
    const pillarPts = [new THREE.Vector3(0, -pos.y, 0), new THREE.Vector3(0, 0, 0)];
    group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pillarPts),
        new THREE.LineBasicMaterial({ color, opacity: 0.4, transparent: true }),
    ));
    const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(80, 16, 16),
        new THREE.MeshLambertMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(0.4) }),
    );
    sphere.position.y = -pos.y;
    group.add(sphere);
    group.position.copy(pos);
    return group;
}

export function init(canvas, config) {
    const { routes, transferWindows: tw = [] } = config;

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

    scene.add(new THREE.GridHelper(10000, 20, 0x223344, 0x1a2a36));

    // Tracés géographiques au sol
    for (const route of routes) {
        const pts = route.shape.map(p => worldPos(p.lat, p.lon, 0));
        scene.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(pts),
            new THREE.LineBasicMaterial({
                color: LINE_COLORS[route.line_id] ?? 0x555555,
                opacity: 0.60, transparent: true,
            }),
        ));
        for (const stop of route.stops) {
            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(35, 8, 8),
                new THREE.MeshBasicMaterial({ color: LINE_COLORS[route.line_id] ?? 0x555555 }),
            );
            mesh.position.copy(worldPos(stop.position.lat, stop.position.lon, 0));
            scene.add(mesh);
        }
    }

    // Cônes des arrêts de transfert (P1 et P3)
    for (const win of tw) {
        const connLine = win.connector_vehicle_id.split('-')[0];
        const color = LINE_COLORS[connLine] ?? 0xffffff;
        const l42Route = routes.find(r => r.line_id === 'L42');
        const stop = l42Route?.stops.find(s => s.stop_id === win.stop_id);
        if (!stop) continue;
        const cone = new THREE.Mesh(
            new THREE.CylinderGeometry(0, 60, 180, 6),
            new THREE.MeshLambertMaterial({ color, emissive: new THREE.Color(color).multiplyScalar(0.3) }),
        );
        cone.position.copy(worldPos(stop.position.lat, stop.position.lon, 0));
        cone.position.y = 90;
        scene.add(cone);
    }

    // Plan "maintenant"
    const planeGeo = new THREE.PlaneGeometry(12000, 12000);
    const planeMat = new THREE.MeshBasicMaterial({
        color: 0x88aaff, transparent: true, opacity: 0.04, side: THREE.DoubleSide,
    });
    nowPlane = new THREE.Mesh(planeGeo, planeMat);
    nowPlane.rotation.x = Math.PI / 2;
    scene.add(nowPlane);
    nowPlane.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-6000, 0, 0), new THREE.Vector3(6000, 0, 0),
        ]),
        new THREE.LineBasicMaterial({ color: 0x88aaff, opacity: 0.3, transparent: true }),
    ));

    window.addEventListener('resize', () => {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        webglRenderer.setSize(w, h, false);
    });

    // Prépare le contexte partagé avec les modes de visualisation
    vizCtx = { scene, routes, transferWindows: tw, worldPos, progressToLatLon, estimateArrival };

    (function loop() {
        requestAnimationFrame(loop);
        if (pendingFrame) {
            const t0 = performance.now();
            drawFrame(pendingFrame.frame, pendingFrame.routes);
            pendingFrame = null;
            lastDrawMs = performance.now() - t0;
        }
        controls.update();
        webglRenderer.render(scene, camera);
    })();
}

// Change le mode de visualisation actif. Peut être appelé après init().
export function setVizMode(name) {
    activeVizMode?.dispose();
    activeVizMode = null;
    if (!vizCtx) return;
    if (name === 'windows') activeVizMode = createWindowsMode(THREE, vizCtx);
    else if (name === 'fork')    activeVizMode = createForkMode(THREE, vizCtx);
}

export function renderFrame(frame, routes) {
    pendingFrame = { frame, routes };
}

function drawFrame(frame, routes) {
    clearVehicles();

    if (nowPlane) nowPlane.position.y = frame.sim_time * TIME_SCALE;

    const shapeByLine = Object.fromEntries(routes.map(r => [r.line_id, r.shape]));

    const probL33 = frame.transfers?.find(t => t.to_vehicle_id === 'L33-util')?.probability ?? 0;
    const suggestedConnector = probL33 >= SUGGEST_THRESHOLD ? 'L33-util' : 'L17-util';

    function vehicleStyle(vid) {
        if (vid === 'L42-util') return { lineOp: 1.0, bandOp: 0.32, bold: true };
        if (vid === suggestedConnector) return { lineOp: 1.0, bandOp: 0.28, bold: true };
        if (vid === 'L33-util' || vid === 'L17-util') return { lineOp: 0.35, bandOp: 0.10, bold: false };
        return { lineOp: 0.38, bandOp: 0.09, bold: false };
    }

    for (const vehicle of frame.vehicles) {
        const shape = shapeByLine[vehicle.line_id];
        if (!shape) continue;
        const color = LINE_COLORS[vehicle.line_id] ?? 0x888888;
        const traj = vehicle.trajectory;
        const style = vehicleStyle(vehicle.vehicle_id);

        const p50pts = traj.map(pt => {
            const ll = progressToLatLon(pt.p50, shape);
            return worldPos(ll.lat, ll.lon, pt.t);
        });
        if (p50pts.length >= 2) {
            const geo = new THREE.BufferGeometry().setFromPoints(p50pts);
            const mat = new THREE.LineBasicMaterial({
                color: style.bold ? 0xffffff : color,
                opacity: style.lineOp, transparent: true,
            });
            const line = new THREE.Line(geo, mat);
            scene.add(line);
            vehicleObjects.push(line);

            if (style.bold) {
                const geo2 = new THREE.BufferGeometry().setFromPoints(p50pts);
                const mat2 = new THREE.LineBasicMaterial({ color, opacity: 0.85, transparent: true });
                const line2 = new THREE.Line(geo2, mat2);
                scene.add(line2);
                vehicleObjects.push(line2);
            }
        }

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
                const a = i*2, b = i*2+1, c = i*2+2, d = i*2+3;
                indices.push(a, b, c,  b, d, c);
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geo.setIndex(indices);
            geo.computeVertexNormals();
            const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
                color: style.bold ? 0xffffff : color,
                transparent: true, opacity: style.bandOp, side: THREE.DoubleSide,
            }));
            scene.add(mesh);
            vehicleObjects.push(mesh);
        }
    }

    // Drapeaux à la destination (G4) pour les deux connecteurs
    for (const connId of ['L33-util', 'L17-util']) {
        const connVeh = frame.vehicles.find(v => v.vehicle_id === connId);
        const connRoute = routes.find(r => r.line_id === connId.split('-')[0]);
        if (!connVeh || !connRoute) continue;

        const destStop = connRoute.stops.at(-1);
        const groundPos = worldPos(destStop.position.lat, destStop.position.lon, 0);
        const flagGround = makeFinishFlag(groundPos);
        scene.add(flagGround);
        vehicleObjects.push(flagGround);

        const tArrival = estimateArrival(connVeh.trajectory, connRoute.length_m);
        if (tArrival != null) {
            const arrivalPos = worldPos(destStop.position.lat, destStop.position.lon, tArrival);
            const flagArrival = makeFinishFlag(arrivalPos);
            scene.add(flagArrival);
            vehicleObjects.push(flagArrival);

            const connGeo = new THREE.BufferGeometry().setFromPoints([groundPos.clone(), arrivalPos.clone()]);
            const connLine = new THREE.Line(connGeo, new THREE.LineBasicMaterial({
                color: 0xffffff, opacity: 0.45, transparent: true,
            }));
            scene.add(connLine);
            vehicleObjects.push(connLine);
        }
    }

    // Délègue au mode de visualisation actif
    activeVizMode?.update(frame);
}

export function dispose() {
    clearVehicles();
    activeVizMode?.dispose();
    controls?.dispose();
    webglRenderer?.dispose();
}

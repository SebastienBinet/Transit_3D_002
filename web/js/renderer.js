// Seul fichier qui importe Three.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { progressToLatLon } from './interpolation.js';

const LINE_COLORS = {
    L42: 0x4488ff,
    L17: 0xff8844,
    L33: 0x44cc44,
};
const TIME_SCALE = 5.0;   // mètres par seconde de sim-time
const LAT_M = 111_000;

let scene, camera, webglRenderer, controls;
let latCenter, lonCenter, lonM;
let vehicleObjects = [];
let nowPlane;

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
        obj.geometry?.dispose();
        obj.material?.dispose();
    }
    vehicleObjects = [];
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
    scene.fog = new THREE.Fog(0x0a0a12, 12000, 30000);

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

    // Grille de fond (plan temporel t=0)
    const grid = new THREE.GridHelper(10000, 20, 0x223344, 0x1a2a36);
    scene.add(grid);

    // Tracés géographiques (lignes au sol, Y=0)
    for (const route of routes) {
        const pts = route.shape.map(p => worldPos(p.lat, p.lon, 0));
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({
            color: LINE_COLORS[route.line_id] ?? 0x555555,
            opacity: 0.4,
            transparent: true,
        });
        scene.add(new THREE.Line(geo, mat));

        // Points d'arrêt
        for (const stop of route.stops) {
            const pos = worldPos(stop.position.lat, stop.position.lon, 0);
            const geo = new THREE.SphereGeometry(40, 8, 8);
            const mat = new THREE.MeshBasicMaterial({ color: LINE_COLORS[route.line_id] ?? 0x555555 });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.copy(pos);
            scene.add(mesh);
        }
    }

    // Plan "maintenant" (glisse vers le haut avec le temps)
    const planeGeo = new THREE.PlaneGeometry(12000, 12000);
    const planeMat = new THREE.MeshBasicMaterial({
        color: 0x88aaff,
        transparent: true,
        opacity: 0.04,
        side: THREE.DoubleSide,
    });
    nowPlane = new THREE.Mesh(planeGeo, planeMat);
    nowPlane.rotation.x = Math.PI / 2;
    scene.add(nowPlane);

    // Ligne verticale "maintenant"
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-6000, 0, 0), new THREE.Vector3(6000, 0, 0),
    ]);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x88aaff, opacity: 0.3, transparent: true });
    const nowLine = new THREE.Line(lineGeo, lineMat);
    nowPlane.add(nowLine);

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

    for (const vehicle of frame.vehicles) {
        const shape = shapeByLine[vehicle.line_id];
        if (!shape) continue;
        const color = LINE_COLORS[vehicle.line_id] ?? 0x888888;
        const traj = vehicle.trajectory;

        // Ligne p50
        const p50pts = traj.map(pt => {
            const ll = progressToLatLon(pt.p50, shape);
            return worldPos(ll.lat, ll.lon, pt.t);
        });
        if (p50pts.length >= 2) {
            const geo = new THREE.BufferGeometry().setFromPoints(p50pts);
            const mat = new THREE.LineBasicMaterial({ color, opacity: 0.9, transparent: true });
            const line = new THREE.Line(geo, mat);
            scene.add(line);
            vehicleObjects.push(line);
        }

        // Ruban d'incertitude p10–p90
        if (traj.length >= 2) {
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
            const n = traj.length;
            for (let i = 0; i < n - 1; i++) {
                const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
                indices.push(a, b, c,  b, d, c);
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geo.setIndex(indices);
            geo.computeVertexNormals();
            const mat = new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.12,
                side: THREE.DoubleSide,
            });
            const mesh = new THREE.Mesh(geo, mat);
            scene.add(mesh);
            vehicleObjects.push(mesh);
        }
    }
}

export function dispose() {
    clearVehicles();
    controls?.dispose();
    webglRenderer?.dispose();
}

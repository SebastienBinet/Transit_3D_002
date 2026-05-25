// Stratégie 1+2 : fenêtres de correspondance (statiques) + marges dynamiques
// Reçoit THREE en paramètre ; ne l'importe pas (seul renderer.js importe Three.js).

const LINE_COLORS = { L42: 0x4488ff, L17: 0xff8844, L33: 0x44cc44 };

export function create(THREE, { scene, routes, transferWindows, worldPos }) {
    const staticObjects = [];
    const dynamicObjects = [];

    function addTo(arr, obj) { scene.add(obj); arr.push(obj); }

    function disposeObj(obj) {
        scene.remove(obj);
        obj.geometry?.dispose();
        obj.material?.dispose();
    }

    // Ajoute une ligne avec double-passe pour compenser l'absence de linewidth WebGL
    function addLine(arr, pts, color, opacity) {
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        addTo(arr, new THREE.Line(geo, new THREE.LineBasicMaterial({ color, opacity, transparent: true })));
        const geo2 = new THREE.BufferGeometry().setFromPoints(pts);
        addTo(arr, new THREE.Line(geo2, new THREE.LineBasicMaterial({ color: 0xffffff, opacity: opacity * 0.35, transparent: true })));
    }

    function stopLatLon(stopId) {
        for (const route of routes) {
            const s = route.stops.find(s => s.stop_id === stopId);
            if (s) return s.position;
        }
        return null;
    }

    function stopProgressOnL42(stopId) {
        const l42 = routes.find(r => r.line_id === 'L42');
        return l42?.stops.find(s => s.stop_id === stopId)?.progress_m ?? null;
    }

    // --- Stratégie 1 : disque + barre de stationnement (statiques) ---
    for (const win of transferWindows) {
        const connLine = win.connector_vehicle_id.split('-')[0];
        const color = LINE_COLORS[connLine] ?? 0xffffff;
        const ll = stopLatLon(win.stop_id);
        if (!ll) continue;

        const posOpen  = worldPos(ll.lat, ll.lon, win.t_open);
        const posClose = worldPos(ll.lat, ll.lon, win.t_close);

        // Disque horizontal : marque l'ouverture de la fenêtre
        const disc = new THREE.Mesh(
            new THREE.CircleGeometry(200, 32),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: THREE.DoubleSide }),
        );
        disc.rotation.x = -Math.PI / 2;
        disc.position.copy(posOpen);
        addTo(staticObjects, disc);

        // Barre verticale double : durée de stationnement du connecteur
        addLine(staticObjects, [posOpen.clone(), posClose.clone()], color, 1.0);
    }

    // --- Stratégie 2 : marge dynamique (mise à jour par frame) ---
    function update(frame) {
        for (const obj of dynamicObjects) disposeObj(obj);
        dynamicObjects.length = 0;

        const l42 = frame.vehicles?.find(v => v.vehicle_id === 'L42-util');
        if (!l42) return;

        for (const win of transferWindows) {
            const connLine = win.connector_vehicle_id.split('-')[0];
            const ll = stopLatLon(win.stop_id);
            const progOnL42 = stopProgressOnL42(win.stop_id);
            if (!ll || progOnL42 === null) continue;

            let tEst = null;
            for (const pt of l42.trajectory) {
                if (pt.p50 >= progOnL42) { tEst = pt.t; break; }
            }
            if (tEst === null) continue;

            const margin = win.t_close - tEst;

            let color;
            if (margin <= 0)      color = 0x666666;  // fenêtre fermée
            else if (margin < 45) color = 0xff3333;  // serré
            else if (margin < 90) color = 0xffaa22;  // attention
            else                  color = 0x33ee77;  // confortable

            // Sphère : arrivée estimée de L42 à l'arrêt
            const posEst = worldPos(ll.lat, ll.lon, tEst);
            const dot = new THREE.Mesh(
                new THREE.SphereGeometry(110, 14, 14),
                new THREE.MeshBasicMaterial({ color }),
            );
            dot.position.copy(posEst);
            addTo(dynamicObjects, dot);

            if (margin > 0) {
                const posClose = worldPos(ll.lat, ll.lon, win.t_close);
                addLine(dynamicObjects, [posEst.clone(), posClose.clone()], color, 1.0);
            }
        }
    }

    function dispose() {
        for (const obj of [...staticObjects, ...dynamicObjects]) disposeObj(obj);
        staticObjects.length = 0;
        dynamicObjects.length = 0;
    }

    return { update, dispose };
}

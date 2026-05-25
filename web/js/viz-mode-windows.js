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

    // Résout la position lat/lon d'un arrêt depuis les données de routes
    function stopLatLon(stopId) {
        for (const route of routes) {
            const s = route.stops.find(s => s.stop_id === stopId);
            if (s) return s.position;
        }
        return null;
    }

    // Résout la progression (m) d'un arrêt sur L42
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
            new THREE.CircleGeometry(160, 32),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide }),
        );
        disc.rotation.x = -Math.PI / 2;
        disc.position.copy(posOpen);
        addTo(staticObjects, disc);

        // Barre verticale : durée de stationnement du connecteur
        const dwellBar = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([posOpen.clone(), posClose.clone()]),
            new THREE.LineBasicMaterial({ color, opacity: 0.75, transparent: true }),
        );
        addTo(staticObjects, dwellBar);
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

            // Estime quand L42 atteindra l'arrêt (premier point p50 >= prog)
            let tEst = null;
            for (const pt of l42.trajectory) {
                if (pt.p50 >= progOnL42) { tEst = pt.t; break; }
            }
            if (tEst === null) continue; // hors horizon

            const margin = win.t_close - tEst;

            // Couleur selon l'urgence
            let color;
            if (margin <= 0)   color = 0x555555;  // fenêtre fermée
            else if (margin < 45) color = 0xff4444;  // serré
            else if (margin < 90) color = 0xffaa33;  // attention
            else                  color = 0x44ee88;  // confortable

            // Sphère : arrivée estimée de L42 à l'arrêt
            const posEst = worldPos(ll.lat, ll.lon, tEst);
            const dot = new THREE.Mesh(
                new THREE.SphereGeometry(90, 12, 12),
                new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }),
            );
            dot.position.copy(posEst);
            addTo(dynamicObjects, dot);

            // Barre de marge (T_est → t_close ou t_open si T_est > t_close)
            if (margin > 0) {
                const posClose = worldPos(ll.lat, ll.lon, win.t_close);
                const marginBar = new THREE.Line(
                    new THREE.BufferGeometry().setFromPoints([posEst.clone(), posClose.clone()]),
                    new THREE.LineBasicMaterial({ color, opacity: 0.9, transparent: true }),
                );
                addTo(dynamicObjects, marginBar);
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

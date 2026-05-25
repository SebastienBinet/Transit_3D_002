// Stratégie 1+2 : fenêtres de correspondance + marges dynamiques
// Tous les éléments sont recréés à chaque frame pour suivre Y = 0 = maintenant.
// Reçoit THREE en paramètre ; ne l'importe pas.

const LINE_COLORS = { L42: 0x4488ff, L17: 0xff8844, L33: 0x44cc44 };

export function create(THREE, { scene, routes, transferWindows, worldPos }) {
    const objects = [];

    function disposeObj(obj) {
        scene.remove(obj);
        obj.geometry?.dispose();
        obj.material?.dispose();
    }

    // Double-passe pour simuler un trait épais (WebGL ignore linewidth > 1)
    function addLine(pts, color, opacity) {
        const geo1 = new THREE.BufferGeometry().setFromPoints(pts);
        const l1 = new THREE.Line(geo1, new THREE.LineBasicMaterial({ color, opacity, transparent: true }));
        scene.add(l1); objects.push(l1);
        const geo2 = new THREE.BufferGeometry().setFromPoints(pts);
        const l2 = new THREE.Line(geo2, new THREE.LineBasicMaterial({ color: 0xffffff, opacity: opacity * 0.35, transparent: true }));
        scene.add(l2); objects.push(l2);
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

    function update(frame) {
        // Tout supprimer — les positions Y dépendent du temps courant
        for (const obj of objects) disposeObj(obj);
        objects.length = 0;

        const l42 = frame.vehicles?.find(v => v.vehicle_id === 'L42-util');

        for (const win of transferWindows) {
            const connLine = win.connector_vehicle_id.split('-')[0];
            const color = LINE_COLORS[connLine] ?? 0xffffff;
            const ll = stopLatLon(win.stop_id);
            if (!ll) continue;

            // worldPos utilise currentSimTime du renderer → Y relatif au présent
            const posOpen  = worldPos(ll.lat, ll.lon, win.t_open);
            const posClose = worldPos(ll.lat, ll.lon, win.t_close);

            // --- Stratégie 1 : disque + barre de stationnement ---
            const disc = new THREE.Mesh(
                new THREE.CircleGeometry(210, 32),
                new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: THREE.DoubleSide }),
            );
            disc.rotation.x = -Math.PI / 2;
            disc.position.copy(posOpen);
            scene.add(disc); objects.push(disc);

            addLine([posOpen.clone(), posClose.clone()], color, 1.0);

            // --- Stratégie 2 : marge dynamique ---
            if (!l42) continue;
            const progOnL42 = stopProgressOnL42(win.stop_id);
            if (progOnL42 === null) continue;

            let tEst = null;
            for (const pt of l42.trajectory) {
                if (pt.p50 >= progOnL42) { tEst = pt.t; break; }
            }
            if (tEst === null) continue;

            const margin = win.t_close - tEst;

            let markerColor;
            if (margin <= 0)      markerColor = 0x666666;
            else if (margin < 45) markerColor = 0xff3333;
            else if (margin < 90) markerColor = 0xffaa22;
            else                  markerColor = 0x33ee77;

            const posEst = worldPos(ll.lat, ll.lon, tEst);
            const dot = new THREE.Mesh(
                new THREE.SphereGeometry(120, 14, 14),
                new THREE.MeshBasicMaterial({ color: markerColor }),
            );
            dot.position.copy(posEst);
            scene.add(dot); objects.push(dot);

            if (margin > 0) {
                addLine([posEst.clone(), posClose.clone()], markerColor, 1.0);
            }
        }
    }

    function dispose() {
        for (const obj of objects) disposeObj(obj);
        objects.length = 0;
    }

    return { update, dispose };
}

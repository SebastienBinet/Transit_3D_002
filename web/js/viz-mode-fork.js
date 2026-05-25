// Stratégie 3 : fourche probabiliste
// Deux chemins espace-temps depuis la position présente de L42 (Y = 0)
// jusqu'à G4, via P1→L17 et P3→L33. Opacité ∝ probabilité.
// Reçoit THREE en paramètre ; ne l'importe pas.

const LINE_COLORS = { L42: 0x4488ff, L17: 0xff8844, L33: 0x44cc44 };

export function create(THREE, { scene, routes, transferWindows, worldPos, progressToLatLon }) {
    const objects = [];

    function disposeObj(obj) {
        scene.remove(obj);
        obj.geometry?.dispose();
        obj.material?.dispose();
    }

    // Double-passe pour épaisseur visuelle
    function addLine(pts, color, opacity) {
        const geo1 = new THREE.BufferGeometry().setFromPoints(pts);
        const l1 = new THREE.Line(geo1, new THREE.LineBasicMaterial({ color, opacity, transparent: true }));
        scene.add(l1); objects.push(l1);
        const geo2 = new THREE.BufferGeometry().setFromPoints(pts);
        const l2 = new THREE.Line(geo2, new THREE.LineBasicMaterial({ color: 0xffffff, opacity: opacity * 0.30, transparent: true }));
        scene.add(l2); objects.push(l2);
    }

    function stopLatLon(stopId) {
        for (const route of routes) {
            const s = route.stops.find(s => s.stop_id === stopId);
            if (s) return s.position;
        }
        return null;
    }

    function update(frame) {
        for (const obj of objects) disposeObj(obj);
        objects.length = 0;

        const l42Veh = frame.vehicles?.find(v => v.vehicle_id === 'L42-util');
        if (!l42Veh) return;

        const l42Route  = routes.find(r => r.line_id === 'L42');
        if (!l42Route) return;

        const probL33 = frame.transfers?.find(t => t.to_vehicle_id === 'L33-util')?.probability ?? 0;
        const probL17 = frame.transfers?.find(t => t.to_vehicle_id === 'L17-util')?.probability ?? 0;

        for (const win of transferWindows) {
            const connVehId = win.connector_vehicle_id;
            const connLine  = connVehId.split('-')[0];
            const color     = LINE_COLORS[connLine] ?? 0xffffff;
            const prob      = connLine === 'L33' ? probL33 : probL17;
            const opacity   = Math.max(0.12, prob * 0.95);

            const connVeh   = frame.vehicles?.find(v => v.vehicle_id === connVehId);
            const connRoute = routes.find(r => r.line_id === connLine);
            const stopLL    = stopLatLon(win.stop_id);
            if (!connVeh || !connRoute || !stopLL) continue;

            const stopProgOnL42   = l42Route.stops.find(s => s.stop_id === win.stop_id)?.progress_m ?? null;
            const stopProgOnConn  = connRoute.stops.find(s => s.stop_id === win.stop_id)?.progress_m ?? null;
            if (stopProgOnL42 === null || stopProgOnConn === null) continue;

            const pts = [];

            // Segment 1 — L42 depuis Y = 0 (maintenant) jusqu'à l'arrêt de transfert
            for (const pt of l42Veh.trajectory) {
                const ll = progressToLatLon(pt.p50, l42Route.shape);
                pts.push(worldPos(ll.lat, ll.lon, pt.t));
                if (pt.p50 >= stopProgOnL42) break;
            }

            // Segment 2 — attente à l'arrêt (vertical jusqu'à l'ouverture de fenêtre)
            const boardPos = worldPos(stopLL.lat, stopLL.lon, win.t_open);
            if (pts.length > 0) pts.push(boardPos.clone());

            // Segment 3 — connecteur depuis l'arrêt jusqu'à G4
            for (const pt of connVeh.trajectory) {
                if (pt.p50 < stopProgOnConn) continue;
                const ll = progressToLatLon(pt.p50, connRoute.shape);
                pts.push(worldPos(ll.lat, ll.lon, pt.t));
            }

            if (pts.length >= 2) addLine(pts, color, opacity);
        }
    }

    function dispose() {
        for (const obj of objects) disposeObj(obj);
        objects.length = 0;
    }

    return { update, dispose };
}

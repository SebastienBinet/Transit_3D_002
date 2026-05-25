// Stratégie 3 : fourche probabiliste
// Pour chaque option de correspondance, trace le chemin complet
// (L42→arrêt→connecteur→G4) avec une opacité proportionnelle à la probabilité.
// Reçoit THREE en paramètre ; ne l'importe pas.

const LINE_COLORS = { L42: 0x4488ff, L17: 0xff8844, L33: 0x44cc44 };

export function create(THREE, { scene, routes, transferWindows, worldPos, progressToLatLon }) {
    const objects = [];

    function disposeObj(obj) {
        scene.remove(obj);
        obj.geometry?.dispose();
        obj.material?.dispose();
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

        const l42Route = routes.find(r => r.line_id === 'L42');
        if (!l42Route) return;

        const probL33 = frame.transfers?.find(t => t.to_vehicle_id === 'L33-util')?.probability ?? 0;
        const probL17 = frame.transfers?.find(t => t.to_vehicle_id === 'L17-util')?.probability ?? 0;

        for (const win of transferWindows) {
            const connVehId = win.connector_vehicle_id;
            const connLine = connVehId.split('-')[0];
            const color = LINE_COLORS[connLine] ?? 0xffffff;
            const prob = connLine === 'L33' ? probL33 : probL17;
            const opacity = Math.max(0.04, prob * 0.88);

            const connVeh = frame.vehicles?.find(v => v.vehicle_id === connVehId);
            const connRoute = routes.find(r => r.line_id === connLine);
            const stopLL = stopLatLon(win.stop_id);
            if (!connVeh || !connRoute || !stopLL) continue;

            const stopProgOnL42 = l42Route.stops.find(s => s.stop_id === win.stop_id)?.progress_m ?? null;
            const stopProgOnConn = connRoute.stops.find(s => s.stop_id === win.stop_id)?.progress_m ?? null;
            if (stopProgOnL42 === null || stopProgOnConn === null) continue;

            const pts = [];

            // Segment 1 : L42 depuis sa position actuelle jusqu'à l'arrêt de transfert
            for (const pt of l42Veh.trajectory) {
                const ll = progressToLatLon(pt.p50, l42Route.shape);
                pts.push(worldPos(ll.lat, ll.lon, pt.t));
                if (pt.p50 >= stopProgOnL42) break;
            }

            // Segment 2 : attente à l'arrêt (segment vertical jusqu'à l'ouverture de fenêtre)
            const lastL42Pt = pts.at(-1);
            if (lastL42Pt) {
                const boardPos = worldPos(stopLL.lat, stopLL.lon, win.t_open);
                // N'ajouter le segment vertical que si l'heure d'ouverture est dans le futur
                if (win.t_open > (lastL42Pt.y / 5 /* TIME_SCALE */)) {
                    pts.push(boardPos.clone());
                }
            }

            // Segment 3 : trajet du connecteur depuis l'arrêt jusqu'à G4
            for (const pt of connVeh.trajectory) {
                if (pt.p50 < stopProgOnConn) continue;
                const ll = progressToLatLon(pt.p50, connRoute.shape);
                pts.push(worldPos(ll.lat, ll.lon, pt.t));
            }

            if (pts.length < 2) continue;

            const line = new THREE.Line(
                new THREE.BufferGeometry().setFromPoints(pts),
                new THREE.LineBasicMaterial({ color, opacity, transparent: true }),
            );
            scene.add(line);
            objects.push(line);
        }
    }

    function dispose() {
        for (const obj of objects) disposeObj(obj);
        objects.length = 0;
    }

    return { update, dispose };
}

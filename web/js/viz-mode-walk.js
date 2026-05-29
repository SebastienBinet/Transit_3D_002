// Cas 3 — Cône de marche piétonne en espace-temps.
// Réseau de rues inventé centré sur le point de départ.
// Pas de bus : visualisation purement géométrique et statique.
//
// Représentation : rubans translucides (surface réglée par segment de rue)
// + lignes arborescentes par-dessus pour marquer les rues.
// L'axe vertical = temps, la pente d'un ruban = vitesse de marche inverse.

const WALK_MPS   = 1.4;       // m/s
const T_MAX      = 1500;      // s — horizon du cône
const LAT_M_W    = 111_000;
const BAND_OPACITY = 0.18;
const LINE_OPACITY = 0.85;

// ── Réseau de rues ─────────────────────────────────────────────────────────
// Nœuds en {lat, lon}. Distances approximatives depuis O en mètres :
//   N/S : ~600 m premier anneau, ~1200 m second
//   rues diagonales à 30°, 55°, 120°, 150° etc.
// Tout est inventé pour montrer des rues à angles variés.

const LON_REF = -73.640;
const LAT_REF =  45.508;

// Convertit un déplacement (dx_m, dy_m) depuis l'origine en {lat, lon}
function offset(dx, dy) {
    const lonM = LAT_M_W * Math.cos(LAT_REF * Math.PI / 180);
    return { lat: LAT_REF + dy / LAT_M_W, lon: LON_REF + dx / lonM };
}

// Nœuds du réseau (label → {lat, lon})
const NODES = {
    O:    offset(    0,    0),   // origine
    // Premier anneau — directions variées
    N:    offset(    0,  580),   //   0° (nord pur)
    NNE:  offset(  280,  520),   //  28°
    ENE:  offset(  500,  280),   //  61° (presque est)
    E:    offset(  590,    0),   //  90° (est pur)
    ESE:  offset(  480, -300),   // 122°
    SSE:  offset(  210, -540),   // 159°
    S:    offset(    0, -590),   // 180°
    SSW:  offset( -260, -520),   // 207°
    W:    offset( -600,    0),   // 270°
    NNW:  offset( -320,  510),   // 328°
    // Second anneau — prolongements de certaines rues
    N2:   offset(    0, 1150),
    NNE2: offset(  560, 1040),
    ENE2: offset(  990,  550),
    E2:   offset( 1190,    0),
    S2:   offset(    0,-1180),
    W2:   offset(-1200,    0),
    // Carrefours intérieurs — rues transversales entre les rayons
    X_N_NNE:  offset(  130,  580),  // rue entre N et NNE à hauteur de N
    X_NNE_ENE:offset(  420,  380),  // jonction NNE-ENE
    X_ENE_E:  offset(  560,  130),  // jonction ENE-E
    X_E_ESE:  offset(  570, -140),  // jonction E-ESE
    X_SSE_S:  offset(  100, -570),  // jonction SSE-S
    X_S_SSW:  offset( -120, -570),  // jonction S-SSW
    X_W_NNW:  offset( -530,  220),  // jonction W-NNW
    // Rues transversales 2e anneau
    X2_N2_NNE2:  offset(  270, 1130),
    X2_ENE2_E2:  offset( 1130,  250),
};

// Arêtes du réseau : chaque paire [A,B] = segment de rue bidirectionnel
const EDGES = [
    // Rayons depuis O
    ['O','N'],  ['O','NNE'], ['O','ENE'], ['O','E'],
    ['O','ESE'],['O','SSE'], ['O','S'],   ['O','SSW'],
    ['O','W'],  ['O','NNW'],
    // Prolongements vers 2e anneau
    ['N','N2'], ['NNE','NNE2'], ['ENE','ENE2'], ['E','E2'],
    ['S','S2'], ['W','W2'],
    // Transversales intérieures (créent des rues obliques non-radiales)
    ['N','X_N_NNE'],    ['NNE','X_N_NNE'],
    ['NNE','X_NNE_ENE'],['ENE','X_NNE_ENE'],
    ['ENE','X_ENE_E'],  ['E','X_ENE_E'],
    ['E','X_E_ESE'],    ['ESE','X_E_ESE'],
    ['SSE','X_SSE_S'],  ['S','X_SSE_S'],
    ['S','X_S_SSW'],    ['SSW','X_S_SSW'],
    ['W','X_W_NNW'],    ['NNW','X_W_NNW'],
    // Transversales 2e anneau
    ['N2','X2_N2_NNE2'],    ['NNE2','X2_N2_NNE2'],
    ['ENE2','X2_ENE2_E2'],  ['E2','X2_ENE2_E2'],
];

// ── Dijkstra ───────────────────────────────────────────────────────────────
// Retourne Map<nodeId, tArrival> — temps minimum (s) pour atteindre chaque nœud depuis O.

function dijkstra(nodes, edges, startId, lonM) {
    const dist = new Map([[startId, 0]]);
    const queue = [startId]; // naïf — petit graphe

    while (queue.length) {
        // Pop le nœud avec le plus petit dist connu
        queue.sort((a, b) => dist.get(a) - dist.get(b));
        const u = queue.shift();
        const tu = dist.get(u);

        for (const [a, b] of edges) {
            const v = a === u ? b : (b === u ? a : null);
            if (!v) continue;
            const na = nodes[u], nb = nodes[v];
            const dy = (nb.lat - na.lat) * LAT_M_W;
            const dx = (nb.lon - na.lon) * lonM;
            const d  = Math.sqrt(dx * dx + dy * dy);
            const tv = tu + d / WALK_MPS;
            if (tv < (dist.get(v) ?? Infinity)) {
                dist.set(v, tv);
                if (!queue.includes(v)) queue.push(v);
            }
        }
    }
    return dist;
}

// ── Couleur par temps d'arrivée ────────────────────────────────────────────
// Gradient bleu clair (proche) → orange (loin)
function colorByTime(t) {
    const r = Math.min(1, t / T_MAX);
    const R = Math.round(60  + r * 195);
    const G = Math.round(160 - r * 80);
    const B = Math.round(255 - r * 180);
    return (R << 16) | (G << 8) | B;
}

// ── Export principal ───────────────────────────────────────────────────────
export function create(THREE, { scene }) {
    const lonM = LAT_M_W * Math.cos(LAT_REF * Math.PI / 180);
    const TIME_SCALE = 5.0;

    function wp(node, t) {
        return new THREE.Vector3(
            (node.lon - LON_REF) * lonM,
            t * TIME_SCALE,
            (node.lat - LAT_REF) * LAT_M_W,
        );
    }

    // Dijkstra depuis l'origine
    const tArr = dijkstra(NODES, EDGES, 'O', lonM);

    const objects = [];

    // Marquer l'origine
    const orgDot = new THREE.Mesh(
        new THREE.SphereGeometry(60, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    orgDot.position.copy(wp(NODES.O, 0));
    scene.add(orgDot); objects.push(orgDot);

    for (const [aId, bId] of EDGES) {
        const na = NODES[aId], nb = NODES[bId];
        const ta = tArr.get(aId) ?? Infinity;
        const tb = tArr.get(bId) ?? Infinity;
        if (ta > T_MAX && tb > T_MAX) continue;

        // Clamp les temps hors-horizon pour les extrémités non atteintes
        const taC = Math.min(ta, T_MAX);
        const tbC = Math.min(tb, T_MAX);

        const pa = wp(na, taC);
        const pb = wp(nb, tbC);
        const color = colorByTime((taC + tbC) / 2);

        // ── Ruban : surface réglée entre la trajectoire de A et celle de B ──
        // Pour chaque segment de rue, on crée un quadrilatère dans l'espace-temps.
        // Les deux côtés du ruban partent du sol (t=0) et montent jusqu'à t d'arrivée.
        // Ainsi le ruban montre visuellement que la rue "prend du temps à parcourir".

        const pa0 = wp(na, 0);  // point A au sol
        const pb0 = wp(nb, 0);  // point B au sol

        const verts = new Float32Array([
            pa0.x, pa0.y, pa0.z,
            pb0.x, pb0.y, pb0.z,
            pa.x,  pa.y,  pa.z,
            pb.x,  pb.y,  pb.z,
        ]);
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
        geo.setIndex([0,2,1, 1,2,3]);
        geo.computeVertexNormals();
        const mat = new THREE.MeshBasicMaterial({
            color,
            transparent: true, opacity: BAND_OPACITY,
            side: THREE.DoubleSide, depthWrite: false,
        });
        const ribbon = new THREE.Mesh(geo, mat);
        scene.add(ribbon); objects.push(ribbon);

        // ── Ligne arborescente au-dessus du ruban ───────────────────────────
        // Seulement la portion "après l'arrivée au premier nœud" — le tronçon
        // qui va du nœud le plus tôt atteint vers le nœud suivant.
        const linePts = [pa, pb];
        const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
        const lineMat = new THREE.LineBasicMaterial({
            color, opacity: LINE_OPACITY, transparent: true,
        });
        const line = new THREE.Line(lineGeo, lineMat);
        scene.add(line); objects.push(line);

        // Cercle au nœud de départ (arrivée la plus tôt) et nœud d'arrivée
        for (const [n, t] of [[na, taC], [nb, tbC]]) {
            if (t > T_MAX * 0.99) continue;
            const dot = new THREE.Mesh(
                new THREE.SphereGeometry(30, 8, 8),
                new THREE.MeshBasicMaterial({ color }),
            );
            dot.position.copy(wp(n, t));
            scene.add(dot); objects.push(dot);
        }
    }

    // Tracé des rues au sol (Y = 0) pour référence géographique
    for (const [aId, bId] of EDGES) {
        const na = NODES[aId], nb = NODES[bId];
        const groundPts = [wp(na, 0), wp(nb, 0)];
        const gg = new THREE.BufferGeometry().setFromPoints(groundPts);
        const gl = new THREE.Line(gg, new THREE.LineBasicMaterial({
            color: 0x334455, opacity: 0.6, transparent: true,
        }));
        scene.add(gl); objects.push(gl);
    }

    function dispose() {
        for (const o of objects) {
            scene.remove(o);
            o.geometry?.dispose();
            if (o.material) { o.material.map?.dispose(); o.material.dispose(); }
        }
        objects.length = 0;
    }

    // update() sans paramètre — cône statique, pas de mise à jour par frame
    function update() {}

    return { dispose, update };
}

const LAT_M = 111_000;

// Premier instant où p50 atteint 97 % de la longueur du tracé.
// Interpolation linéaire entre les deux points qui encadrent le seuil pour
// éviter les sauts discrets causés par le pas TRAJ_STEP du simulateur.
export function estimateArrival(trajectory, routeLength) {
    const nearEnd = routeLength * 0.97;
    for (let i = 0; i < trajectory.length; i++) {
        if (trajectory[i].p50 >= nearEnd) {
            if (i === 0) return trajectory[0].t;
            const a = trajectory[i - 1];
            const b = trajectory[i];
            const r = (nearEnd - a.p50) / (b.p50 - a.p50);
            return a.t + r * (b.t - a.t);
        }
    }
    return trajectory.at(-1)?.t ?? null;
}

// Premier instant (interpolé) où p50 atteint exactement targetProgress.
// Retourne null si le seuil est hors de l'horizon de la trajectoire.
export function estimateTimeAtProgress(trajectory, targetProgress) {
    for (let i = 0; i < trajectory.length; i++) {
        if (trajectory[i].p50 >= targetProgress) {
            if (i === 0) return trajectory[0].t;
            const a = trajectory[i - 1], b = trajectory[i];
            const r = (targetProgress - a.p50) / (b.p50 - a.p50);
            return a.t + r * (b.t - a.t);
        }
    }
    return null;
}

export function interpolate(trajectory, t) {
    if (!trajectory.length) return null;
    if (t <= trajectory[0].t) return { ...trajectory[0] };
    if (t >= trajectory.at(-1).t) return { ...trajectory.at(-1) };
    const i = trajectory.findLastIndex(p => p.t <= t);
    const a = trajectory[i];
    const b = trajectory[i + 1];
    const r = (t - a.t) / (b.t - a.t);
    return {
        t,
        p10: a.p10 + r * (b.p10 - a.p10),
        p50: a.p50 + r * (b.p50 - a.p50),
        p90: a.p90 + r * (b.p90 - a.p90),
    };
}

// Pre-computes cumulative distances (metres) at each shape vertex.
export function shapeCumulativeDist(shape) {
    if (!shape.length) return new Float64Array(0);
    const lonM = LAT_M * Math.cos(shape[0].lat * Math.PI / 180);
    const cum = new Float64Array(shape.length);
    for (let i = 1; i < shape.length; i++) {
        const dy = (shape[i].lat - shape[i - 1].lat) * LAT_M;
        const dx = (shape[i].lon - shape[i - 1].lon) * lonM;
        cum[i] = cum[i - 1] + Math.sqrt(dy * dy + dx * dx);
    }
    return cum;
}

// Inserts intermediate waypoints at shape-vertex boundaries between consecutive
// trajectory points so that 3D lines follow road corners precisely.
// Corner timing is determined by p50; p10/p90 are linearly interpolated in time.
export function densifyTrajFull(traj, cumDist) {
    const out = [];
    for (let i = 0; i < traj.length; i++) {
        out.push(traj[i]);
        if (i + 1 >= traj.length) break;
        const a = traj[i], b = traj[i + 1];
        const p1 = a.p50, p2 = b.p50;
        if (p2 <= p1) continue;
        for (let k = 1; k < cumDist.length - 1; k++) {
            const pc = cumDist[k];
            if (pc > p1 && pc < p2) {
                const r = (pc - p1) / (p2 - p1);
                out.push({
                    t:   a.t   + r * (b.t   - a.t),
                    p10: a.p10 + r * (b.p10 - a.p10),
                    p50: pc,
                    p90: a.p90 + r * (b.p90 - a.p90),
                });
            }
        }
    }
    return out;
}

export function progressToLatLon(progress_m, shape) {
    if (!shape.length) return null;
    if (progress_m <= 0) return { ...shape[0] };
    const lonM = LAT_M * Math.cos(shape[0].lat * Math.PI / 180);
    let cum = 0;
    for (let i = 1; i < shape.length; i++) {
        const dy = (shape[i].lat - shape[i - 1].lat) * LAT_M;
        const dx = (shape[i].lon - shape[i - 1].lon) * lonM;
        const seg = Math.sqrt(dy * dy + dx * dx);
        if (cum + seg >= progress_m) {
            const r = (progress_m - cum) / seg;
            return {
                lat: shape[i - 1].lat + r * (shape[i].lat - shape[i - 1].lat),
                lon: shape[i - 1].lon + r * (shape[i].lon - shape[i - 1].lon),
            };
        }
        cum += seg;
    }
    return { ...shape.at(-1) };
}

// Angle THREE.js rotation.y pour aligner l'axe +X du bus sur le cap de marche.
// dx = composante Est (m), dy = composante Nord (m) du segment actif.
// Convention Z inversée (Nord = -Z) : rotation.y = atan2(dy, dx)
// → 0 = Est, π/2 = Nord, ±π = Ouest, -π/2 = Sud.
export function progressToHeading(progress_m, shape) {
    if (!shape || shape.length < 2) return 0;
    const lonM = LAT_M * Math.cos(shape[0].lat * Math.PI / 180);
    let cum = 0;
    for (let i = 1; i < shape.length; i++) {
        const dy = (shape[i].lat - shape[i - 1].lat) * LAT_M;
        const dx = (shape[i].lon - shape[i - 1].lon) * lonM;
        const seg = Math.sqrt(dx * dx + dy * dy);
        if (cum + seg >= progress_m || i === shape.length - 1) {
            return Math.atan2(dy, dx);
        }
        cum += seg;
    }
    return 0;
}

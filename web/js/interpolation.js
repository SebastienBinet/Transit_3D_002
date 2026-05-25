const LAT_M = 111_000;

// Premier instant où p50 atteint 97 % de la longueur du tracé
export function estimateArrival(trajectory, routeLength) {
    const nearEnd = routeLength * 0.97;
    for (const pt of trajectory) {
        if (pt.p50 >= nearEnd) return pt.t;
    }
    return trajectory.at(-1)?.t ?? null;
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

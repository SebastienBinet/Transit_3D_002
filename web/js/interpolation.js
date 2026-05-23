export function interpolate(trajectory, t) {
    if (!trajectory.length) return null;
    if (t <= trajectory[0].t) return { ...trajectory[0] };
    if (t >= trajectory.at(-1).t) return { ...trajectory.at(-1) };
    const i = trajectory.findLastIndex(p => p.t <= t);
    const a = trajectory[i];
    const b = trajectory[i + 1];
    const ratio = (t - a.t) / (b.t - a.t);
    return {
        t,
        p10: a.p10 + ratio * (b.p10 - a.p10),
        p50: a.p50 + ratio * (b.p50 - a.p50),
        p90: a.p90 + ratio * (b.p90 - a.p90),
    };
}

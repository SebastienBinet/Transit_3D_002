export function createPlayer(frames) {
    let index = 0;
    return {
        get frame() { return frames[index] ?? null; },
        get simTime() { return frames[index]?.sim_time ?? 0; },
        next() { if (index < frames.length - 1) index++; },
        prev() { if (index > 0) index--; },
        seekTo(simTime) {
            const i = frames.findLastIndex(f => f.sim_time <= simTime);
            index = i < 0 ? 0 : i;
        },
    };
}

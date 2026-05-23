export function createPlayer(frames) {
    let index = 0;
    let playing = false;
    let speed = 1.0;

    return {
        get frame() { return frames[index] ?? null; },
        get simTime() { return frames[index]?.sim_time ?? 0; },
        get isPlaying() { return playing; },

        play() { playing = true; },
        pause() { playing = false; },
        setSpeed(s) { speed = Math.max(0.1, s); },

        next() { if (index < frames.length - 1) index++; },
        prev() { if (index > 0) index--; },

        seekTo(simTime) {
            const i = frames.findLastIndex(f => f.sim_time <= simTime);
            index = i < 0 ? 0 : i;
        },

        tick(wallDelta) {
            if (!playing) return false;
            const newSimTime = this.simTime + wallDelta * speed;
            const i = frames.findLastIndex(f => f.sim_time <= newSimTime);
            const next = i < 0 ? 0 : Math.min(i, frames.length - 1);
            if (next !== index) {
                index = next;
                if (index >= frames.length - 1) playing = false;
                return true;
            }
            return false;
        },
    };
}

export async function loadScenario(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} pour ${url}`);
    return resp.json();
}

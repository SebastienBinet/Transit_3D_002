export function createPlayer(frames) {
    let index = 0;
    let playing = false;
    let speed = 1.0;
    let currentSimTime = frames[0]?.sim_time ?? 0;

    return {
        get frame() { return frames[index] ?? null; },
        get simTime() { return currentSimTime; },
        get isPlaying() { return playing; },

        play() { playing = true; },
        pause() { playing = false; },
        setSpeed(s) { speed = Math.max(0.1, s); },

        next() {
            if (index < frames.length - 1) {
                index++;
                currentSimTime = frames[index].sim_time;
            }
        },
        prev() {
            if (index > 0) {
                index--;
                currentSimTime = frames[index].sim_time;
            }
        },

        seekTo(simTime) {
            const i = frames.findLastIndex(f => f.sim_time <= simTime);
            index = i < 0 ? 0 : i;
            currentSimTime = frames[index]?.sim_time ?? 0;
        },

        tick(wallDelta) {
            if (!playing) return false;
            currentSimTime += wallDelta * speed;
            const i = frames.findLastIndex(f => f.sim_time <= currentSimTime);
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

/**
 * Module de diagnostics — envoie des métriques au serveur local (sim/debug_server.py).
 * Si le serveur n'est pas disponible, toutes les opérations sont silencieuses.
 *
 * Usage :
 *   import { logEvent, diagEnabled } from './diagnostics.js';
 *   logEvent('tick', { simTime: 12.5, tGroupY: -62.5, rafMs: 16.7 });
 */

const ENDPOINT   = 'http://127.0.0.1:8765/log';
const FLUSH_MS   = 800;   // envoi groupé toutes les 800 ms
const SAMPLE_DIV = 6;     // n'enregistrer que 1 tick sur N (réduit le volume)

let _enabled  = true;  // false dès le premier échec réseau
let _buf      = [];
let _timer    = null;
let _tickIdx  = 0;

/**
 * Enregistre un événement (bufferisé, envoyé en batch).
 * @param {string} type   — 'tick' | 'drawFrame' | autre
 * @param {object} data   — payload libre
 */
export function logEvent(type, data) {
    if (!_enabled) return;

    // Sous-échantillonnage des ticks pour ne pas saturer le buffer
    if (type === 'tick' && (_tickIdx++ % SAMPLE_DIV !== 0)) return;

    _buf.push({ type, ts: performance.now(), ...data });

    if (!_timer) {
        _timer = setTimeout(_flush, FLUSH_MS);
    }
}

/** Retourne true si le serveur de diagnostics a répondu au moins une fois. */
export function diagEnabled() { return _enabled; }

function _flush() {
    _timer = null;
    if (!_buf.length || !_enabled) return;
    const payload = _buf.splice(0);
    fetch(ENDPOINT, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ entries: payload }),
    }).catch(() => {
        _enabled = false; // désactive après le premier échec (serveur absent)
    });
}

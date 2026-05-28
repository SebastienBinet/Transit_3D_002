// Apparence animée des drapeaux — code isolé pour expérimentation visuelle.
// Tout ce qui concerne le comportement du tissu est ici.
// Reçoit THREE en paramètre ; ne l'importe pas.

const SEG_X = 24;    // subdivisions le long du vent (bord fixé → extrémité libre)
const SEG_Y = 6;     // subdivisions en hauteur
const FLAG_W = 220;  // largeur du tissu (unités monde)
const FLAG_H = 140;  // hauteur du tissu
const POLE_H = 450;  // hauteur du mât

function makeCheckerTex(THREE) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    for (let row = 0; row < 4; row++)
        for (let col = 0; col < 4; col++) {
            ctx.fillStyle = (row + col) % 2 === 0 ? '#162a55' : '#ddc050';
            ctx.fillRect(col * 16, row * 16, 16, 16);
        }
    return new THREE.CanvasTexture(c);
}

/**
 * Crée un drapeau animé par le vent.
 *
 * @param {object} THREE
 * @param {object} opts
 * @param {number} opts.phase  Décalage de phase propre à ce drapeau (radians).
 *                             Chaque drapeau doit avoir une valeur distincte.
 * @returns {{ group: THREE.Group, update(simTime, urgency): void }}
 *   update(simTime, urgency)
 *     simTime : temps courant de la simulation (secondes)
 *     urgency : 0 (calme) → 1 (fort vent) — correspond à l'imminence de l'arrivée
 */
/**
 * @param {number|null} opts.flagColor  Si non-null, tissu unicolore (ex. 0xff2222 = rouge).
 *                                      Si null, texture damier bleu/jaune par défaut.
 */
export function createAnimatedFlag(THREE, { phase = 0, flagColor = null } = {}) {
    const group = new THREE.Group();

    // Mât
    const poleGeo = new THREE.CylinderGeometry(10, 10, POLE_H, 6);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0xdddddd });
    const pole    = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = POLE_H / 2;
    group.add(pole);

    // Tissu — plan subdivisé pour simuler les vagues de vent
    const flagGeo = new THREE.PlaneGeometry(FLAG_W, FLAG_H, SEG_X, SEG_Y);
    // Copie immuable des positions de repos (avant toute déformation)
    const rest = flagGeo.attributes.position.array.slice();

    const flagMat = flagColor != null
        ? new THREE.MeshBasicMaterial({ color: flagColor, side: THREE.DoubleSide })
        : new THREE.MeshBasicMaterial({ map: makeCheckerTex(THREE), side: THREE.DoubleSide });
    const fabric  = new THREE.Mesh(flagGeo, flagMat);
    // Bord gauche du tissu attaché au sommet du mât
    // PlaneGeometry centré → décaler de FLAG_W/2 pour que x_local=−FLAG_W/2 soit sur le mât
    fabric.position.set(FLAG_W / 2 + 10, POLE_H - FLAG_H / 2, 0);
    group.add(fabric);

    function update(simTime, urgency = 0) {
        // Amplitude de base + bonus urgence (arrivée imminente = vent fort)
        const amp = 20 + urgency * 35;

        // Direction du vent : vient toujours de gauche (+X) ;
        // windAngle fait varier le déplacement entre Z pur (0) et jusqu'à ±45° en Y.
        const windAngle = (Math.PI / 4) * Math.sin(simTime * 0.11 + phase * 1.3);

        const pos = flagGeo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            const ox = rest[i * 3];      // X de repos (−FLAG_W/2 … +FLAG_W/2)
            const oy = rest[i * 3 + 1]; // Y de repos

            // 0 au bord fixé (mât), 1 à l'extrémité libre
            const xRatio = (ox + FLAG_W / 2) / FLAG_W;

            // Trois sinusoïdales superposées — fréquences spatiales et temporelles croissantes
            const wave =
                1.00 * Math.sin(xRatio *  5.0 - simTime * 2.6 + phase) +
                0.50 * Math.sin(xRatio * 10.5 - simTime * 4.9 + phase * 1.7) +
                0.25 * Math.sin(xRatio * 17.0 - simTime * 8.1 + phase * 2.4);

            // Déplacement croissant du mât vers l'extrémité (nul au mât)
            const disp = wave * amp * Math.pow(xRatio, 0.75);

            // windAngle décompose entre Z (profondeur) et Y (haut/bas)
            pos.setZ(i, rest[i * 3 + 2] + disp * Math.cos(windAngle));
            pos.setY(i, oy              + disp * Math.sin(windAngle));
        }
        pos.needsUpdate = true;
        // Pas de computeVertexNormals : MeshBasicMaterial n'utilise pas les normales
    }

    return { group, update };
}

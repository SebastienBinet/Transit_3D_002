// Couleurs partagées — module sans dépendance (importable par renderer.js,
// journey-panel.js et journey-model.js sans tirer Three.js).

// Couleur par circuit (identique au tracé sur la carte et aux cônes 3D).
export const LINE_COLORS = {
    L42: 0x4488ff, L17: 0xff8844, L33: 0x44cc44,
    // Lignes STM réelles — deux directions (N/S) par ligne
    "51N": 0x4488ff, "51S": 0x2255cc,
    "165N": 0xff8844, "165S": 0xcc5511,
    "11N": 0x44cc44, "11S": 0x229922,
    "129N": 0xffcc00, "129S": 0xcc9900,
    "155N": 0x44ccdd, "155S": 0x2299aa,
    "66N": 0xff4466, "66S": 0xcc1133,
    "144N": 0x88ff44, "144S": 0x55cc11,
    "124N": 0xff9900, "124S": 0xcc6600,
    "480N": 0x9900cc, "480S": 0x6600aa,
};

// Couleur par trajet (Cas 6) — une par passager/bonhomme, max 8.
export const JOURNEY_COLORS = [
    0xff5533, 0x33dd77, 0x4488ff, 0xffdd22,
    0xff44cc, 0x33dddd, 0xff9922, 0xaaff33,
];

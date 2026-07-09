# Transit-3D

Visualisation 3D espace-temps du transit. Plan horizontal = géographie (lat/lon),
axe vertical = temps (t=0 en bas, vers le haut = futur). But: faire émerger les options
de transfert et leurs probabilités que les cartes plates cachent.

Détail et raisons: voir `DECISIONS.md` (à lire avant toute décision d'architecture).
Langue de travail: français.

## Rôles

- Le porteur est architecte / product owner. Il **n'écrit ni ne révise de code**.
- Claude écrit **100 % du code et des tests**.

## Invariants à ne jamais faire dériver

- **Contrat de données** simulateur→visualizer: frames = état complet auto-suffisant + timestamp.
  Le simulateur calcule les trajectoires; le simulateur est l'autorité du temps; le visualizer
  ne fait que dessiner et n'extrapole jamais au-delà des frames reçues.
  (Données réelles STM: schéma horaire compact par circuit + rejeu déterministe du cône dans la
  couche données Three.js-free — voir DECISIONS.md §5bis. Reste dans l'esprit de l'invariant.)
- **Incertitude**: percentiles `p10/p50/p90` tranchés par temps (alignés par échantillon).
  Position en `progress_m` le long du tracé. Pas de Monte Carlo / densité volumétrique.
- **Invariants de trajectoire**: temps strictement croissant; progress monotone non-décroissant;
  p10 ≤ p50 ≤ p90; percentiles égaux à t=0.
- **Frontière swappable**: seul `web/js/renderer.js` importe Three.js. Player, interpolation et
  logique de données restent Three.js-free (testables sous Node).
- **Coordonnées**: géométrie des lignes en lat/lon. Une seule transformation lat/lon→plan, dans le
  visualizer, à la dernière étape.
- **Déterminisme**: le RNG du simulateur est toujours seedé.

## Tests

- Niveaux actifs: 1 (unitaires Python), 2 (validation schéma/contrat), 3 (logique JS headless/Node),
  5 (tests de récit). Niveau 4 = smoke test navigateur seulement.
- CI roule les tests à chaque push. Tout test important doit tourner sans navigateur ni GPU.

## Pratiques

- Ne rien assumer; vérifier. Ne pas cacher la confusion. Mettre en évidence les compromis.
- Code minimal qui résout le problème énoncé; pas de fonctionnalités spéculatives.
- En modifiant, ne changer que le nécessaire; corriger seulement les erreurs nouvellement introduites.
- Avant d'écrire/modifier du code: définir le critère de succès, puis boucler jusqu'à ce qu'il soit rempli.


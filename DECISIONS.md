# Décisions d'architecture — Transit-3D

Ce document capture les décisions structurantes du projet, avec leurs motivations et les alternatives écartées. À lire avant toute décision d'architecture ou modification du code.

---

## 1. Visualisation espace-temps 3D

**Décision** : plan horizontal = géographie (lat/lon), axe vertical = temps (t=0 en bas, futur vers le haut).

**Pourquoi** : les cartes de transit plates compriment le temps dans des annotations textuelles (horaires, couleurs). Elles cachent les conflits de correspondance et l'incertitude de propagation. Passer en 3D rend visible ce qui est invisible en 2D : deux lignes qui se croisent dans l'espace peuvent ne jamais se croiser dans le temps — aucune correspondance possible. Une carte plate ne peut pas montrer ça directement.

**Alternative écartée** : animation temporelle 2D (avancer un curseur de temps). Trop linéaire : l'utilisateur voit un instant à la fois, ne perçoit pas la structure globale des options.

---

## 2. Architecture en trois couches

**Décision** : simulateur Python → couche données/player (Node-testable) → renderer Three.js.

**Pourquoi** :
- Le simulateur est complexe (stochastique, multilignes, horaires réels) : Python est le bon outil pour ça.
- Le renderer est complexe (3D, WebGL, caméra) : Three.js est le bon outil pour ça.
- Entre les deux, la logique de données (interpolation, player, contrat de frames) n'a besoin ni de Python ni de Three.js. La garder pure JS/Node permet de la tester sans navigateur, sans GPU, rapidement en CI.

**Frontière swappable** : seul `web/js/renderer.js` importe Three.js. Si on veut changer de moteur 3D demain, on ne touche qu'à ce fichier.

---

## 3. Contrat de données simulateur → visualizer

**Décision** : les frames sont des états complets et auto-suffisants, avec timestamp. Le simulateur est l'autorité du temps. Le visualizer ne fait que dessiner ; il n'extrapole jamais au-delà des frames reçues.

**Pourquoi** : si le visualizer peut interpoler librement ou extrapoler, il devient une deuxième source de vérité sur les positions. Les bugs deviennent impossibles à localiser : est-ce le simulateur ou le visualizer qui se trompe ? En tranchant clairement — le simulateur calcule, le visualizer affiche — on peut tester chaque couche indépendamment.

**Conséquence** : si une frame manque ou est en retard, le visualizer reste sur la dernière frame connue. Jamais de "deviner" où est le véhicule.

**Alternative écartée** : envoyer seulement les deltas (positions différentielles). Plus compact, mais casse l'auto-suffisance des frames : une frame corrompue ou manquée corrompt tout ce qui suit.

---

## 4. Modèle d'incertitude : percentiles p10/p50/p90

**Décision** : l'incertitude de position est représentée par trois percentiles (p10, p50, p90), tranchés par temps, alignés par échantillon. Position exprimée en `progress_m` (mètres parcourus le long du tracé).

**Pourquoi** :
- `progress_m` est une coordonnée 1D le long d'un tracé connu. Ça évite de stocker des lat/lon brutes pour chaque percentile — la géométrie du tracé est déjà connue, seule la progression sur ce tracé est incertaine.
- Les percentiles par temps (et non par position) permettent de lire : "à t=10min, 80 % des scénarios ont le bus entre p10 et p90". C'est une question naturelle pour un voyageur.
- "Alignés par échantillon" : p10, p50, p90 sont calculés sur le même ensemble de simulations à chaque pas de temps, pas sur des distributions indépendantes. Ça garantit p10 ≤ p50 ≤ p90 et des enveloppes cohérentes.

**Alternative écartée** : Monte Carlo avec densité volumétrique (nuage de points 3D). Trop coûteux à rendre, difficile à lire, et inutilement précis pour une décision de transfert.

**Alternative écartée** : une seule trajectoire (p50 seulement). Cache l'incertitude, ce qui est précisément ce qu'on veut visualiser.

---

## 5. Invariants de trajectoire

**Décision** : dans toute frame, pour toute trajectoire :
- Le temps est strictement croissant.
- `progress_m` est monotone non-décroissante (un bus ne recule pas sur son tracé).
- p10 ≤ p50 ≤ p90 à chaque pas de temps.
- À t=0, p10 = p50 = p90 (pas d'incertitude à l'instant initial connu).

**Pourquoi** : ces invariants sont des vérités physiques et probabilistes. Les valider en entrée du visualizer permet de détecter immédiatement une corruption de données ou un bug simulateur, plutôt que de propager silencieusement des valeurs aberrantes dans le rendu.

---

## 6. Coordonnées : lat/lon unique transformation

**Décision** : la géométrie des lignes est stockée en lat/lon. Une seule transformation lat/lon → plan 2D, dans le visualizer, à la dernière étape.

**Pourquoi** : travailler en lat/lon dans tout le pipeline permet de réutiliser les données géographiques brutes (GTFS, OpenStreetMap) sans pré-projection. La projection (Mercator, équirectangulaire, etc.) est un détail de rendu, pas une décision de données. Si on change de projection, on ne touche qu'au visualizer.

**Conséquence** : le simulateur et la couche données ne connaissent pas les coordonnées écran. Ils raisonnent toujours en `progress_m` (1D sur tracé) et en lat/lon pour la géométrie de référence.

---

## 7. Déterminisme du simulateur

**Décision** : le RNG du simulateur est toujours seedé explicitement.

**Pourquoi** : un simulateur stochastique non-seedé produit des résultats différents à chaque exécution. Les tests deviennent non-déterministes, les bugs impossibles à reproduire. Le seed est un paramètre de configuration, pas une constante magique — il peut être changé pour tester différents scénarios, mais jamais omis.

---

## 8. Stratégie de tests

**Décision** :
- Niveau 1 : tests unitaires Python (simulateur).
- Niveau 2 : validation schéma/contrat des frames (interface simulateur→visualizer).
- Niveau 3 : logique JS headless sous Node (player, interpolation).
- Niveau 4 : smoke test navigateur (hors CI, manuel).
- Niveau 5 : tests de récit (scénarios end-to-end sans navigateur).

**Pourquoi** : les tests qui requièrent un navigateur ou un GPU sont lents, fragiles sur CI, et impossibles dans les environnements sans affichage. En gardant les couches simulateur et données testables sans navigateur, on peut avoir une CI rapide et fiable. Le navigateur n'est vérifié que manuellement ou en smoke test.

**Principe** : tout test important doit tourner sous `pytest` ou `node` purs. Si un test requiert un navigateur, c'est un signal que la logique testée est peut-être mal placée.

---

## 9. Langue de travail

**Décision** : le français est la langue de travail (documentation, commit messages, commentaires).

**Pourquoi** : le porteur du projet est francophone. Garder une seule langue dans toute la documentation évite les ambiguïtés de traduction sur les termes métier (correspondance, tracé, progression, etc.).

**Exception** : les identifiants de code (variables, fonctions, noms de fichiers) peuvent être en anglais si c'est la convention naturelle de l'écosystème (Python, JS). Le mélange dans le code est acceptable ; le mélange dans la documentation ne l'est pas.

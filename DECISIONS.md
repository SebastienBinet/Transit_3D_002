# Transit-3D — Registre des décisions

Document de référence consolidant les décisions prises en phase de discussion.
Lu au besoin (pas chargé automatiquement à chaque session). Le CLAUDE.md racine
en est la distillation maigre.
Langue: rédigé en français (projet solo francophone). Peut être traduit si le projet
devient collaboratif.

---

## 1. Cadre du projet

Nature: projet solo, hobby pour l'instant; possiblement commercial ou bénévolat plus tard.
Rôles: le porteur est architecte / product owner / gestionnaire des priorités. Il
n'écrit ni ne révise de code. Claude écrit 100 % du code et des tests.
Budget: ~10 h vers un prototype visuel avec données simulées; ~20 h vers un prototype
utilisant quelques données ouvertes.

---

## 2. Concept

Diagramme espace-temps 3D. Plan horizontal = géographie (lat/lon). Axe vertical = temps,
t=0 en bas (maintenant), vers le haut = futur.
Trajectoire d'un bus: rapide = quasi-horizontale; lent = pentu; arrêté = verticale.
Proposition de valeur: faire émerger les options de transfert, les probabilités de succès
et les dynamiques near-catch / near-miss que les cartes plates (Google Maps) cachent.

---

## 3. Persona

Grand public montréalais qui réalise que les outils actuels ne font pas surface aux options
ni aux probabilités de succès.

---

## 4. Rendu

Web + Three.js. Visualizer derrière une interface swappable (renderer.js).
Interface du renderer: `init(canvas, config)` / `renderFrame(frame)` / `dispose()`.
Seul `renderer.js` importe Three.js. Le player, l'interpolation et la logique de données
restent Three.js-free (testables headless sous Node).

---

## 5. Contrat de données (simulateur → visualizer)

Frames = état complet auto-suffisant + timestamp (pas de flux d'événements).
Le simulateur calcule les trajectoires; le visualizer ne fait que dessiner.
Le simulateur est l'autorité du temps; le visualizer contrôle l'affichage (player:
play/pause/scrub/vitesse) et n'extrapole jamais au-delà des frames reçues.
Pré-calculé pour le prototype: le simulateur génère toutes les frames d'avance → JSON;
le visualizer les joue comme une vidéo. Streaming reporté au système live; même format de frame
supporte les deux.
Cadence: 1 frame / 5 s de sim-time (ajustable).
Incertitude: percentiles explicites p10/p50/p90, tranchés par temps (chaque échantillon
temporel porte p10/p50/p90 alignés). Pas de rendu volumétrique de densité (pas d'échantillons
Monte Carlo). Représentation-neutre: le visualizer peut dessiner lignes, bandes, disques étirés, etc.
Position en `progress_m` (mètres le long du tracé); le visualizer convertit en lat/lon via
la géométrie de la ligne.
Invariants de trajectoire: temps strictement croissant; progress monotone non-décroissant
(arrêté = progress constant = ligne verticale); p10 ≤ p50 ≤ p90; percentiles égaux à t=0 (prototype).
Échantillonnage adaptatif: densifier aux changements de vitesse (arrêts, accélérations).
Les tournants sont gérés côté visualizer par interpolation sur la géométrie de route, PAS par
densification des données.
Vitesse moyenne par segment (optionnel): info réelle, permet au renderer de styler la
congestion sans l'inférer.
Probabilité de transfert: scalaire par transfert, calculé en interne par le simulateur
(séparé des percentiles).
Staleness (plus de frames reçues): le visualizer fige sur le sim_time de la dernière frame,
l'affiche honnêtement; indicateur "âge des données" séparé optionnel. (Pertinent au système live,
pas au prototype.)

### 5bis. Schéma horaire compact pour les données réelles STM (révision, 2026-06)

Problème: pré-calculer toutes les frames (chaque frame ré-émet la trajectoire prédite complète
de chaque véhicule) est en O(frames × véhicules × points). Pour les vraies données STM
(11 lignes, 3 passages, fenêtre 1 h, frame/2 s) le fichier monolithique atteignait **166 MB**
(> limite GitHub 100 MB), et ne tient PAS à l'échelle visée (tous les circuits, toutes les
directions, toute la semaine).

Décision: pour les scénarios issus de données réelles, stocker chaque passage (trip) **une seule
fois** sous forme d'horaire planifié `[(t_arr, t_dep, progress_m)]` (sec depuis minuit), plus un
**modèle σ global** `σ(Δt)=coeff·Δt_min^exp`. Un fichier par circuit-direction
(`web/data/circuits/{line_id}.json`) + un index (`circuits_index.json`). Chargement paresseux.
Taille: tous les circuits × directions × semaine ≈ dizaines de MB au total, KB par vue.

Réconciliation avec l'invariant "le visualizer n'extrapole jamais au-delà des frames reçues"
(§5): l'intention de l'invariant vise le cas **live** (ne pas fabriquer de prédictions que le
simulateur autoritaire n'a pas envoyées; gestion du staleness). Pour le prototype pré-calculé,
le simulateur reste l'autorité: il définit l'horaire ET le modèle σ. La couche données
Three.js-free (`web/js/scenario-model.js`) ne fait que **rejouer déterministe­ment** ces deux
sorties pour reconstruire le cône p10/p50/p90 du « maintenant » courant — elle n'invente aucune
nouvelle prédiction. Le `frame` synthétisé reste de forme identique (`vehicles[].trajectory` de
PercentilePoint), donc `renderer.js` est inchangé. Modèles Pydantic source de vérité:
`StopVisit / TripSchedule / SigmaModel / CircuitData / CircuitIndex`. Couverture: L2
(`test_circuits_stm.py`) pour le schéma, L3 (`test_scenario_model.mjs`) pour la reconstruction
du cône (mêmes invariants: temps croissant, progress non-décroissant, p10≤p50≤p90, égaux à t=0).

Les scénarios jouet (`scenario1/2.json`) conservent le format frame d'origine (mode récit).

---

## 6. Système de coordonnées

Géométrie des lignes stockée en lat/lon (fictives mais plausibles pour la région de Montréal,
pour le prototype).
Une seule transformation de coordonnées (lat/lon → plan écran) vit dans le visualizer, à la
dernière étape. Raison: garder toutes les données du pipeline en unités natives de la source
(cohérent avec les futures données ouvertes), maximiser la débogabilité contre l'open data, et
isoler les bogues de rendu des bogues de données.

---

## 7. Fond de carte

Prototype: carte fictive/synthétique (plan stylisé), créée avec les trajets. Couche séparée
et swappable. Vraie carte de Montréal reportée au système live.

---

## 8. Scénario de démo

3 lignes (L42 tronc, L17, L33), 5 arrêts chacune. Grande distance Origine→P1.
Pour chaque ligne, 3 passages montrés: précédent, utile, suivant (9 bus au total).
Fréquences provisoires: L33 ≈ 20 min, L42/L17 ≈ 15 min (à tuner).
Transferts à des arrêts différents: P1 (→L17), P3 (→L33).
Deux cas, partageant des prédictions initiales identiques (95 % d'attraper L33):

**Cas 1**: rester sur L42 jusqu'à P3, transférer à L33. L42 normal → attrape L33.
Total 20-30 min. (Manqué → prochain L33 +20 min → 40-50 min.)

**Cas 2**: mêmes prédictions initiales, mais L42 se réalise lent (~5e percentile). La
probabilité d'attraper L33 chute; avant P1 c'est trop risqué. Repli à P1 vers L17 (fiable).
Total 25-35 min, plafonne le risque.

Seule la vitesse de L42 varie entre les cas; L33/L17 tenus nominaux/à l'heure. Le transfert
L17 à P1 est fiable (filet de sécurité).
Seuil de décision (P sous laquelle "trop risqué") fixé au tune-up.
Deux fichiers de scénario (scenario1.json, scenario2.json) partageant l'ouverture.
Horizon de prédiction ≈ 30 min (couvre le trajet complet).
Simulation: lecture normale et accélérée. Caméra: autopilot (orbite + scrub temporel scripté) et
manuelle.

---

## 9. Critère de succès du prototype (~10 h)

Sur la page GitHub Pages, l'utilisateur voit une représentation 3D d'une zone simulée (3 lignes,
5 arrêts chacune) avec axe temps vertical (t=0 en bas). Le scénario à deux cas est visualisable:
Cas 1 (le plan tient) et Cas 2 (repli adaptatif). En lecture accélérée, l'utilisateur observe les
enveloppes d'incertitude se resserrer à mesure que le temps avance, et le point de décision (avant
P1) où le risque devient lisible et justifie le repli. Deux modes caméra: autopilot et manuel.

(Affine la formulation initiale "trois trajets distincts" en le scénario à deux cas avec transferts
à des arrêts différents — voir §8.)
Hors scope du prototype: données réelles; authentification; backend persistant; mobile; autres
moyens de locomotion; météo/amis/activités; saisie de destination (origine/destination en dur).

---

## 10. Stack technique & dépôt

Dépôt: transit-3d, public, licence AGPL-3.0.
Hébergement: GitHub Pages, déploiement auto depuis `web/` via GitHub Action au push sur main.
Environnement de dev: Claude Code on the web (connecté à GitHub).
Simulateur: Python (modèles Pydantic = source de vérité du schéma de frame).
Visualizer: JS + Three.js.
Déterminisme: le RNG du simulateur est toujours seedé.

---

## 11. Tests

Niveaux: 1 (unitaires Python), 2 (validation du contrat/schéma), 3 (logique JS, headless/Node),
5 (tests de récit/domaine). Tous headless, exécutables par Claude.
Niveau 4 (navigateur): smoke test seulement pour le prototype; régression visuelle reportée
jusqu'à stabilisation des visuels.
CI dès le départ: GitHub Action roule les tests à chaque push.

---

## 12. Pratiques de travail

Ne rien assumer; vérifier. Ne pas cacher la confusion. Mettre en évidence les compromis.
Code minimal qui résout le problème énoncé; pas de fonctionnalités spéculatives.
En modifiant du code, ne changer que le nécessaire; corriger seulement les erreurs nouvellement
introduites.
Avant d'écrire/modifier du code, définir le critère de succès et boucler jusqu'à ce qu'il soit rempli.

---

## 13. Mémoire & contexte

Logs: `discussions/raw/` (verbatim, non chargé auto), `discussions/AAAA-MM-JJ_*.md` (résumés
structurés), `DECISIONS.md` (ce fichier).
Pas de skills Claude Code custom au départ: hiérarchie CLAUDE.md + sous-agents au besoin.
Pas de Claude Design à l'étape prototype (à reconsidérer pour le polissage UI / produit réel).
CLAUDE.md racine maigre (chargé chaque session); le détail/pourquoi vit ici.

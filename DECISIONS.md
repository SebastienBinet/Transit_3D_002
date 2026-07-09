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

---

## 14. Cas 7 — Choix vivants (décisions du porteur, 2026-07-06)

Concept : le panneau ne montre plus des trajets figés (Cas 6) mais **l'ensemble des
prochaines actions possibles « maintenant »**, qui expirent et sont remplacées.
L'usager peut s'engager dans un choix et changer d'idée tant que c'est faisable.

Décisions :
- **Colonne = prochaine action** (« attendre la 51 », « marcher vers la 103 »,
  « descendre à X pour la 165 »), pas un trajet complet. La CDF de gauche est la
  distribution d'arrivée conditionnelle à s'engager maintenant, agrégée sur les
  meilleurs trajets qui découlent de l'action.
- **Interactif** : clic sur une colonne = s'engager. Un seul bonhomme 3D. Le moteur
  recalcule les choix depuis la position courante (changer d'idée en pleine marche
  est permis tant que les horaires le permettent).
- **Péremption au p50 planifié** (déterministe). Le modèle σ ne sert qu'aux CDF.
  Tension assumée : le panneau dit « trop tard » là où la CDF dirait « il restait
  une chance » — à revisiter après le prototype.
- **N = 4 meilleurs choix**, dédoublonnés par ligne-direction (départ le plus tôt
  attrapable). Quand un choix meurt, son remplaçant (passage suivant) apparaît.
- **Colonnes** : les nouvelles entrent à droite ; un choix mort reste affiché,
  estompé, sa largeur décroît jusqu'à 0 en 15 min puis il est retiré. Transitions douces.
- **Fenêtre glissante** : 90 min de futur, 15 min de passé ; la ligne « maintenant »
  reste fixe à 15/105 de la hauteur. Le diagramme « coule » vers le bas.
- **Marches affichées** ; une marche non entamée est ancrée à max(maintenant, plus
  tôt possible) — elle glisse avec le temps puis le choix expire.
- **Pas de légende ni de sélecteur de mode** : bandes + CDF seulement.

Architecture : `web/js/choice-engine.js` = moteur **pur** (aucun import DOM /
Three.js / Canvas), testable sous Node (L3). Il énumère la faisabilité par un
Dijkstra temporel sur les horaires compacts (§5bis) — rejeu déterministe des p50
et du modèle σ, aucune prédiction inventée (même réconciliation que §5bis).
**Portabilité** : ce moteur servira de référence pour le futur code Python temps
réel du produit ; d'où : fonctions data-in/data-out, état explicite (plan de legs),
constantes nommées, pas d'astuce navigateur. Le modèle de probabilité (σ d'événement,
P(transfert), CDF) y est réimplémenté paramétriquement ; la copie interne de
journey-panel.js (Cas 6) est conservée telle quelle — le moteur fait foi pour le
portage. `web/js/choice-panel.js` (DOM/Canvas) ne fait que dessiner.

---

## 15. Dette technique connue

Liste des compromis assumés, à revisiter selon les déclencheurs indiqués.

### 15.1 Coût de la recherche du moteur de choix (Cas 7)

**Constat.** `web/js/choice-engine.js` énumère la faisabilité par un Dijkstra
temporel. Le nombre d'états explosé combinatoirement à cause de la règle « au
plus une ligne par numéro » : un même arrêt est atteignable via de nombreux
SOUS-ENSEMBLES de lignes, chacun étant un état distinct. La recherche atteint
donc son garde-fou (`MAX_SETTLES`) à *chaque* appel.

**État actuel (mitigation, pas correction).** `MAX_SETTLES = 50_000` (compte
d'états, volontairement déterministe — pas un budget en secondes qui varierait
selon le CPU et figerait l'UI). Couvre la fenêtre du scénario (départ 7h00 →
~8h00) avec marge, ~480 ms au pire par énumération (peu fréquent : cache
événementiel). Au-delà de ~8h00 avec les données actuelles, la 1re complétion
tombe au-delà du garde-fou → 0 choix.

**Surveillance en place.** `engine.lastSearchStats` + `console.warn` quand une
recherche est coupée sans complétion ; test L3 « garde-fou » ; barrière dans
`data-sync.yml` (tests L3 avant commit/déploiement). Une régression de données
qui repousse la 1re complétion échoue donc en CI, pas en silence.

**Temps-tranché (2026-07, mitigation du « burst » en lecture).** L'énumération
bloquait le fil principal ~300-1000 ms tous les ~30 s de sim (freeze périodique
en lecture). Corrigé : le Dijkstra est un **générateur** qui cède la main tous
les 256 états ; `getChoicesSliced(tAbs)` (utilisé par le panneau) le déroule par
budgets de ~5 ms/frame en affichant les derniers choix connus pendant le calcul.
`getChoices(tAbs)` reste synchrone (frais) pour les tests et `commit`. Plus de
freeze aux vitesses usuelles (×5-×20). Contrepartie : aux vitesses élevées
(×60/×120) les choix accusent un léger RETARD le temps que le calcul rattrape —
symptôme, pas cause. La recherche dirigée (ci-dessous) supprimerait ce retard.

**Pistes de correction (non faites).** Ce qui a été TESTÉ sans effet : réduire
l'horizon temporel (`maxJourneyS`), filtre géographique de couloir (ellipse) —
la borne vient de la dimension « sous-ensemble de lignes », pas de l'espace ni
du temps. Vrais remèdes : recherche **dirigée A\*** vers la destination
(heuristique admissible = distance à vol d'oiseau / vitesse bus max) ; et/ou
**plafond de correspondances** (2–3 bus) bornant la profondeur ; et/ou revoir la
clé d'état pour ne pas multiplier par les sous-ensembles de lignes.

**Déclencheur.** À attaquer si on élargit à un corridor plus dense/plus long, à
plusieurs corridors, ou si la latence d'énumération devient gênante en lecture.

## 16. Cas 7 — mode « Cohorte 1000 » (2026-07-09)

Mode d'animation alternatif (bascule « Animation : Survol d'un choix / Cohorte
1000 » dans le HUD d'essai). À l'activation on lâche **1000 voyageurs** au point
de départ ; ils se **répartissent sur les choix** de premier départ, avancent le
long de leur trajectoire en **temps machine**, et quand tous sont arrivés la
**vague se relance** (recalculée au « maintenant » courant). Le but : rendre le
**risque de rater une correspondance** tangible — on voit le paquet se scinder et
des traînards diverger — et faire ressortir le trajet à privilégier.

**Déterministe, PAS Monte Carlo (invariant préservé).** L'invariant §incertitude
interdit les échantillons Monte Carlo. La cohorte ne tire donc **rien au hasard** :
- répartition **1/N** sur les choix (comparaison équitable qui révèle le risque
  sans le biaiser ; pondérer par attractivité fausserait la conclusion cherchée) ;
- dans un choix, effectifs par **réalisation** (`getChoiceRealizations`, cf. §14
  item 4) **proportionnels à la proba** (plus grand reste → somme exacte) ;
- dans une réalisation, étalement aux **quantiles p10..p90** de l'incertitude de
  départ (`invNorm` × σ) : un bonhomme à p10, un à p90, le reste réparti.
Deux appels identiques donnent la **même cohorte** (test L3 `test_cohort.mjs`).
Le « retard → correspondance ratée → autre itinéraire » est donc **causal** (porté
par les réalisations), pas un coup de dé. `getCohort` reste **Three.js-free** et
portable (référence pour le futur produit Python).

**Teinte « par chance » vs « prévisible » (1re version, à discuter).** Chaque
bonhomme est teinté par la proba de son trajet réalisé : vert-sarcelle = fiable
(fait ses correspondances avec marge), jaune = serré, **ambre = a raté une
correspondance et rerouté** (« arrivé autrement que prévu »). Une route fiable →
essaim vert groupé ; une route risquée → noyau + traînée ambrée. Critère et
palette **restent ouverts** (décision du porteur reportée).

**Rendu.** `THREE.Points` (sol + ciel) + `LineSegments` (liaisons du mode « les
deux ») — un draw call par couche pour tenir 1000+ figures. L'espacement du flux
de survol **n'a pas de sens** ici et est masqué ; l'axe sol/espace-temps/les-deux
et la vitesse restent partagés.

**Coûts / limites (v1).** `getCohort` appelle le Dijkstra (choix + reroutes) : un
**hitch ~1 s à l'entrée du mode** et à chaque relance **si** « maintenant » a
bougé de >60 s (garde-fou ; en pause, aucune reconstruction). À temps-trancher si
gênant (même piste que §15.1). Étalement borné à σ≤300 s. La **sélection du
trajet par l'utilisateur** à partir de ce qu'il voit reste **à concevoir** (le
porteur veut juger la visualisation d'abord).

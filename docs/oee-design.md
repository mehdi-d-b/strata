# Strata — OEE : conception (la grosse réflexion avant de coder)

> Document de cadrage. L'OEE est **le** KPI industriel ; son modèle de données doit être
> pensé **avant** d'écrire des vues SQL, sinon on le refait. Ce doc tranche : **qu'est-ce
> qu'on mesure, comment on calcule, ce qu'on affiche**, et surtout **la tension « standard
> imposé vs interface de liaison »**. Aucune implémentation ici — c'est la cible.

## 0. Rappel : OEE = Disponibilité × Performance × Qualité

L'OEE (Overall Equipment Effectiveness) résume les **« Six Big Losses »** en trois facteurs :

| Facteur | Mesure | Pertes capturées |
|---|---|---|
| **Disponibilité** (A) | temps de marche / **temps planifié** | pannes, changements de série (arrêts) |
| **Performance** (P) | production réelle / production théorique au temps de marche | micro-arrêts, sous-vitesse |
| **Qualité** (Q) | bonnes pièces / pièces totales | rebuts, retouches |

**OEE = A × P × Q.** Équivalent : `bonnes_pièces / (temps_planifié × cadence_nominale)` —
la « part de temps pleinement productif ». Repères : **85 % = world-class**, ~60 % = courant.

⚠️ **Le piège du chiffre unique** : un OEE de 65 % ne dit pas *quoi corriger*. La valeur est
dans la **décomposition des pertes** (où part le temps : dispo ? vitesse ? qualité ?). C'est
ce qu'il faut afficher (cf. §5), pas juste un pourcentage.

## 1. LA décision : standard imposé vs interface de liaison

Mehdi a vu des machines où l'état est un **énuméré** (0/1/2…), d'autres un **booléen**, d'autres
un **compteur**. Deux philosophies s'opposent :

- **(a) Imposer un standard** : on force l'automaticien à créer LES bonnes variables (ex. un
  booléen `running` normalisé). *Simple en aval, mais irréaliste* : sur un parc existant
  (brownfield), on ne **dicte pas** le programme d'un automate déjà en prod ; on fait avec ce
  qui existe.
- **(b) Interface de liaison** : le technicien **mappe** ses tags réels vers ce dont l'OEE a
  besoin. *Réaliste, mais demande une couche de config + des règles d'interprétation.*

**Recommandation : ni l'un ni l'autre seul — les deux moitiés du même contrat.** C'est
exactement le principe fondateur de Strata (*southbound pluggable* : normaliser au bord, l'aval
ne connaît que le contrat) appliqué à l'OEE :

> **Strata définit un STANDARD SÉMANTIQUE** (les « rôles » dont l'OEE a besoin : *running*,
> *produced*, *ok*, *cadence nominale*, *temps planifié*). **Chaque ligne BINDE ses tags réels
> à ces rôles** via la config. Le *sens* est standard ; la *liaison* est flexible.

On gagne les deux : l'aval (le calcul OEE) voit toujours la même chose (uniforme), **et** on
s'adapte à n'importe quelle forme de signal (réaliste). C'est déjà le pattern de `tag_role`
(`produced/ok/scrap/available`) — on l'étend.

### Gérer l'hétérogénéité du signal d'état (le cœur du problème)

Le signal « la machine tourne » arrive sous des formes variées. Deux façons de l'absorber :

1. **Normaliser au BORD** (préféré, le plus « Strata ») : le normaliseur de la source produit un
   tag canonique `...running` (0/1). L'énuméré→booléen, l'inversion d'un signal `arrêt`, etc.,
   se font **à l'entrée** (Redpanda Connect / le normaliseur). L'OEE ne voit qu'un booléen propre.
2. **Règle d'interprétation en CONFIG** (pragmatique, sans toucher au normaliseur) : le binding
   porte une petite **règle** — ex. `running = (state == 1)`, `running = (value > 0)`,
   `running = NOT stopped`. Couvre les cas simples (énuméré, booléen, inverse) sans code.

**Reco** : règle en config pour les cas simples (énuméré/booléen/inverse), normalisation au bord
pour les cas tordus (plusieurs codes d'arrêt, machines composites). Jamais de logique d'état
**codée en dur** dans le calcul OEE — elle vit dans le binding (config) ou au bord.

## 2. Ce qu'on MESURE (les entrées sémantiques)

L'OEE a besoin de **cinq entrées**, par équipement/ligne et par fenêtre de temps :

| Entrée | Nature | Source chez nous |
|---|---|---|
| **Temps planifié** (PPT) | *calendaire/config* | `shift_schedule` (durée du shift) **− arrêts planifiés** (pauses) |
| **Temps de marche** (run time) | *capteur* | tag `running` (rôle à binder ; cf. §1) |
| **Pièces totales** (produced) | *compteur* | rôle `produced` (ou `ok` + `scrap`) |
| **Bonnes pièces** (ok) | *compteur* | rôle `ok` |
| **Cadence nominale** (ideal rate) | *config (plaque/fiche)* | **NOUVEAU** : par ligne (idéalement **par produit**) |

Deux entrées ne sont **pas des capteurs** : le **temps planifié** (calendaire) et la **cadence
nominale** (donnée constructeur). C'est normal : l'OEE mélange du terrain et du référentiel.

## 3. Comment on CALCULE (formules + cas limites)

```
Disponibilité = temps_marche / temps_planifié
Performance   = produced / (temps_marche × cadence_nominale)     [plafonné à 100 %]
Qualité       = ok / produced
OEE           = A × P × Q
```

**Cas limites à gérer explicitement (sinon NaN/0 trompeurs) :**
- `temps_marche = 0` → Performance indéfinie (afficher *N/A*, pas 0).
- `temps_planifié = 0` (hors shift) → Disponibilité indéfinie.
- `produced = 0` → Qualité indéfinie.
- **Performance > 100 %** → la cadence nominale est fausse (ou comptage faux) → plafonner **et
  signaler**, c'est un indice de mauvaise config.

**Pièges métier (importants) :**
- **« En attente » ≠ « à l'arrêt ».** L'embouteilleuse qui *tourne mais attend* du moût est
  *running* (Dispo OK) mais ne produit pas → ça doit ressortir en **perte de Performance**, pas
  de Disponibilité. Donc `running` = l'état machine, indépendamment du « waiting ». (Le sim
  expose déjà `.state` ET `.en_attente` — parfait pour vérifier ça.)
- **Cadence par PRODUIT.** Une ligne fait Blonde à 50/min et IPA à 40/min : la Performance doit
  utiliser la cadence du produit *en cours*. En v1 : cadence par ligne (acceptable). Évolution :
  cadence par produit (la ligne sait quel produit elle fait).
- **Arrêts planifiés vs non planifiés.** Une pause déjeuner ne doit **pas** plomber l'OEE : elle
  sort du *temps planifié*. Un `.state` seul ne distingue pas planifié/non planifié — il faut
  un **calendrier d'arrêts planifiés** OU des **codes motif d'arrêt**. En v1 : tout arrêt en
  shift = perte de Dispo (légèrement pessimiste) ; évolution : calendrier de pauses + motifs.
- **Resets de compteurs** : déjà gérés (delta = max−min dans `prod_buckets`).

## 4. Le modèle de données proposé (haut niveau)

Réutilise au maximum l'existant (`prod_buckets`, `prod_by_shift`, `tag_role`, `shift_schedule`) :

1. **Config `oee_line`** : `line` (préfixe métier, ex `brasserie.blonde`), `label`,
   `ideal_rate` (pièces/min), `running_tag` + **règle** (`running_value` ou expression),
   `enabled`. (Évolution : `ideal_rate` par produit.)
2. **Continuous aggregate `state_buckets`** : par tranche de 15 min et par `running_tag`, la
   **fraction d'échantillons** satisfaisant la règle `running` → **minutes de marche** (même
   philosophie ETL que `prod_buckets`, jamais de recalcul à l'ouverture de page).
3. **Vue `oee_by_shift`** : joint, par ligne × jour × shift : `ok`/`produced` (depuis
   `prod_by_shift` filtré par préfixe de ligne), `run_minutes` (depuis `state_buckets`),
   `planned_minutes` (durée du shift) → calcule A, P, Q, OEE (avec les gardes du §3).
4. **Gateway** : `GET /api/oee?days=N` (+ CRUD admin de `oee_line`).

Reste cohérent avec la règle des 3 moteurs : **Timescale = repos/agrégats** (ici), gateway =
API, RisingWave = si on veut l'**OEE *live*** (temps réel, fenêtre glissante) plus tard.

## 5. Ce qu'on AFFICHE (le plus important pour la valeur)

- **Les 3 jauges A / P / Q + l'OEE** par ligne, par shift/jour. Avec le **repère 85 %**.
- **La cascade des pertes (waterfall)** : 100 % → −perte dispo → −perte perf → −perte qualité →
  OEE. *C'est le vrai or* : ça dit **où agir**, là où le chiffre unique ne dit rien.
- **Tendance** : OEE par shift sur N jours (détecter dérives, comparer équipes/lignes).
- **Drill-down (évolution)** : décomposition des arrêts par **motif** (si codes motif), top pertes.

Le backend (vues + API) est **agnostique** de l'affichage : jauges, waterfall, tendance se
branchent tous sur `oee_by_shift`. L'UI peut donc être itérée par un chat front sans toucher au
calcul.

## 6. Séquençage proposé

1. **v1 (socle honnête)** : binding `oee_line` (running_tag + règle + ideal_rate/ligne), agrégat
   `state_buckets`, vue `oee_by_shift`, `/api/oee`. PPT = durée pleine du shift. Affichage =
   table A/P/Q/OEE (jauges/waterfall ensuite). **Prouve la valeur, sans sur-ingénierie.**
2. **v2 (réalisme)** : cadence **par produit**, **calendrier d'arrêts planifiés** (les pauses
   sortent du PPT), **codes motif d'arrêt** (décomposition de la Dispo).
3. **v3 (temps réel)** : OEE *live* via RisingWave (fenêtre glissante), waterfall animé,
   alertes OEE (chute sous seuil) — réutilise le modèle d'alarmes (`source='derived'`).

## 7. Décisions ouvertes (pour Mehdi)

**Décisions actées (2026-06-09) :**
1. **Binding** = ✅ **standard sémantique + liaison en config** (running_tag canonique 1=marche ;
   normalisation au bord pour les cas tordus). Pas de « on force l'automaticien ».
2. **Granularité** = ✅ **ligne × shift** en v1 ; le **produit** en v2.
3. **Temps planifié** = ✅ **durée pleine du shift** en v1 ; calendrier de pauses en v2.
4. **Périmètre** = ✅ **backend seul** (SQL + `/api/oee` + CRUD config) ; le web part dans un chat
   front dédié, guidé par la notice ci-dessous (§8). *(Raison : le front a un design system vivant
   qu'un chat dédié maintient ; je livre le contrat de données, pas la vue.)*

## 8. Notice pour le chat front (contrat d'API + ce qu'il faut afficher)

> Le backend OEE est **fait** (`infra/timescale/init/09-oee.sql` + routes gateway). Le front n'a
> qu'à **consommer ces endpoints**. Rien à calculer côté web : tout est pré-calculé.

### Endpoints

**`GET /api/oee?days=N`** (ouvert, comme `/api/production`) → tableau de lignes, une par
**ligne × jour × shift** :

| champ | type | sens |
|---|---|---|
| `line` | string | préfixe métier (ex `brasserie.blonde`) |
| `line_label` | string\|null | libellé lisible |
| `day` | date (`YYYY-MM-DD`) | jour |
| `shift_no`, `shift_label` | int, string\|null | shift |
| `ok`, `produced` | number\|null | bonnes pièces / total |
| `run_minutes`, `planned_minutes` | number\|null | marche / planifié (pour tooltips & waterfall) |
| `ideal_rate` | number | cadence nominale (pièces/min) |
| `availability`, `performance`, `quality` | number\|null | **0..1** (facteurs A/P/Q) |
| `oee` | number\|null | **0..1** = A×P×Q |
| `is_current` | bool | ce shift est-il **en cours** ? |
| `elapsed_minutes` | number | temps **écoulé** du shift (= `planned_minutes` si terminé) |
| `availability_elapsed` | number\|null | Dispo vs temps **écoulé** (pour un shift en cours : plus juste que `availability` qui compare aux 12 h entières) |
| `target_oee` | number\|null | cible OEE (0..1) si définie |
| `target_pieces` | int\|null | objectif de pièces du shift |
| `projected_pieces` | int\|null | **projection** fin de shift à l'allure actuelle (= `produced` si terminé) |
| `pieces_ratio` | number\|null | `produced / target_pieces` (pour la **barre de remplissage**) |
| `on_track` | bool\|null | la projection atteint-elle la cible ? |

⚠️ **Les facteurs peuvent être `null`** (division par 0 : pas de marche, hors shift, 0 pièce, ou
`running_tag` non configuré) → afficher **« — » / N/A**, jamais 0.

**Config (admin)** — `GET/POST /api/oee-lines` + `DELETE /api/oee-lines/:line` (cadence/running_tag) ;
`GET/POST /api/oee-targets` + `DELETE /api/oee-targets/:line` (cible OEE + objectif pièces). UI
d'édition *optionnelle* (la config marche déjà via SQL/seed).

### Ce qu'il faut afficher (par ordre de valeur)

1. **Carte par ligne (shift courant)** : un grand **OEE %** + **3 jauges A / P / Q**. Seuils
   couleur : `≥0.85` vert (world-class), `0.6–0.85` ambre, `<0.6` rouge. Repère 85 %.
2. **Cascade des pertes (waterfall)** — *le plus important* : `100 % → ×A → ×P → ×Q → OEE`,
   chaque marche montrant la perte (dispo / perf / qualité). C'est ce qui dit **où agir**.
3. **Objectifs & barres de remplissage** (idée Mehdi, très efficace) : dans la table, **fond de
   cellule rempli** proportionnellement à `pieces_ratio` (produced vs `target_pieces`) et à
   `oee/target_oee` — vert si ≥ cible, ambre/rouge sinon. Affichage *data bar*.
4. **Projection « à l'allure actuelle »** : pour un shift `is_current`, montrer
   `produced → projected_pieces / target_pieces` + un badge **`on_track`** (✅/⚠️). C'est *la*
   question opérateur (« vais-je tenir la cible ? »). Pour ce shift, utiliser
   **`availability_elapsed`** (pas `availability`) pour ne pas afficher un faux 2 % en milieu de shift.
5. **Tendance** : OEE par shift sur N jours (ligne/aires), filtrable par ligne.
6. **Table** brute (ligne/jour/shift + A/P/Q/OEE + `produced`/`ok`) pour le détail.

Placement suggéré : un onglet **OEE** (ou une section de l'onglet Production existant). États N/A
gérés proprement. Pas de recalcul côté front — uniquement de l'affichage.

### Pré-requis de données (à savoir)
- Les compteurs de la ligne doivent avoir les **rôles `ok`/`scrap`** (`tag_role`). Pour la démo
  brasserie, la gateway les **auto-assigne** (`seedDemoRole`, à la découverte des tags
  `.bouteilles_ok`/`.bouteilles_rebut`) ; sinon ça se règle via l'onglet Production.
- Chaque ligne OEE doit avoir un **`running_tag`** configuré (sinon A et P = N/A).
- `running_tag` = convention **canonique 1 = en marche** (sinon normaliser au bord).

### Mise en service sur une base EXISTANTE (l'init SQL ne tourne qu'au 1er boot)
```bash
docker compose exec -T timescaledb psql -U strata -d strata < infra/timescale/init/09-oee.sql
# puis backfill de l'agrégat des minutes de marche sur l'historique :
docker compose exec timescaledb psql -U strata -d strata \
  -c "CALL refresh_continuous_aggregate('oee_state_buckets', NULL, NULL);"
```

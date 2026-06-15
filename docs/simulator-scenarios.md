# Simulateur — batchs & scénarios causaux (cahier des charges)

> **Statut : spec à valider, rien n'est codé.** Ce document fige *quoi* construire dans le
> simulateur avant d'écrire la moindre ligne. À relire / amender avant implémentation.

## Pourquoi ce chantier

L'assistant IA (chemin B, voir [llm-integration.md](llm-integration.md)) ne devient utile que
s'il peut **enquêter** sur une chaîne cause→effet réelle. Or :

- une enquête (« pourquoi ce batch est hors spec ? ») n'a de sens que si le **batch existe**
  comme entité, avec une fenêtre temporelle à laquelle rattacher mesures / alarmes / consignes ;
- et l'assistant ne peut juger que ce qui est **modélisé et ingéré** — si l'effet final (le
  *verdict qualité*) n'est jamais une donnée, il n'y a rien à corréler ;
- enfin, **nous** avons besoin d'une **vérité terrain** : sans scénarios déterministes et
  reproductibles, impossible de savoir si l'assistant a raison ou s'il hallucine.

Le simulateur est donc l'équivalent, pour l'assistant, de ce que sont les tests pour du code :
il fournit des cas dont **on connaît la réponse**.

## État actuel (déjà bon, à ne pas refaire)

Le cerveau ([simulator/factory/brain.py](../simulator/factory/brain.py)) a déjà :

- la **causalité** écart température → `quality` (0..1) → taux de rebut à l'embouteillage —
  le rebut **raconte** le procédé, il n'est pas aléatoire ;
- un **bit d'alarme dérivé** non-random `defaut_thermique` (1 quand l'écart > 2× tolérance) ;
- un **scénario scripté** cause-à-effet ([scenario.py](../simulator/factory/scenario.py),
  `DEMO_SCENARIO`), bouclé toutes les 6 min.

Ce qui **manque** : des batchs discrets, un verdict QC en donnée, une discrimination entre
causes (axe non-thermique), des dérives progressives, et des scénarios déclenchables à la demande.

## Principe directeur

La **causalité vit dans le cerveau** (la physique du procédé). Les **faces** (MQTT/PLC) ne font
que l'exposer. Un scénario = un **déclencheur** ; le **batch + verdict** = l'endroit où l'**effet**
se lit. On ne colle jamais une étiquette « batch raté » au hasard : le verdict est **calculé**
depuis la qualité réelle du batch.

---

## Prérequis structurels

### 1. Le batch comme entité first-class

Aujourd'hui la production est une boucle continue ; les compteurs `bouteilles_ok/rebut` sont
cumulatifs et ne se réinitialisent jamais → « le dernier batch IPA » n'existe pas.

**À ajouter dans le cerveau** : un cycle de batch par ligne — `id`, `recette`, `started_at`,
phase courante, et à la clôture un **verdict** calculé depuis la qualité agrégée sur la fenêtre.

**Contrat de tags batch** (nommage `site.ligne.machine.mesure` habituel) :

```
brasserie.ipa.batch.id          # identifiant du batch en cours (ex. encodé numériquement)
brasserie.ipa.batch.phase       # 0=cip 1=empâtage 2=ébullition 3=fermentation 4=embouteillage 5=clôturé
brasserie.ipa.batch.qc_verdict  # 0=OK, sinon code défaut (voir table ci-dessous)
brasserie.ipa.batch.rebut_pct   # % rebut du batch en cours
```

> `batch.id` doit rester un nombre (le contrat `tags.raw` transporte des `value` numériques).
> Choix d'encodage à trancher à l'implémentation (ex. timestamp de début, ou compteur).

### 2. La table `batches` (côté gateway / Timescale)

Décision actée : **tags live ET table dédiée**. À la **clôture** d'un batch, la gateway (ou un
petit consommateur) écrit une ligne — c'est ce que lira `get_batch_context`.

```sql
CREATE TABLE batches (
  id           text PRIMARY KEY,      -- ex. "ipa-2026-0613-1"
  recipe       text NOT NULL,         -- "ipa", "blonde", "jalapeno"...
  line         text NOT NULL,         -- "brasserie.ipa"
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  status       text NOT NULL,         -- running | done
  qc_verdict   text,                  -- "ok" | "fermentation_hors_spec" | "rendement_faible" | ...
  defaut_type  text,                  -- null si ok
  rebut_pct    real,
  qc_notes     text
);
```

`get_batch_context(batch_ref)` (tool gateway, à venir) assemblera alors le **dossier** : la ligne
`batches` + les alarmes/consignes/déviations de la fenêtre `[started_at, ended_at]`, en
**déviations vs bande nominale** plutôt qu'en points bruts.

### 3. Codes de défaut (verdict)

| code `defaut_type`       | sens                                          | scénario |
|--------------------------|-----------------------------------------------|----------|
| `null` / `ok`            | batch conforme                                | —        |
| `fermentation_hors_spec` | fermentation trop chaude → atténuation/densité finale hors cible | S1 |
| `rendement_faible`       | empâtage trop chaud → conversion d'amidon incomplète, moût trouble | S2 |
| `contamination`          | sanitation insuffisante (CIP écourté)         | S3       |
| `volume_insuffisant`     | qualité OK mais objectif de volume manqué     | S4       |
| `derive_non_rattrapee`   | dérive lente détectée trop tard               | S5       |

### 4. Petits ajouts de modélisation

- **Axe sanitation** : variable `brasserie.<ligne>.cip_ok` (1 = nettoyage conforme avant batch).
  Indispensable pour S3 : il donne une cause **non-thermique**, donc *discriminante*.
- **Action « dérive progressive »** dans `scenario.py` : rampe `+δ °C/min` sur N minutes, au lieu
  du saut instantané actuel (`nudge_temp`). Pour S5.
- **Recettes enrichies** (optionnel, valeur : bandes nominales **non arbitraires**) : phases avec
  consigne + tolérance par phase, et une 3ᵉ recette de variété (ex. `jalapeno`). Les bandes
  nominales deviennent `consigne_recette ± tolérance`, exploitables par `get_batch_context`.

---

## Bibliothèque de scénarios

Chaque scénario doit être **nommé, déclenchable à la demande et reproductible** (remplace le
one-shot fixe actuel). Format : déclencheur → propagation → symptômes lisibles → verdict.

### S1 — Fermentation hors spec (excursion chaude fermenteur) · *RCA qualité process*
- **Déclencheur** : `temp_cible` fermenteur tenue, mais température réelle dérive de +6/+8 °C
  (régulation HS).
- **Propagation** : `fermenteur.temperature` hors bande → `fermenteur.defaut_thermique=1` →
  `fermenteur.qualite` chute → `qualite_ligne` baisse → `bouteilles_rebut` monte.
- **Symptômes** : temp hors bande, bit défaut, qualité ligne basse.
- **Verdict** : `fermentation_hors_spec`. *(cause déjà existante : `nudge_temp`)*

### S2 — Rendement faible (coup de chaud empâteur) · *RCA qualité, autre cuve*
- **Déclencheur** : empâteur +10 °C (au-delà de ~69 °C, enzymes dénaturées → conversion
  d'amidon incomplète).
- **Propagation** : `empateur.temperature` hors bande → défaut → qualité amont effondrée →
  embouteilleuse en `en_attente` (moût < `ready_threshold`) → production stagne.
- **Symptômes** : même signature que S1 mais sur une **cuve différente** → teste la
  localisation (*où* dans la ligne).
- **Verdict** : `rendement_faible`. *(cause existante)*

### S3 — Contamination (CIP écourté) · *RCA discriminante — cas vitrine*
- **Déclencheur** : `cip_ok=0` (nettoyage sauté/écourté) avant le batch.
- **Propagation** : la **température reste nominale** ; c'est la sanitation qui dégrade le batch
  en fin de fermentation.
- **Pourquoi précieux** : il **discrimine**. L'assistant doit conclure « temp normale → ce n'est
  pas thermique ; CIP sauté → contamination ». Sans 2ᵉ axe de cause, il n'a rien à trancher
  (c'est le pattern « écarter une hypothèse parce qu'une variable est nominale »).
- **Verdict** : `contamination`. *(demande la variable `cip_ok`)*

### S4 — Objectif de shift manqué (panne embouteilleuse) · *machine + projection*
- **Déclencheur** : `trip_bottler` (déjà là) pendant X minutes.
- **Propagation** : `embouteilleuse.panne=1`, `cadence=0`, état FAULT → arrêt comptabilisé →
  projection de fin de shift décroche.
- **Symptômes** : **aucune dégradation qualité** (les bouteilles produites sont bonnes) — pur
  problème de **débit / disponibilité**. Teste « vais-je atteindre mes 2500 pièces ? » et l'OEE.
- **Verdict** : `volume_insuffisant`. *(cause existante)*

### S5 — Dérive lente de capteur (détection tardive) · *réalisme « cause à effet, pas random »*
- **Déclencheur** : dérive **progressive** (+0,3 °C/min sur ~15 min) au lieu d'un saut.
- **Propagation** : la qualité se dégrade lentement ; `defaut_thermique` ne se lève que tard
  (seuil 2× tolérance) → le batch est déjà à moitié dégradé quand l'alarme sonne.
- **Pourquoi** : rend la timeline *intéressante* (« ça a commencé bien avant l'alarme ») et
  justifie des dérivés type *écart consigne/mesure cumulé* plutôt qu'un seuil binaire.
- **Verdict** : `derive_non_rattrapee`. *(demande l'action « rampe »)*

---

## Couverture (classes de RCA)

| Scénario | Classe testée                          | Cause existe ? |
|----------|----------------------------------------|----------------|
| S1       | RCA qualité process                    | ✅ |
| S2       | RCA qualité, localisation (autre cuve) | ✅ |
| S3       | RCA discriminante (axe non-thermique)  | ➕ `cip_ok` |
| S4       | machine / débit / projection de shift  | ✅ |
| S5       | réalisme temporel (dérive lente)       | ➕ action rampe |

## Récap des ajouts requis

| Brique | Effort | Sert à |
|---|---|---|
| Cycle de batch discret + fenêtre (cerveau) | moyen | tout (sinon pas de « dernier batch ») |
| Tags batch (`batch.id/phase/qc_verdict/rebut_pct`) | faible | exposer le batch en cours |
| Table `batches` + écriture à la clôture (gateway) | moyen | `get_batch_context` |
| Verdict QC + `defaut_type` calculés | faible | l'effet devient donnée |
| Variable `cip_ok` (axe sanitation) | faible | S3, discrimination |
| Action « dérive progressive » (scénario) | faible | S5, réalisme |
| Recettes enrichies (phases/bandes, ex. jalapeño) | moyen-bas | bandes nominales non-arbitraires |

## Ordre conseillé

1. **Cerveau** : batch discret + verdict/`defaut_type` + tags batch.
2. **Gateway** : table `batches` + écriture à la clôture.
3. **Scénarios** : rendre les scénarios déclenchables/reproductibles + S1/S2/S4 (causes existantes).
4. **Discrimination & réalisme** : `cip_ok` (S3) + action rampe (S5).
5. **Variété** : recettes enrichies (phases, jalapeño) — quand le reste tourne.

> Suite logique côté assistant (hors de ce doc) : `get_batch_context` → puis le workflow RCA
> routé. Le réglage fin du raisonnement attendra un GPU + un modèle plus gros ; toute la
> plomberie (et la vérité terrain ci-dessus) se construit et se teste dès maintenant.

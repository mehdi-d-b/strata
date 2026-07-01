# RisingWave dans Strata — ce que c'est, ce que ça remplace, ce que ça débloque

> ⚠️ **Statut (2026-07) : dernier recours, non construit par défaut.** La chaîne est câblée et
> validée (profil Docker optionnel `risingwave`), mais pour le cas d'usage qui l'avait motivé
> (dérive/self-baseline sur un tag) un continuous aggregate TimescaleDB + le mode bande de
> `alarm_rules` (cf. `docs/infra-architecture.md` §3) suffit, sans le coût d'un service streaming
> de plus. Ne réactiver ce profil que si un vrai besoin **sub-seconde** ou de très forte
> cardinalité de tags apparaît (cf. ADR 0001 : « stream processing stateful avancé, différé »).
> Le reste de ce document explique le raisonnement d'origine — il reste valable pour évaluer
> *quand* franchir ce seuil, pas comme guide d'activation par défaut.

> Document d'aide à la décision. Objectif : comprendre **précisément** ce que
> RisingWave apporterait à Strata, ce qu'il remplace (peu de choses), ce qu'il
> améliore, ce qu'il débloque (beaucoup), et où sont les pièges. Écrit pour
> trancher en connaissance de cause, pas pour vendre l'outil.

## TL;DR (si tu ne lis qu'un paragraphe)

RisingWave est une **base de données de streaming** (Postgres-compatible, en Rust,
sans JVM). Ce **n'est pas un broker** (il ne remplace pas Redpanda) ni un sink
d'historisation (il ne remplace pas TimescaleDB). Sa valeur dans Strata : exécuter
en **continu** des calculs SQL sur le flux `tags.raw` (agrégats fenêtrés, détection
d'anomalies, dérivés multi-tags) et **réémettre** les résultats — vers Redpanda
(d'autres tags), vers une table interrogeable, ou poussés en direct. Il **remplace
surtout du code de calcul qu'on a écrit à la main** (la détection d'alarmes dans la
gateway, les continuous aggregates Timescale) par du **SQL déclaratif tenu à jour en
temps réel**. Ce n'est **pas indispensable** ; c'est un **multiplicateur** quand la
logique temps réel devient riche (et un excellent fournisseur de contexte pour un
agent IA).

---

## 1. D'abord, dissiper les confusions

### « On aurait pu mettre RisingWave à la place de Redpanda »
**Non.** Ce sont deux rôles différents :
- **Redpanda** = le **transport** : un journal de messages (topics), durable, qui
  découple les producteurs des consommateurs. C'est le « tuyau » et le tampon.
- **RisingWave** = le **calcul** : il *consomme* des topics, calcule, et produit des
  résultats. Il a besoin d'une source de flux — typiquement... Redpanda.

RisingWave **se branche derrière Redpanda**, il ne le remplace pas. (Il peut lire
d'autres sources, mais dans Strata la source naturelle est `tags.raw`.)

### « Ça remplace TimescaleDB ? »
**Non, ils sont complémentaires.**
- **TimescaleDB** = l'**historien** : stockage long terme, requêtes sur le passé
  (`/api/history`), rétention/compression. Sa force = les **données au repos**.
- **RisingWave** = le **moteur temps réel** : il maintient des vues **toujours à
  jour** sur le flux, mais n'est pas fait pour archiver des années de brut.
  Sa force = les **données en mouvement**.

Le pattern sain = **les deux** : RisingWave calcule en continu, et on **sink** ce
qui doit être gardé dans Timescale.

### « Ça remplace le WebSocket ? »
**Non.** Le WS reste le canal gateway→navigateur (on vient de le sécuriser).
RisingWave produit *quoi* envoyer ; le WS reste le *comment* l'envoyer au front.

---

## 2. L'architecture Strata aujourd'hui (rappel)

```
sources ─→ Redpanda (tags.raw) ─┬─→ Redpanda Connect ─→ TimescaleDB   (historisation)
                                ├─→ gateway: consumer ─→ WebSocket     (temps réel UI)
                                └─→ gateway: AlarmEngine               (détection seuils, en TS)

agrégats prod/shift  = continuous aggregates TimescaleDB (recalcul incrémental en base)
```

Aujourd'hui, **le calcul temps réel vit à deux endroits écrits à la main** :
1. la **détection d'alarmes** dans la gateway (`gateway/src/alarms.ts`, en TypeScript),
2. les **agrégats métier** dans TimescaleDB (continuous aggregates, en SQL).

Ça marche très bien à l'échelle actuelle. RisingWave entre en jeu quand cette
logique devient **plus riche** (multi-tags, fenêtres, anomalies) ou **plus
volumineuse** (beaucoup de tags/règles).

## 3. Où RisingWave se brancherait

```
Redpanda (tags.raw) ─→ RisingWave ─┬─→ topics Redpanda (tags dérivés, alarmes, agrégats)
                                   │      └─→ gateway les rediffuse (WS) / Connect les sink (Timescale)
                                   └─→ tables matérialisées interrogeables en SQL (wire Postgres)
                                          └─→ la gateway peut les lire comme Timescale
```

Deux modes de sortie, tous deux utiles :
- **Sink → Redpanda** : un résultat redevient un **tag** (`source: derived` /
  `source: risingwave`). Il est alors absorbé par tout l'aval existant **sans rien
  changer** (contrat `tags.raw`), affiché à côté du réel, historisé, etc.
- **Materialized view interrogeable** : la gateway requête RisingWave en SQL
  (port Postgres) pour des vues toujours fraîches (ex. « état courant agrégé »).

---

## 4. Ce que RisingWave REMPLACE (peu, mais propre)

| Aujourd'hui | Avec RisingWave | Gain |
|---|---|---|
| Détection d'alarmes en TS dans la gateway (`alarms.ts`) | Vues SQL de détection dans RisingWave | logique déclarative, multi-tags, fenêtrée ; scale au-delà de la mémoire d'un process Node |
| Continuous aggregates Timescale (prod/shift) | Vues matérialisées RisingWave (option) | latence plus basse (sub-seconde vs intervalle de refresh) ; *mais Timescale fait déjà très bien le job batch* |
| Calculs ad hoc futurs (OEE live, dérivés) | SQL dans RisingWave | pas de nouveau code applicatif à maintenir |

⚠️ **Important** : le modèle d'alarmes a été **conçu pour ça**. La table `alarms`
est indépendante du détecteur (`source: rule | tag`). Basculer la détection de la
gateway vers RisingWave = **ajouter une `source`**, l'UI ne bouge pas. C'est une
**évolution, pas une réécriture**.

Ce qu'il **ne remplace pas** : Redpanda (transport), TimescaleDB (historien long
terme), la gateway (auth/RBAC/API/WS), Redpanda Connect (connecteurs/sinks simples).

---

## 5. Ce que RisingWave AMÉLIORE

- **Latence du calcul** : sub-seconde et incrémental (il ne recalcule que ce qui
  change), là où les continuous aggregates Timescale rafraîchissent par intervalle.
- **Expressivité** : du vrai SQL streaming — JOINs entre flux, **fenêtres**
  (TUMBLE/HOP/SESSION), agrégations temporelles, `EMIT ON WINDOW CLOSE`. Faire ça à
  la main en TS serait pénible et fragile.
- **Scalabilité de la logique** : 500 règles d'alarme multi-tags, ce n'est plus un
  `for` dans un process Node, c'est un plan de requête optimisé et tenu à l'état.
- **Découplage** : la logique métier temps réel sort du code applicatif et devient
  des vues versionnables, modifiables sans redéployer la gateway.

## 6. Ce que RisingWave DÉBLOQUE (le vrai intérêt)

C'est ici que ça devient intéressant — des features **difficiles à faire
proprement sans lui** :

1. **Détection d'anomalies temps réel** : z-score glissant, écart à une moyenne
   mobile, détection de plateau/dérive, taux de variation anormal. En SQL fenêtré,
   maintenu en continu. (Aujourd'hui on ne sait faire que des seuils fixes.)
2. **Alarmes dérivées multi-tags** : « température haute **ET** débit bas pendant
   30 s », « écart entre deux capteurs redondants > seuil ». Impossible avec le
   modèle seuil-mono-tag actuel.
3. **OEE / KPIs live** (disponibilité × performance × qualité) recalculés en continu
   plutôt qu'à l'ouverture de page. ⚠️ **L'OEE *batch* est déjà fait** (continuous
   aggregates Timescale + objectifs/projection + Pareto des motifs + reclassement
   opérateur — cf. [oee-design.md](oee-design.md)). RisingWave apporte le **live**
   (fenêtre glissante sub-seconde) pour la **réactivité atelier** : andon, **alerte OEE
   sous seuil** (réutilise le modèle d'alarmes `source='derived'`), capter les micro-arrêts.
   ⚠️ *Ne vaut que si quelqu'un AGIT sur le chiffre temps réel* (opérateur/alerte) ; sinon
   le batch suffit. C'est le **cas d'usage RisingWave #2 à regarder** (après les anomalies),
   noté dans la roadmap (Phase 9, OEE live). « À regarder plus tard. »
4. **Agrégats multi-échelle** instantanés (par minute / shift / jour) sans batch.
5. **Tags dérivés** réémis dans le flux : moyennes lissées, consommations cumulées,
   rendement, prédiction simple — tous deviennent des tags normaux, affichables.
6. **Contexte riche pour un agent IA** (voir section dédiée).

## 7. RisingWave & l'agent IA — pourquoi c'est synergique

Ton intuition est juste : **plus la donnée temps réel est pré-calculée et
sémantique, mieux un agent IA s'en sert.** Un LLM est mauvais pour fouiller des
millions de points bruts ; il est bon pour raisonner sur des **faits agrégés et
nommés**.

- RisingWave est **Postgres-wire** → un agent (via MCP/outils) peut lui poser des
  questions SQL sur l'**état courant** sans scanner l'historique brut.
- Les vues matérialisées sont des **faits prêts à consommer** : « OEE actuel ligne
  IPA », « anomalies actives », « tendance température 10 min ». C'est exactement le
  genre de contexte compact qu'un agent exploite bien.
- **MAIS attention à la règle d'or déjà actée** : l'agent doit passer par l'**API
  gateway** (RBAC + audit), pas taper RisingWave en direct — sauf à exposer
  RisingWave *via* la gateway (une route qui lit ses vues, sous auth). À cadrer le
  moment venu.

➡️ Donc oui : **faire transiter le calcul temps réel par RisingWave nourrit
mieux l'IA**, mais via la gateway, pas en court-circuit.

## 8. Ce que ça coûte (honnête)

- **Un composant de plus** : un service RisingWave dans le compose (Rust, sans JVM,
  cohérent avec la stack). Conso mémoire non négligeable (il tient de l'état).
- **Une dépendance d'état** : les vues matérialisées vivent dans RisingWave ; il faut
  penser persistance/redémarrage (il a son propre stockage d'état).
- **De la complexité conceptuelle** : 3 endroits où de la logique peut vivre
  (gateway / Timescale / RisingWave). Risque de dispersion si on ne tranche pas
  *qui fait quoi*. Règle proposée :
  - **Timescale** = historien + agrégats métier batch éprouvés (prod/shift).
  - **RisingWave** = temps réel riche (anomalies, dérivés, multi-tags, fenêtres).
  - **gateway** = auth/RBAC/API/WS + détection *simple* tant que RisingWave n'est pas là.
- **Pas un besoin tant que** la logique reste « seuils simples + agrégats shift ».
  Today's Strata n'en a pas besoin. C'est un investissement pour la **montée en
  richesse**.

## 9. Recommandation de séquençage

RisingWave n'est rentable que s'il a une **première mission claire**. Ne pas
l'installer « pour voir ». Bon ordre d'adoption :

1. **Déclencheur** = le jour où on veut des **anomalies** ou des **alarmes
   multi-tags** (que la gateway ne sait pas faire proprement). C'est *là* qu'on
   l'installe, avec ce cas d'usage précis.
2. **Première brique** : une vue d'anomalie simple (z-score glissant sur un tag) →
   réémise comme alarme `source: derived` dans le modèle `alarms` existant. Prouve
   la valeur sans rien casser.
3. **Ensuite** : OEE live, tags dérivés, agrégats multi-échelle, selon le besoin.
4. **Migration de la détection de seuils** gateway → RisingWave : seulement si le
   volume de règles le justifie. Sinon, laisser la gateway (ça marche).

## 10. Verdict

| Question | Réponse |
|---|---|
| Ça remplace Redpanda ? | ❌ Non (broker ≠ moteur de calcul) |
| Ça remplace TimescaleDB ? | ❌ Non (complémentaire : mouvement vs repos) |
| Ça remplace le WebSocket ? | ❌ Non (produit le quoi, pas le comment) |
| Ça remplace du code maison ? | ✅ Oui : détection d'alarmes, calculs temps réel |
| C'est indispensable maintenant ? | ❌ Non — la stack actuelle suffit |
| Ça débloque quoi ? | ✅ Anomalies, alarmes multi-tags/fenêtrées, OEE live, dérivés, contexte IA |
| Quand l'installer ? | Au **premier vrai besoin** d'anomalie/alarme avancée, pas avant |

**En une phrase** : RisingWave ne *remplace* presque rien d'essentiel — il
**transforme la logique temps réel de « code qu'on maintient » en « SQL déclaratif
tenu à jour »**, et débloque l'analytique avancée (anomalies, OEE live) et un
meilleur contexte pour l'IA. À adopter **quand un cas d'usage riche le réclame**,
branché derrière Redpanda, à côté de Timescale — jamais à leur place.
```

# Strata — Architecture (topo global, pour reprendre le projet de zéro)

> **But de ce document** : mettre à niveau quelqu'un (humain ou LLM) qui n'a **aucun
> contexte** sur Strata. Il couvre tout sauf le détail du front (`web/`, géré par des
> chats dédiés). À lire en premier. Compléments : `CLAUDE.md` (résumé + règles),
> `docs/roadmap.md` (état des phases), `docs/adr/0001-choix-stack.md` (pourquoi ces choix).

## 0. C'est quoi Strata, en 30 secondes

Strata est une **plateforme de streaming de données industrielles** (« couteau suisse
Industrie 4.0 »). Elle :
1. **récupère** des mesures d'équipements industriels (MQTT, et automates S7/Modbus/EtherNet-IP
   via PLC4X) ;
2. les **normalise** vers un contrat unique, les **historise** (TimescaleDB) et les **diffuse
   en temps réel** (WebSocket) ;
3. offre une **UI web** (React) : exploration de courbes, dashboards, production par shift,
   alarmes, administration, écriture de consignes vers les automates ;
4. le tout **sans JVM** (sauf le module PLC4X optionnel), packagé en **Docker Compose**.

Principe fondateur : **southbound pluggable**. Toute source écrit dans un topic Redpanda
**normalisé** (`tags.raw`). Le reste du système ne connaît QUE ce contrat, jamais les
protocoles d'origine. Ajouter une source/un protocole n'impacte pas l'aval.

## 1. Vue d'ensemble des flux

```
SOURCES                      TRANSPORT            CALCUL / SERVING                STOCKAGE / UI

simulateur (Python) ─MQTT─┐                  ┌─ Redpanda Connect ──────────────→ TimescaleDB
                          ├─→ Redpanda ───────┤   (mqtt-to-raw, plc4x-to-raw,        (mesures = hypertable
PLC4X (profil plc4x) ─────┘   topic           │    raw-to-timescale)                  + continuous aggregates)
  (S7/Modbus/EIP)             tags.raw  ──────┤
                                              ├─ gateway (Node/TS, Fastify) ─────→ navigateur (React)
                                              │    • consumer tags.raw → WS (filtré RBAC)
                                              │    • REST (auth, tags, prod, devices,
                                              │      alarmes, stockage, commandes…)
                                              │    • AlarmEngine (seuils, en mémoire)
                                              │    • consumer tags.derived → alarms
                                              │
                                              └─ RisingWave (profil risingwave) ──→ topic tags.derived
                                                   tags.raw → MV stats/anomalies        (anomalies réémises)

écriture : UI → POST /api/command → topic tags.cmd → simulateur (face cmd) / PLC4X sink
```

**Le contrat central** : topic Redpanda **`tags.raw`**, JSON
`{ tag, value, ts, quality, source }`.
- `tag` = nom **métier** `site.ligne.machine.mesure`, indépendant du protocole
  (ex. `brasserie.ipa.fermenteur.temperature`).
- `source` = origine (`sim-mqtt`, `plc4x`, `derived`…), **jamais** dans le nom du tag.
- Produit **au bord** (par la source / son normaliseur) ; l'aval ne fait que transporter.

Autres topics : **`tags.cmd`** (consignes d'écriture), **`tags.derived`** (sorties RisingWave),
`plc.raw` (sortie brute PLC4X avant normalisation), `_connect-*` (internes Kafka Connect).

## 2. Cycle de vie d'une donnée (de bout en bout)

**Lecture (mesure → écran)** :
1. Une source publie (simulateur en MQTT, ou un automate lu par PLC4X).
2. Un pipeline **Redpanda Connect** normalise vers `tags.raw` (nom métier, JSON du contrat).
3. Trois consommateurs indépendants de `tags.raw` :
   - `raw-to-timescale` → **insère le brut** dans l'hypertable `mesures` ;
   - **gateway** → applique `scale/offset`, pousse en **WebSocket** aux clients autorisés ;
   - **gateway AlarmEngine** → évalue les **seuils** d'alarme.
4. L'UI affiche le temps réel (WS) et l'historique (`GET /api/history`, lu depuis `mesures`).

**Écriture (consigne → équipement)** :
1. UI → `POST /api/command {tag,value}` → gateway vérifie le droit `write` (RBAC) + audite.
2. La gateway publie sur **`tags.cmd`**.
3. Le simulateur (face commande) **ou** un sink PLC4X applique la consigne → l'effet revient
   dans `tags.raw` au tour suivant (boucle fermée, visible à l'écran).

## 3. Qui calcule quoi (3 moteurs, 3 terrains — ne pas dupliquer)

| Calcul | Où | Quand l'utiliser |
|---|---|---|
| Agrégats métier **prod/shift** | **TimescaleDB** continuous aggregates (`prod_buckets` + vues, `03-production.sql`) | données **au repos**, historique, recalcul incrémental |
| **Down-sampling** d'une grande plage d'historique | **gateway** `/api/history` (`time_bucket` à la volée, plafond `maxPoints`) | éviter d'écrouler le navigateur sur une longue plage |
| **Alarmes par seuils** (Type A/B) | **gateway** `AlarmEngine` (`gateway/src/alarms.ts`, en mémoire) | seuils simples sur le flux, faible volume de règles |
| **Anomalies temps réel** (z-score/dispersion, fenêtres) | **RisingWave** (profil optionnel) | données **en mouvement**, calcul riche/fenêtré |

Règle : **Timescale = repos, RisingWave = mouvement, gateway = orchestration + calcul simple.**

## 4. Arborescence du repo

```
strata/
├── docker-compose.yml      # TOUS les services + profils (plc4x, risingwave)
├── Makefile                # up / down / logs / ps / clean
├── .env.example            # secrets (copier en .env, gitignored)
├── CLAUDE.md               # résumé projet + règles (gitignored !)
├── README.md               # démarrage rapide
├── infra/
│   ├── timescale/init/     # *.sql d'init (exécutés au 1er boot, dans l'ordre)
│   ├── mosquitto/          # config broker MQTT
│   └── kafka-connect/      # Dockerfile image PLC4X (profil plc4x)
├── connectors/             # pipelines Redpanda Connect (YAML) + templates PLC4X (JSON)
│   └── plc4x/              # configs connecteurs PLC4X (00-simulated, 10-siemens…)
├── gateway/                # API REST + WebSocket (Node/TS, Fastify)  ← le cœur applicatif
│   └── src/                # index.ts (routes+consumers), auth.ts, alarms.ts, plc4x.ts
├── simulator/              # simulateur d'usine (micro-brasserie, Python)
│   └── factory/            # brain.py (cerveau), scenario.py, faces/ (mqtt, command)
├── risingwave/             # SQL setup RisingWave (profil risingwave) + README
├── web/                    # frontend React+Vite+TS (HORS périmètre infra)
└── docs/
    ├── infra-architecture.md  # CE document
    ├── roadmap.md             # phases & état
    ├── risingwave-integration.md  # rôle/justification de RisingWave
    ├── adr/                   # décisions d'archi (0001 = choix de stack)
    └── passation/             # notes front→infra archivées (toutes traitées)
```

## 5. Services & profils Docker

Stack **par défaut** (`make up`) — sans JVM :

| Service | Rôle | Port (hôte) |
|---|---|---|
| `redpanda` | broker de streaming (compatible Kafka) | 19092 (Kafka), 9644 |
| `console` | UI admin Redpanda | 8080 |
| `timescaledb` | base time-series (historisation + agrégats) | 5432 |
| `mosquitto` | broker MQTT (entrée du simulateur) | 1883 |
| `simulator` | usine simulée (brasserie) | — |
| `connect-mqtt-to-raw` | MQTT → `tags.raw` | — |
| `connect-raw-to-timescale` | `tags.raw` → `mesures` | — |
| `gateway` | API REST + WebSocket | 3001 |
| `topic-init` | crée les topics au démarrage puis s'arrête | — |

Profils **optionnels** (n'altèrent pas le défaut) :
- **`--profile plc4x`** : `kafka-connect` (image custom + connecteur PLC4X, **seul container
  JVM**, port 8083) + `connect-plc4x-to-raw`. Branche de vrais automates (ou `simulated://`).
- **`--profile risingwave`** : `risingwave` (single_node, port SQL 4566). Anomalies temps réel.

Commandes : `make up|down|logs|ps|clean`. Avec profils :
`docker compose --profile plc4x --profile risingwave up -d`.

## 6. Modèle de données (TimescaleDB) — `infra/timescale/init/`

Les `NN-*.sql` s'exécutent **dans l'ordre, au 1er boot seulement** (création du volume). **Une
table ajoutée après coup** doit être appliquée à la main sur la base existante (pattern récurrent
du projet ; voir le README du sujet concerné) — ou `make clean` pour repartir neuf (perd tout).

| Fichier | Contenu |
|---|---|
| `01-init.sql` | extension timescaledb + hypertable `mesures` (le brut historisé) |
| `02-tags.sql` | `tags` (config : label, unité, **scale/offset**, enabled…) |
| `03-production.sql` | shifts **versionnés** (`shift_schedule.valid_from`), `tag_role`, continuous aggregate `prod_buckets`, vues `prod_by_shift*` |
| `04-auth.sql` | `users` (scrypt), `sessions`, `roles`, `user_roles`, `grants` (RBAC), `audit_log` |
| `05-devices.sql` | `devices` (automates) + colonnes `device/address/datatype` sur `tags` |
| `06-retention.sql` | compression (chunks +7j) + rétention (brut 365j) sur `mesures` |
| `07-dashboards.sql` | `dashboards` (privés par user, `spec` jsonb opaque) |
| `08-alarms.sql` | `alarm_rules` (seuils) + `alarms` (journal, `source: rule\|tag\|derived`) |

**Scaling** : `mesures` stocke la valeur **brute** ; `scale/offset` sont appliqués **à la
lecture** (gateway) → corriger une échelle répare tout l'historique. WS et `/api/history`
renvoient des valeurs **scalées** (cohérence direct/historique).

## 7. La gateway — le cœur applicatif (`gateway/src/`)

Node/TypeScript, Fastify, lancé via `tsx`. Voir [gateway/README.md](../gateway/README.md) pour
le détail des routes.
- `index.ts` : toutes les routes REST + 2 consumers Redpanda (`tags.raw`→WS filtré,
  `tags.derived`→alarms) + démarrage (`seedAdmin`, `seedDemoAlarms`, AlarmEngine).
- `auth.ts` : sessions (cookie httpOnly révocable, hash **scrypt**), `requireAuth`/`requireAdmin`,
  **`can(user, action, tag)`** = cœur du RBAC.
- `alarms.ts` : `AlarmEngine` (anti-rebond `for_ms`, hystérésis, 1 active/règle, hydrate au boot).
- `plc4x.ts` : génère les connecteurs PLC4X **depuis la base** + déploie via l'API Kafka Connect.

**RBAC** : un droit = `(rôle, scope = préfixe de tag, action read|write|admin)`. Match par
**préfixe** (`brasserie.blonde` couvre `brasserie.blonde.*`). Appliqué aux routes REST **et** au
WS (filtrage par socket). Un futur agent IA = **un utilisateur de plus** passant par l'API
(jamais d'accès direct à la base → on garde auth/RBAC/audit).

## 8. Conventions & pièges récurrents (vécus dans ce projet)

- **Nommage tags** : `site.ligne.machine.mesure`, jamais le protocole dans le nom.
- **KafkaJS ne décode pas Snappy** → producteurs vers `tags.raw` en `compression: none`.
- **Init SQL** ne tourne qu'à la création du volume → appliquer les nouvelles tables à la main.
- **WSL + Docker** : pulls de grosses images coupent (`EOF` CDN) → relancer en boucle ; parfois
  `max-concurrent-downloads: 1` (Docker Desktop) aide. RisingWave/Timescale = grosses images.
- **Tests** : la plupart des features se valident en `curl` sur :3001 + `psql` dans le container
  `timescaledb`. L'image **RisingWave n'a pas psql** → emprunter celui de timescaledb
  (`psql -h risingwave -p 4566 -d dev -U root`).
- **Kafka Connect** exige ses topics internes en `cleanup.policy=compact` (fait par `topic-init`).
- **Secrets** via `.env` (gitignored). **`CLAUDE.md` est volontairement gitignored.**

## 9. Comment ajouter une feature (recette éprouvée)

1. **Nouvelle source de données** → écrire dans `tags.raw` (pipeline Redpanda Connect ou service
   produisant le contrat). Rien d'autre à toucher en aval.
2. **Nouvelle table** → fichier `infra/timescale/init/NN-*.sql` **+** l'appliquer à la main sur
   la base en cours.
3. **Nouvelle route** → `gateway/src/index.ts`, protéger avec `requireAuth`/`requireAdmin` et,
   pour l'accès aux tags, `can(user, action, tag)`. Logger les mutations via `audit()`.
4. **Calcul temps réel riche** → MV RisingWave → sink topic → consumer gateway. Ne pas refaire
   en TS ce que le SQL streaming fait mieux.
5. **Toujours** : tester end-to-end (curl + psql), committer par petits incréments, mettre à jour
   `docs/roadmap.md`.

## 10. État au 2026-06-08 (branches)

- `main` : phases 0→8.5 + refonte web + alarmes + dettes (rétention/secrets/WS sécurisé) — mergé.
- `feat/risingwave` (**pas mergé**) : anomalies temps réel (RisingWave profil optionnel, chaîne
  validée `tags.raw→MV→tags.derived→alarms source=derived`). Voir `risingwave/README.md`.

Reste ouvert (roadmap P4/P6/P9) : OPC-UA, faces protocolaires du simulateur (Modbus/S7/EIP
serveurs), OEE complet, TimesFM (prévision), assistant IA (MCP). Tous **pluggables sans refonte**
grâce aux contrats stables.

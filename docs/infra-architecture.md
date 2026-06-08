# Strata — Architecture infra (référence pour les prochains chats)

> Document de référence **infra/gateway/données**. But : qu'un nouveau chat
> comprenne en une lecture *où vit quoi*, *qui calcule quoi*, et *comment ajouter
> une feature sans casser les contrats*. Complète `CLAUDE.md` (vue d'ensemble) et
> `docs/roadmap.md` (état des phases). Pour le front, voir `web/` (chats dédiés).

## 1. Vue d'ensemble des flux

```
SOURCES                      TRANSPORT            CALCUL / SERVING                STOCKAGE / UI
                                                                                
simulateur (Python) ─MQTT─┐                  ┌─ Redpanda Connect ──────────────→ TimescaleDB
                          ├─→ Redpanda ───────┤   (mqtt-to-raw, plc4x-to-raw,        (mesures = hypertable,
PLC4X (profil plc4x) ─────┘   topic           │    raw-to-timescale)                  + continuous aggregates)
  (S7/Modbus/EIP)             tags.raw  ──────┤                                   
                                              ├─ gateway (Node/TS, Fastify) ─────→ navigateur
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
`{ tag, value, ts, quality, source }`. Tag = nom **métier** `site.ligne.machine.mesure`,
indépendant du protocole ; `source` = origine (`sim-mqtt`, `plc4x`, `derived`…).
**Tout l'aval ne connaît que ce contrat.** Ajouter une source = écrire dans `tags.raw`.

## 2. Qui calcule quoi (important — 3 moteurs, 3 terrains)

| Calcul | Où | Quand l'utiliser |
|---|---|---|
| Agrégats métier **prod/shift** | **TimescaleDB** continuous aggregates (`prod_buckets` + vues, `03-production.sql`) | données **au repos**, historique, recalcul incrémental |
| **Down-sampling** d'une grande plage d'historique | **gateway** `/api/history` (time_bucket à la volée, plafond `maxPoints`) | affichage : éviter d'écrouler le navigateur |
| **Alarmes par seuils** (Type A/B) | **gateway** `AlarmEngine` (`gateway/src/alarms.ts`, en mémoire) | seuils simples sur le flux, faible volume de règles |
| **Anomalies temps réel** (z-score/dispersion, fenêtres) | **RisingWave** (profil optionnel) | données **en mouvement**, calcul riche/fenêtré |

Règle : **Timescale = repos, RisingWave = mouvement, gateway = orchestration + calcul simple.**
Ne pas dupliquer un calcul entre deux moteurs.

## 3. Composants & profils Docker

Stack **par défaut** (`make up` / `docker compose up`) — sans JVM :
- **redpanda** (broker, :19092 ext / :9092 interne) + **console** (:8080)
- **timescaledb** (:5432) — init SQL idempotent dans `infra/timescale/init/*.sql`
- **mosquitto** (MQTT, :1883) + **simulateur** (brasserie Python)
- **connect-mqtt-to-raw**, **connect-raw-to-timescale** (Redpanda Connect, Go)
- **gateway** (:3001) — API REST + WS
- **topic-init** : crée `tags.raw`, `tags.cmd`, `tags.derived`, et les topics internes
  `_connect-*` en `cleanup.policy=compact` (sinon Kafka Connect refuse de démarrer)

Profils **optionnels** (n'altèrent pas le défaut) :
- `--profile plc4x` : **kafka-connect** (image custom + connecteur PLC4X, **seul container
  JVM**, :8083) + **connect-plc4x-to-raw**. Sources industrielles réelles ou `simulated://`.
- `--profile risingwave` : **risingwave** (single_node, :4566). Anomalies temps réel.

## 4. Modèle de données (TimescaleDB) — `infra/timescale/init/`

Les fichiers `NN-*.sql` s'exécutent **dans l'ordre, au 1er boot seulement** (création du
volume). **Pour une table ajoutée après coup**, l'appliquer aussi à la main sur la base
existante (pattern utilisé tout au long du projet ; voir README de chaque sujet).

| Fichier | Contenu |
|---|---|
| `01-init.sql` | extension timescaledb + hypertable `mesures` (le brut historisé) |
| `02-tags.sql` | `tags` (config : label, unité, **scale/offset**, enabled…) |
| `03-production.sql` | shifts **versionnés** (`shift_schedule.valid_from`), `tag_role`, continuous aggregate `prod_buckets`, vues `prod_by_shift*` |
| `04-auth.sql` | `users` (scrypt), `sessions`, `roles`, `user_roles`, `grants` (RBAC par préfixe), `audit_log` |
| `05-devices.sql` | `devices` (automates) + colonnes `device/address/datatype` sur `tags` |
| `06-retention.sql` | compression (chunks +7j) + rétention (brut 365j) sur `mesures` |
| `07-dashboards.sql` | `dashboards` (privés par user, `spec` jsonb opaque) |
| `08-alarms.sql` | `alarm_rules` (seuils) + `alarms` (journal, `source: rule\|tag\|derived`) |

**Scaling** : la valeur stockée dans `mesures` est **brute** ; `scale/offset` sont appliqués
**à la lecture** (gateway) — corriger une échelle répare tout l'historique. Le WS et
`/api/history` renvoient donc des valeurs **scalées** (cohérence direct/historique).

## 5. La gateway (`gateway/src/`)

- `index.ts` : toutes les routes REST + les 2 consumers Redpanda (`tags.raw` → WS filtré ;
  `tags.derived` → alarms) + démarrage (`seedAdmin`, `seedDemoAlarms`, AlarmEngine).
- `auth.ts` : sessions (cookie httpOnly révocable, scrypt), `requireAuth`/`requireAdmin`,
  **`can(user, action, tag)`** = cœur du RBAC (match par **préfixe** de tag).
- `alarms.ts` : `AlarmEngine` (anti-rebond `for_ms`, hystérésis, 1 active/règle, hydrate au boot).
- `plc4x.ts` : génération des connecteurs PLC4X **depuis la base** + déploiement via l'API
  Kafka Connect (Strata = source de vérité de la config d'acquisition).

**RBAC** : un droit = `(rôle, scope = préfixe de tag, action read|write|admin)`. Appliqué aux
routes REST **et** au WS (filtrage par socket). Un agent IA futur = **un utilisateur de plus**
qui passe par l'API (jamais d'accès direct à la base → on garde auth/RBAC/audit).

## 6. Conventions & pièges récurrents (vécus dans ce projet)

- **Nommage tags** : `site.ligne.machine.mesure`, jamais le protocole dans le nom. Produit
  *au bord* (source/normaliseur) ; l'aval transporte. `source` = métadonnée.
- **KafkaJS ne décode pas Snappy** → les producteurs vers `tags.raw` sont en `compression: none`.
- **Init SQL** ne tourne qu'à la création du volume → appliquer les nouvelles tables à la main
  sur une base existante (ou `make clean` pour repartir neuf — perd les données).
- **WSL + Docker** : pulls de grosses images coupent (`EOF` CDN) → relancer en boucle ;
  parfois `max-concurrent-downloads: 1` dans Docker Desktop aide.
- **Test bout-en-bout** : la plupart des features se valident en `curl` sur :3001 + `psql`
  dans le container timescaledb. L'image RisingWave **n'a pas psql** → emprunter celui de
  timescaledb (`psql -h risingwave -p 4566 -d dev -U root`).
- **Secrets** via `.env` (gitignored) ; `CLAUDE.md` est **volontairement gitignored**.

## 7. Comment ajouter une feature (recette éprouvée)

1. **Nouvelle source de données** → écrire dans `tags.raw` (un pipeline Redpanda Connect ou
   un service qui produit le contrat). Rien d'autre à toucher.
2. **Nouvelle table** → fichier `infra/timescale/init/NN-*.sql` **+** l'appliquer à la main sur
   la base en cours.
3. **Nouvelle route** → `gateway/src/index.ts`, protéger avec `requireAuth`/`requireAdmin` et,
   pour l'accès aux tags, `can(user, action, tag)`. Logger les mutations via `audit()`.
4. **Calcul temps réel riche** → MV RisingWave → sink vers un topic → consumer gateway. Ne pas
   refaire en TS ce que le SQL streaming fait mieux.
5. **Toujours** : tester end-to-end (curl + psql), committer par petits incréments, mettre à
   jour `docs/roadmap.md`.

## 8. État au 2026-06-08 (branches)

- `main` : phases 0→8.5 + refonte web + alarmes + dettes (rétention/secrets/WS) — tout mergé.
- `feat/risingwave` (**pas mergé**) : anomalies temps réel (RisingWave en profil optionnel,
  chaîne validée tags.raw→MV→tags.derived→alarms `source=derived`). Voir `risingwave/README.md`.

Reste ouvert (roadmap P4/P6/P9) : OPC-UA, faces protocolaires du simulateur (Modbus/S7/EIP
serveurs), OEE complet, TimesFM (prévision), assistant IA (MCP). Tous **pluggables sans
refonte** grâce aux contrats stables.

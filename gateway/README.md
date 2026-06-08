# gateway/

Cœur applicatif de Strata : **API REST + WebSocket** (Node/TypeScript, Fastify, lancé via
`tsx`). C'est le seul composant que le frontend appelle. Il consomme Redpanda, lit/écrit
TimescaleDB, applique l'authentification et le RBAC, détecte les alarmes, et génère les
connecteurs PLC4X.

## Rôles

- **Temps réel** : consume `tags.raw` → pousse aux navigateurs en **WebSocket** (`/ws`),
  après application du scaling et **filtrage par droits** (un client ne reçoit que les tags
  qu'il peut lire).
- **REST** : historique, config des tags, production/shifts, devices, alarmes, stockage,
  utilisateurs/rôles, écriture de consignes.
- **Auth & RBAC** : sessions cookie httpOnly (hash scrypt), droits par **préfixe de tag**.
- **Alarmes** : `AlarmEngine` (seuils sur le flux) + consumer `tags.derived` (anomalies
  RisingWave) → table `alarms`.
- **PLC4X** : génère les connecteurs depuis la base et les déploie via l'API Kafka Connect.

## Structure (`src/`)

| Fichier | Contenu |
|---|---|
| `index.ts` | toutes les routes REST + les 2 consumers Redpanda + démarrage (`seedAdmin`, `seedDemoAlarms`, AlarmEngine) |
| `auth.ts` | sessions, `requireAuth`/`requireAdmin`, `can(user, action, tag)` (RBAC), hash scrypt |
| `alarms.ts` | `AlarmEngine` : détection de seuils (anti-rebond `for_ms`, hystérésis, 1 alarme active/règle, hydrate au boot) |
| `plc4x.ts` | génération + déploiement des connecteurs PLC4X depuis la table `devices` |

## Endpoints REST

Auth :
- `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` · `POST /api/auth/password` (changer le sien)

Données / temps réel :
- `GET /api/tags` · `POST /api/tags` · `DELETE /api/tags/:name`
- `GET /api/history?tag=&minutes=` **ou** `?tag=&from=&to=&maxPoints=` (down-sampling auto)
- `WS /ws` (flux temps réel, filtré RBAC)

Production (Phase 3) :
- `GET /api/production` · `GET/POST /api/shifts` · `DELETE /api/shifts/:validFrom/:shiftNo`
- `GET /api/tag-roles` · `POST /api/tag-roles`

Automates & adresses (admin) :
- `GET/POST /api/devices` · `DELETE /api/devices/:name` · `GET /api/devices/:name/tags`
- `POST /api/tags/:name/address` · `POST /api/devices/:name/import` (CSV)
- `POST /api/devices/:name/deploy` · `POST /api/devices/:name/undeploy`

Écriture de consigne :
- `POST /api/command {tag,value}` (droit `write` requis + audit) → topic `tags.cmd`

Alarmes :
- `GET/POST /api/alarm-rules` · `PUT/DELETE /api/alarm-rules/:id` (admin)
- `GET /api/alarms` · `POST /api/alarms/:id/ack` · `GET /api/alarms/history`

Administration (admin) :
- `GET/POST /api/users` · `PUT /api/users/:id/roles|password|enabled`
- `GET /api/roles` · `PUT /api/roles/:name/grants` · `GET /api/audit`

Paramètres (admin) :
- `GET /api/storage` · `POST /api/storage/retention` · `POST /api/storage/compression`
- `GET /api/system`

Santé : `GET /health`

## RBAC en bref

Un droit = `(rôle, scope = préfixe de tag, action read|write|admin)`. Le match est par
**préfixe** : un grant `write` sur `brasserie.blonde` autorise tous les
`brasserie.blonde.*`. `*` = tout. `admin` = accès complet + gestion. Appliqué **aux routes
REST et au WebSocket**.

## Variables d'environnement

| Var | Défaut | Rôle |
|---|---|---|
| `KAFKA_BROKERS` | `redpanda:9092` | brokers Redpanda |
| `PG_DSN` | `postgres://strata:strata@timescaledb:5432/strata` | connexion TimescaleDB |
| `PORT` | `3001` | port HTTP/WS |
| `ADMIN_PASSWORD` | `admin` | mot de passe du compte admin seedé au 1er boot |
| `KAFKA_CONNECT_URL` | `http://kafka-connect:8083` | API Kafka Connect (profil plc4x) |
| `SEED_DEMO_ALARMS` | `1` | `0` pour ne pas créer les règles d'alarme de démo |

## Dév

Lancée par Docker Compose (service `gateway`). Pour itérer : `docker compose up -d --build
gateway`. Le code n'a pas de `node_modules` local (deps dans l'image) — les erreurs de l'éditeur
sur les imports sont des faux positifs sans incidence sur l'exécution.

Vue d'ensemble : [../docs/infra-architecture.md](../docs/infra-architecture.md).

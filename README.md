# Strata

> Couteau suisse Industrie 4.0 — plateforme de streaming de données industrielles.

Strata récupère des données industrielles (MQTT, automates S7/Modbus/EtherNet-IP via PLC4X),
les **normalise** vers un contrat unique, les **historise** (TimescaleDB), les **diffuse en
temps réel** (WebSocket) et permet d'**agir** (consignes vers les automates) — le tout via une
interface web moderne. Sans JVM (sauf le module PLC4X optionnel), packagé en **Docker Compose**.

## Stack

**Redpanda** (streaming) · **Redpanda Connect** (connecteurs/transfo, Go) · **TimescaleDB**
(historisation + agrégats) · **gateway** Node/TS (REST + WebSocket) · **React + Vite + TS** (web)
· *optionnels* : **PLC4X** (industriel réel) et **RisingWave** (anomalies temps réel).

📖 **Pour comprendre le projet en profondeur** : [docs/infra-architecture.md](docs/infra-architecture.md)
(topo global), [CLAUDE.md](CLAUDE.md), [docs/roadmap.md](docs/roadmap.md),
[docs/adr/0001-choix-stack.md](docs/adr/0001-choix-stack.md) (pourquoi ces choix).

## Démarrage rapide

Prérequis : Docker + Docker Compose.

```bash
cp .env.example .env     # ajuster les mots de passe avant tout déploiement
make up                  # démarre tout le stack par défaut
make ps                  # vérifie que les services sont "healthy"
```

Services exposés :
- **Web** (dev) : http://localhost:5173 — voir [section web](#interface-web-dev)
- **Gateway** (API + WS) : http://localhost:3001
- **Redpanda Console** : http://localhost:8080
- **TimescaleDB** : `localhost:5432` (identifiants dans `.env`)

```bash
make logs                # suit les logs
make down                # arrête le stack
make clean               # reset complet (⚠️ supprime les volumes/données)
```

Vérifier que les mesures arrivent (le simulateur tourne par défaut) :

```bash
docker compose exec timescaledb psql -U strata -d strata \
  -c "SELECT ts, tag, value FROM mesures ORDER BY ts DESC LIMIT 5;"
```

Compte initial : **admin / admin** (défini par `ADMIN_PASSWORD` dans `.env` ; à changer).

## Profils optionnels

```bash
# Industriel réel via PLC4X (S7/Modbus/EtherNet-IP) — ajoute Kafka Connect (seul container JVM)
docker compose --profile plc4x up -d

# Anomalies temps réel via RisingWave
docker compose --profile risingwave up -d
```

Détails : [connectors/plc4x/README.md](connectors/plc4x/README.md) et
[risingwave/README.md](risingwave/README.md).

## Interface web (dev)

Le frontend tourne en dev avec hot-reload (hors Docker) :

```bash
cd web
npm install
npm run dev        # http://localhost:5173 (proxifie /api et /ws vers la gateway)
```

## Structure

```
infra/        init SQL TimescaleDB, config Mosquitto, Dockerfile PLC4X
connectors/   pipelines Redpanda Connect (YAML) + templates PLC4X (JSON)
gateway/      API REST + WebSocket (Node/TS) — cœur applicatif
simulator/    usine simulée (micro-brasserie, Python)
risingwave/   SQL setup RisingWave (profil optionnel)
web/          frontend React + Vite + TS
docs/         architecture, roadmap, ADR
```

## État

Plateforme complète : ingestion multi-protocole, historisation, config de tags, production par
shift, RBAC, écriture de consignes, dashboards, alarmes, anomalies temps réel. Détail et reste à
faire : [docs/roadmap.md](docs/roadmap.md).

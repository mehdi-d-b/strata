# Strata

> Couteau suisse Industrie 4.0 — plateforme de streaming de données industrielles.

Strata récupère des données industrielles (MQTT, OPC-UA, PLC…), les historise dans une base
time-series, et les met à disposition en temps réel et en historique via une interface web
moderne.

## Stack

**Redpanda** (streaming) · **Redpanda Connect** (connecteurs/transfo) · **TimescaleDB**
(historisation + agrégats) · **gateway WebSocket** (temps réel) · **React + Vite + TypeScript**
(web). Le tout sans JVM, packagé en **Docker Compose**.

Détails et justifications : [CLAUDE.md](CLAUDE.md) et [docs/adr/0001-choix-stack.md](docs/adr/0001-choix-stack.md).

## Démarrage rapide

Prérequis : Docker + Docker Compose.

```bash
cp .env.example .env
make up        # démarre Redpanda, Redpanda Console et TimescaleDB
make ps        # vérifie que tout est "healthy"
```

- Redpanda Console : http://localhost:8080
- TimescaleDB : `localhost:5432` (identifiants dans `.env`)

```bash
make down      # arrête le stack
make clean     # reset complet (supprime les volumes)
```

Le stack inclut simulateur, broker MQTT, connecteurs et **gateway temps réel**
(http://localhost:3001). Vérifier que les mesures arrivent :

```bash
docker compose exec timescaledb psql -U strata -d strata \
  -c "SELECT ts, tag, value FROM mesures ORDER BY ts DESC LIMIT 5;"
```

## Interface web (dev)

Le frontend tourne en dev avec hot-reload (hors Docker) :

```bash
cd web
npm install
npm run dev        # http://localhost:5173 (proxifie /api et /ws vers la gateway)
```

## Roadmap

Voir [docs/roadmap.md](docs/roadmap.md). **Phase 1** (chaîne complète) en cours de validation.

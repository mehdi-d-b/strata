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

## Roadmap

Voir [docs/roadmap.md](docs/roadmap.md). On est en **Phase 0** (socle).

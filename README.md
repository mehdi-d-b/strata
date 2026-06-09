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

## 🚀 Le plus simple : le launcher (sans terminal)

Pas envie de toucher au terminal ? Le **launcher** est une petite application de bureau qui
démarre/arrête Strata à votre place : il **vérifie que Docker est prêt**, vous **cochez les
options** (PLC4X, RisingWave), vous cliquez **Démarrer**, et il **ouvre l'appli web**. Il gère
aussi les logs, la mise à jour des images et la sauvegarde des données (onglet *Maintenance*).

**Prérequis unique** : installer puis lancer **[Docker Desktop](https://www.docker.com/products/docker-desktop/)**
(Windows/Mac/Linux). C'est tout — le launcher détecte le reste et vous guide si quelque chose manque.

> ℹ️ À terme, le launcher sera un **exécutable à double-cliquer** (`.exe` / `.dmg` / `.AppImage`,
> via `npm run tauri build`). En attendant, on le lance une fois depuis ses sources :

```bash
cd launcher
npm install
npm run tauri dev        # ouvre la fenêtre du launcher
```

Dans la fenêtre :
1. **Prérequis** : les 2 voyants Docker doivent être verts.
2. **Projet Strata** : indiquez le dossier de ce dépôt (pré-rempli si vous lancez avec
   `STRATA_DIR=/chemin/vers/strata npm run tauri dev`).
3. *(optionnel)* cochez **PLC4X** et/ou **RisingWave**.
4. Cliquez **▶ Démarrer** et attendez que les services passent en **healthy**.
5. Cliquez **↗ Ouvrir l'appli** (lancez aussi le front : voir [Interface web](#interface-web-dev)).

Guide complet du launcher : [launcher/README.md](launcher/README.md).

## Démarrage en ligne de commande

Pour les habitués du terminal. Prérequis : Docker + Docker Compose.

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
launcher/     superviseur desktop Tauri (lance le stack sans terminal)
docs/         architecture, roadmap, ADR
```

## État

Plateforme complète : ingestion multi-protocole, historisation, config de tags, production par
shift, RBAC, écriture de consignes, dashboards, alarmes, anomalies temps réel. Détail et reste à
faire : [docs/roadmap.md](docs/roadmap.md).

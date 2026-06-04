# Roadmap Strata

Principe : **une chaîne qui marche de bout en bout le plus tôt possible**, puis on enrichit par
couches. Chaque phase est démontrable seule.

## Phase 0 — Fondations (le terrain) ⬅️ *en cours*
**But : `make up` lance un socle vide mais sain.**
- [x] Structure monorepo (`infra/`, `connectors/`, `gateway/`, `web/`, `simulator/`, `docs/`)
- [x] `docker-compose.yml` : Redpanda + Redpanda Console + TimescaleDB, avec healthchecks
- [x] `.env.example`, `Makefile` (`up`/`down`/`logs`/`ps`/`clean`)
- [x] Contrat de données : topic `tags.raw` = `{ tag, value, ts, quality, source }`
- [x] Init SQL Timescale : extension + hypertable `mesures`
- [x] `CLAUDE.md`, `README`, ADR de décisions

## Phase 1 — Chaîne complète minimale (« hello world industriel »)
**But : voir une valeur partir du simulateur → courbe temps réel + requête d'historique.**
- [ ] Simulateur v0 : publie 2-3 tags en **MQTT**
- [ ] Redpanda Connect #1 : MQTT in → normalisation → topic `tags.raw`
- [ ] Redpanda Connect #2 : `tags.raw` → sink TimescaleDB (`mesures`)
- [ ] Gateway WS/SSE : consomme `tags.raw` → navigateur
- [ ] Web : 1 courbe temps réel (uPlot) + 1 courbe historique (requête Timescale)

## Phase 2 — Configuration & modèle de tags
**But : plus rien de hardcodé ; on paramètre depuis l'UI.**
- [ ] Modèle `tags` en base (nom, adresse, type, unité, scaling, scan rate, source)
- [ ] UI web : CRUD tags + paramètres globaux
- [ ] Connecteurs pilotés par la config (dynamiques)
- [ ] Conversion d'unités / mise à l'échelle dans Redpanda Connect

## Phase 3 — Agrégats & dashboards métier
**But : dashboard production/shift en ETL « transparent ».**
- [ ] Continuous aggregates Timescale (prod/shift, moyennes, ébauche OEE)
- [ ] Modèle de shifts
- [ ] Pages dashboard : courbes historiques avec zoom, multi-tags, KPIs

## Phase 4 — Le vrai industriel
**But : sortir du simulateur, brancher de vrais protocoles.**
- [ ] OPC-UA : bridge source (`gopcua`) → `tags.raw` (+ serveur OPC-UA dans le simulateur)
- [ ] PLC4X via Kafka Connect (Modbus / S7 / Allen-Bradley) — profil Docker optionnel (1 container JVM)
- [ ] libplctag : option no-JVM pour Allen-Bradley en direct
- [ ] Sink PLC4X : écriture de consignes dans les tags

## Phase 5 — Plus si affinité
- [ ] RisingWave : streams dérivés temps réel, alarmes
- [ ] SCADA / synoptiques, alarming, auth & utilisateurs
- [ ] IA / détection d'anomalies

## Transverse
- Observabilité : Redpanda Console (P0) + Grafana plus tard
- Packaging : Compose (P0) ; installeur natif par OS = polish très tardif, non prioritaire
- CI légère quand le code grossit

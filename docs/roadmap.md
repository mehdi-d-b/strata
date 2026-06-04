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
- [x] Simulateur v0 : publie 3 tags en **MQTT** (compteur, température, vitesse)
- [x] Redpanda Connect #1 : MQTT in → normalisation → topic `tags.raw`
- [x] Redpanda Connect #2 : `tags.raw` → sink TimescaleDB (`mesures`)
- [x] Gateway WS : consomme `tags.raw` → navigateur (+ historique REST `/api/history`)
- [x] Web : courbe temps réel (uPlot) amorcée par l'historique Timescale

## Phase 2 — Configuration & modèle de tags ⬅️ *fait*
**But : plus rien de hardcodé ; on paramètre depuis l'UI.**
- [x] Modèle `tags` en base (nom, label, unité, scale, offset, enabled, description)
- [x] Auto-découverte : tout tag entrant crée sa config par défaut
- [x] UI web : tableau éditable des tags (onglet « Tags »)
- [x] Scaling appliqué **à la lecture** (gateway) : brut intact en base, `× scale + offset`
      à l'affichage — historique ET temps réel cohérents
- [x] Bonus UX : libellés + unités dans le graphe, sélecteur de plage (5/15/60 min)
- [ ] *Reporté* : scan rate / source par tag, paramètres globaux (pas nécessaires à ce stade)

## Phase 3 — Agrégats & dashboards métier ⬅️ *fait*
**But : dashboard production/shift en ETL « transparent ».**
- [x] Continuous aggregate `prod_buckets` (delta = max−min par 15 min, gère les resets)
- [x] Modèle de shifts **versionné** (`shift_schedule.valid_from`) — gère 2→3 shifts, horaires
      qui changent, sans réécrire l'historique
- [x] Rôles de compteurs (`tag_role` : produced/ok/scrap/available) — « SAP-lite »
- [x] Vues d'attribution `prod_by_shift` / `prod_by_shift_role` (attribution au shift à la lecture)
- [x] Onglet web « Production » : tableau par shift (OK/rebut/taux), édition planning + rôles
- [ ] *Reporté* : OEE complet, multi-lignes, courbes historiques avec zoom

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

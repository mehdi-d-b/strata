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

## Phase 4 — Le vrai industriel ⬅️ *PLC4X fait*
**But : sortir du simulateur, brancher de vrais protocoles.**
- [x] PLC4X via Kafka Connect (S7 / Modbus / EtherNet-IP) — profil Docker optionnel `plc4x`
      (1 container JVM isolé). Testable sans matériel via le driver `simulated://`.
- [x] Normaliseur `plc.raw → tags.raw` (Redpanda Connect) : éclate les tags PLC4X groupés
- [x] **Convention de nommage métier** `site.ligne.machine.mesure` coulée dans le béton
      (indépendante du protocole ; `source` en métadonnée). MQTT + PLC4X alignés.
- [x] 3 templates connecteurs commentés (Siemens/Schneider/Rockwell), prêts pour le réel
- [ ] OPC-UA : bridge source (`gopcua`) → `tags.raw` (+ serveur OPC-UA dans le simulateur)
- [ ] libplctag : option no-JVM pour Allen-Bradley en direct
- [ ] Sink PLC4X : écriture de consignes dans les tags (le `Plc4xSinkConnector` est déjà dispo)

## Phase 5 — Simulateur d'usine (cerveau riche, faces simples) ⬅️ *fait* 🍺
**But : une usine virtuelle vivante et marrante pour les démos.**
Thème : **micro-brasserie** (2 recettes : Blonde lager, IPA ale). Python.
Architecture **cerveau / faces** conçue pour accueillir les vraies faces en P6 sans réécrire.
- [x] Cerveau brassicole protocol-agnostique : cuves empâtage→ébullition→fermentation→embouteillage
- [x] Hook réaliste : écart à la **température cible** → dégrade la qualité → pilote le **rebut**
      (~2-3 % en régime, pic localisé lors d'un incident). Embouteilleuse en attente si moût pas prêt.
- [x] Face MQTT (lit l'état du cerveau, le publie). Frontière nette cerveau↔face.
- [x] Moteur de scénarios scriptés (journée : incidents thermiques, panne embouteilleuse, reprise)
- [ ] *Reporté* : face OPC-UA simple (optionnel, avant les vrais serveurs de P6)

## Phase 6 — Simulateur, vraies faces protocolaires
**But : que PLC4X se connecte au simulateur comme à de vrais automates.**
- [ ] Serveur **Modbus TCP** (le plus simple) exposant une partie du cerveau
- [ ] Serveur **Siemens S7** (Snap7) — coriace
- [ ] Serveur **Allen-Bradley EtherNet/IP** (cpppo…) — le plus dur
- [ ] Note langue : écosystème serveur le + riche = **Python** (pymodbus/python-snap7/cpppo) ;
      le cerveau peut rester en Go/Rust et exposer les faces via un petit adaptateur.

## Phase 7 — Comptes & contrôle d'accès (RBAC) 🔒
**But : sécuriser TOUTE l'appli (aujourd'hui toutes les routes gateway sont ouvertes).**
**Prérequis du sink PLC (P8)** : pas d'écriture vers un automate sans droits.
- [ ] Modèle utilisateurs + authentification (login, sessions/JWT)
- [ ] Rôles & droits **par groupe de tags / site / machine** (ex : écrire sur 1 seule ligne)
- [ ] Protéger les routes existantes (édition tags, shifts, rôles…) derrière l'auth
- [ ] Journal d'audit (qui a écrit quoi, quand) — utile surtout pour les écritures PLC

## Phase 8 — Écriture vers les PLC (sink) ✍️
**But : envoyer des consignes aux automates, encadré par les droits P7.**
- [ ] Connecteur `Plc4xSinkConnector` (déjà chargé dans Kafka Connect) : topic `tags.cmd` → PLC
- [ ] Vérif des droits (P7) avant toute écriture + entrée d'audit
- [ ] UI d'écriture de consigne (réservée aux utilisateurs autorisés)

## Phase 9 — Plus si affinité
- [ ] RisingWave : streams dérivés temps réel, alarmes
- [ ] SCADA / synoptiques, alarming
- [ ] IA / détection d'anomalies
- [ ] OEE complet (dispo × perf × qualité)

## Transverse (au fil de l'eau)
- Observabilité : Redpanda Console (P0) + Grafana plus tard
- **Rétention/compression Timescale** : `mesures` grossit indéfiniment aujourd'hui — ajouter
  une politique de rétention + compression avant tout usage « prod »
- Packaging : Compose (P0) ; installeur natif par OS = polish très tardif, non prioritaire
- CI légère quand le code grossit
- Sécurité : secrets en clair dans le compose (mots de passe) — externaliser avant prod

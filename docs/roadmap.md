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

## Phase 7 — Comptes & contrôle d'accès (RBAC) 🔒 ⬅️ *fait*
**But : sécuriser TOUTE l'appli (aujourd'hui toutes les routes gateway sont ouvertes).**
**Prérequis du sink PLC (P8)** : pas d'écriture vers un automate sans droits.
- [x] Modèle utilisateurs + authentification (scrypt, sessions cookie httpOnly révocables)
- [x] Rôles & droits **par préfixe de tag** (scope = `site.ligne.machine`, action read/write/admin)
      → ex : opérateur limité à `brasserie.blonde`. Testé : write blonde OK / write ipa 403.
- [x] Routes existantes protégées (écriture tag = droit sur le tag ; réglages globaux = admin)
- [x] Journal d'audit (login, créations, écritures…)
- [x] Front : login, gate de l'appli, page Admin (users, rôles/droits, audit)
- [ ] *Reporté* : sécuriser le WebSocket temps réel (lecture non authentifiée pour l'instant)
- [ ] *Reporté* : masquer/désactiver les boutons selon les droits (passe shadcn)

## Phase 8 — Écriture vers les PLC (sink) ✍️ ⬅️ *fait*
**But : envoyer des consignes aux automates, encadré par les droits P7.**
- [x] Gateway : POST `/api/command` (requireAuth + `can(write,tag)` + audit) → topic `tags.cmd`
- [x] Simulateur : face de commande (consume `tags.cmd`) → applique au cerveau (réaction visible)
- [x] Front : widget d'écriture de consigne (visible selon le droit write sur le tag)
- [x] Template `Plc4xSinkConnector` commenté (prêt pour le réel, non calibré)

## Phase 8.5 — Gestion des tags & automates ⬅️ *fait* (née des questions terrain)
**But : Strata = source de vérité de la config d'acquisition (plus de JSON à la main).**
- [x] Modèle `devices` (automate : protocole/host/base_tag) + `address`/`datatype` sur les tags
- [x] Génération des connecteurs PLC4X **depuis la base** + déploiement via l'API Kafka Connect
- [x] Un connecteur par automate (sourceName = base_tag) → 2 automates de protocoles différents
      sur une même ligne fonctionnent (ex : fermenteur Modbus + embouteilleuse S7)
- [x] UI onglet « Automates » : CRUD, adresses, import CSV, Déployer/Retirer
- [x] Persistance : relancer Strata recharge tout depuis la base

## Phase 9 — Plus si affinité
- [ ] RisingWave : streams dérivés temps réel, alarmes
- [ ] SCADA / synoptiques, alarming
- [ ] IA / détection d'anomalies
- [ ] OEE complet (dispo × perf × qualité)

## Dette technique & durcissement « prod »
Choix assumés de la phase démo : rien de bloquant en local, mais à traiter avant un vrai
déploiement. Aucune ne presse pour une démo.

### ✅ Rétention / compression TimescaleDB — *fait*
- Compression des chunks de +7j (`segmentby=tag`) + rétention du brut à 365j
  (`infra/timescale/init/06-retention.sql`). Les continuous aggregates (prod/shift) survivent.
- ✅ Pilotage depuis l'UI : onglet **Paramètres › Stockage** (état + réglages bornés rétention/
  compression). Onglet Paramètres ajoute aussi : changer son mot de passe, préférences
  d'affichage, infos système (versions, inventaire, état connecteurs).

### 🟠 WebSocket temps réel non authentifié
- `/ws` (gateway) est **ouvert** : le flux live contourne l'auth ET le RBAC (un opérateur
  limité à une ligne voit tout le temps réel). Cause : le WS se connecte direct sur `:3001`,
  hors du chemin cookie des `fetch`.
- À faire : valider la session à l'ouverture du WS + **filtrer** les tags poussés selon les
  droits de lecture de l'utilisateur (le filtrage est une feature en soi).

### ✅ Secrets hors du compose — *fait*
- Credentials Timescale + `ADMIN_PASSWORD` via `.env` (gitignored) ; `.env.example` documenté.
- `seedAdmin` ne logue plus le mot de passe ; alerte forte si le défaut `admin` est encore utilisé.
- *Reste optionnel* : forcer le changement du mot de passe admin au 1er login (UI).

### Idée — Gestion de TimescaleDB depuis l'UI (onglet « Stockage », admin)
Régler depuis l'appli : durée de rétention du brut, activation/seuil de compression,
visualisation de la taille des hypertables et du gain de compression. **Garde-fou** : ne PAS
exposer du SQL arbitraire — un petit ensemble de réglages validés (durées, on/off) qui
appellent les fonctions Timescale en backend. Pratique ET vendeur en démo (« l'admin gère sa
rétention sans toucher au SQL »).

## Transverse (au fil de l'eau)
- Observabilité : Redpanda Console (P0) + Grafana plus tard
- Packaging : Compose (P0) ; installeur natif par OS = polish très tardif, non prioritaire
- CI légère quand le code grossit

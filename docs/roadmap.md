# Roadmap Strata

Principe : **une chaîne qui marche de bout en bout le plus tôt possible**, puis on enrichit par
couches. Chaque phase est démontrable seule.

## Phase 0 — Fondations (le terrain) ⬅️ *fait*
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
- [x] OPC-UA **via PLC4X** (driver client `plc4j-driver-opcua`) : OPC-UA = une valeur de
      `protocol` de plus (`opcua`), connection string `opcua:tcp://host:port`, adresse = node-id
      (`ns=2;s=…`). Réutilise **toute** l'infra PLC4X (Kafka Connect + génération de connecteurs +
      Déployer/Retirer). Le serveur OPC-UA est **intégré à l'automate** (S7-1500 natif) → PLC4X est
      le **client**, pas de serveur tiers. ⚠️ Passe donc par le **profil `plc4x` (JVM)** — écart
      assumé au « OPC-UA sans JVM » initial, au profit d'un réemploi total. *Câblé ; non validé
      end-to-end (pas de serveur OPC-UA de test). Alternative no-JVM `gopcua` = juste une autre
      source vers `tags.raw`, ajoutable plus tard.*
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
- [x] Sécurisation du WebSocket `/ws` : auth au handshake (cookie same-origin) + filtrage du
      flux par droits `read` (un opérateur ne reçoit que ses lignes en temps réel)
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
- [ ] RisingWave : streams dérivés temps réel — **évolution de la détection d'alarmes à
      l'échelle** (aujourd'hui les seuils sont évalués dans la gateway ; le modèle `alarms` est
      déjà conçu indépendant du détecteur, `source: rule|tag`, pour basculer vers RisingWave
      **sans toucher l'UI**). Aussi : alarmes dérivées multi-tags, fenêtres glissantes.
- [ ] SCADA / synoptiques (vues schématiques animées par les tags)
- [x] **OEE complet** (Disponibilité × Performance × Qualité) — backend (vues Timescale
      `oee_by_shift` + `/api/oee`), config par ligne (`oee_line`), **objectifs + projection
      fin de shift** (`oee_target`, `pieces_ratio` pour barres de remplissage, `on_track`), page
      web (jauges, cascade des pertes, tendance). Conception : [docs/oee-design.md](oee-design.md).
      Validé en live sur la brasserie.
  - [x] **Motifs d'arrêt — Pareto des pertes** (« où agir ») : v1 **dérivés** des signaux
        (`running_tag` 0=Arrêt/2=Panne, `waiting_tag`=Attente amont), agrégat `oee_reason_buckets`
        + vue `oee_downtime_by_shift` + `GET /api/oee/downtime` + catalogue `stop_reason` éditable.
        Validé en live (la brasserie : Attente amont = perte #1, devant pannes/arrêts).
    - [x] **Reclassement opérateur** : détection d'arrêts discrets (trou entre échantillons en
          marche = état 0/2 *ou* ligne éteinte) + étiquetage du vrai motif par l'opérateur
          (`GET /api/oee/stops`, `POST /api/oee/stops/label`, droit `write`, audité ; motif
          effectif = label sinon dérivé). Validé en live. Palette de motifs « terrain » seedée.
    - [x] **Pareto basé sur les arrêts étiquetés** (`GET /api/oee/downtime/events`) : agrège les
          arrêts détectés par **motif effectif** (label opérateur sinon dérivé) → les reclassements
          remontent dans le Pareto. Validé en live.
    - [ ] *v2 restant* : codes motif PLC (auto), durées exactes (sub-bucket), distinction
          planifié/non planifié **dans le calcul OEE** (sortir les arrêts planifiés du PPT).
  - [ ] Cadence **par produit** + **calendrier d'arrêts planifiés** (sortir les pauses du PPT).
  - [ ] **OEE *live*** (RisingWave) : fenêtre glissante sub-seconde pour la **réactivité atelier**
        — andon (écran qui égraine l'OEE en direct), **alerte OEE** sous seuil (réutilise le modèle
        d'alarmes `source='derived'`), capter les micro-arrêts que les buckets 15 min lissent.
        À distinguer du **batch** actuel (reporting manager). ⚠️ *Ne vaut que si quelqu'un AGIT*
        *sur le chiffre temps réel* (opérateur / alerte / andon) ; sinon le batch suffit.
- [ ] **Prévision de séries — TimesFM** (Google). Service Python séparé : lit l'historique
      (`/api/history` ou Timescale en lecture), réinjecte les prévisions comme tags
      `source: forecast` (ex `...temperature.forecast`) → absorbés par le contrat `tags.raw`,
      affichés à côté du réel. Aucune refonte. Lourd (modèle de fondation JAX), inférence batch.
- [ ] **Assistant IA (LLM local + RAG + MCP)** — *pluggable sans refonte* grâce aux contrats
      stables (topic `tags.raw`, API REST, RBAC). Principe clé : l'IA est **un utilisateur de
      plus** → un serveur MCP « Strata » expose des tools qui appellent l'API gateway existante
      (`/api/history`, `/api/production`, `/api/command`), donc RBAC + audit s'appliquent
      gratuitement. RAG sur docs internes = brique orthogonale (vector store). LLM local
      (Ollama/vLLM) = container de plus, sans JVM.
      ⚠️ Règle d'or : l'IA passe TOUJOURS par l'API, jamais d'accès direct à la base (sinon on
      perd auth/RBAC/audit).

## Phase 10 — Front : refonte UX/UI, visualisation & alarmes ⬅️ *fait* (chat front dédié)
Mené dans un chat dédié au front (`web/`, parfois `gateway/`). Mergé dans `main`.
- [x] **Design system** : tokens sémantiques **clair + sombre** (source unique), toggle de thème,
      **sidebar** à sections + repli, kit de composants partagés (PageHeader / Section / TabBar /
      KpiCard + primitives shadcn Button/Input/Card/Table/Badge + toaster Sonner). **8 vues
      migrées** ; `style.css` élagué (plus de couleur en dur).
- [x] **Explorer** (ex « Temps réel ») : tooltip multi-séries (report LOCF), **2 échelles
      indépendantes** gauche/droite (forçage manuel + défaut par unité), contrôles (pause, zoom
      boîte X/Y avec auto-pause, reset, export CSV, masquer une série), **mode historique daté**
      (endpoint `/api/history?from&to` + down-sampling `time_bucket`, validé).
- [x] **Dashboards** (privés par utilisateur) : panneaux multi-séries **sauvegardés**, données
      **REST + auto-refresh**, plage de temps partagée (relative/absolue), éditeur de panneaux.
      Table `dashboards` + CRUD gateway (validé).
- [x] **Alarmes A + B** : détection de **seuils dans la gateway** (`alarm_rules` / `alarms`,
      anti-rebond `for_ms`, hystérésis, 1 active/règle), **polling REST**, **badge** + **toasts**
      (réglables, action *Acquitter*) + **bandeau critique**, page **Alarmes** (onglets
      courantes/règles, résumé par sévérité, filtres, ack / tout-acquitter). **Type B** (tags PLC
      alarme) = règle `== 1` via **fiche-tag** + **import CSV/Excel** (SheetJS). ⚠️ **une seule
      source de vérité `alarm_rules`, pas de flag `is_alarm`**.
- [x] **Finitions** : palette de commandes **⌘K**, toggle de **densité**, préférences locales.
- [ ] *Reste front (Phase C alarmes, plus tard)* : **historique d'alarmes daté**
      (`/api/alarms/history`), **push WS instantané** (dépend de la sécurisation du `/ws`),
      indicateurs d'alarme **en contexte** (Explorer/Dashboards), son optionnel.

## Dette technique & durcissement « prod »
Choix assumés de la phase démo : rien de bloquant en local, mais à traiter avant un vrai
déploiement. Aucune ne presse pour une démo.

### ✅ Rétention / compression TimescaleDB — *fait*
- Compression des chunks de +7j (`segmentby=tag`) + rétention du brut à 365j
  (`infra/timescale/init/06-retention.sql`). Les continuous aggregates (prod/shift) survivent.
- ✅ Pilotage depuis l'UI : onglet **Paramètres › Stockage** (état + réglages bornés rétention/
  compression). Onglet Paramètres ajoute aussi : changer son mot de passe, préférences
  d'affichage, infos système (versions, inventaire, état connecteurs).

### ✅ WebSocket temps réel sécurisé — *fait*
- `/ws` : auth au handshake via cookie same-origin (close 4401 sinon) + **filtrage RBAC** par
  socket (chaque client ne reçoit que les tags qu'il a le droit de lire). Front en same-origin
  (proxy Vite `/ws`). Testé : admin = tout, opérateur restreint = ses lignes seulement.
- Débloque le **push temps réel des alarmes** (Phase C) sur le même socket filtré (aujourd'hui
  encore en polling REST ~7 s, qui reste le fallback).

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

### Déploiement / prod (todos infra issus des questions du 2026-06-08)
- [ ] **Front en prod** : service `web` qui sert le `vite build` (statique) via **nginx ou
      Caddy**, + **reverse proxy** `/api` & `/ws` → gateway (rend le same-origin propre en prod).
      Aujourd'hui le front tourne en `npm run dev` (Vite), c'est du dev uniquement.
- [x] **Launcher / superviseur desktop** (cf. **docs/launcher-plan.md**) : app **hors Docker**
      en **Tauri** (backend Rust qui shelle le CLI `docker`). **Fait** (branche `feat/launcher-v2`,
      pas encore mergée ; backup/restore + éditeur .env non testés à l'exécution) :
      - v1 : prérequis Docker, cases des profils → compose up, voyants de **santé** (running≠ready),
        start/stop/refresh, ouvre l'appli.
      - v2 : **logs** (filtre + suivi), **hôte distant** (contexte Docker), **update d'images**,
        **backup/restore des volumes**, **sélecteurs de fichiers natifs**, **onglet Configuration**
        (éditeur `.env` = config de bootstrap), textes dé-jargonnés.
      ⚠️ Frontière actée : **web = données métier (in-band) ; launcher = cycle de vie infra
      (out-of-band)**. Ex : backup de volume = launcher, pas le site web.
      - [ ] *Reste* : **packaging** en exécutable double-cliquable (`tauri build` + vraies icônes) ;
        câbler l'URL « Ouvrir l'appli » sur le front de prod (pas le port Vite `5173`).
- [ ] **Distribution « .exe + images » (productisation)** — *prérequis pour livrer sans cloner le
      repo* (cf. **docs/launcher-plan.md §9**). Aujourd'hui lancer Strata exige le repo (services
      `build:` + fichiers de config montés). Cible : **publier les images** sur un registry
      (gateway/simulator/web/kafka-connect) + un **`docker-compose.prod.yml`** en `image:`
      (config cuite dans les images ou bundlée par le launcher) → le launcher n'embarque que le
      compose et **pull** tout. Demande : registry + CI de build/push, compose de prod, `.env`
      généré (déjà fait dans le launcher). Variante usine **air-gapped** : images en tarballs
      (`docker save`/`load`).
- [ ] **Enrichir `/api/system`** : état des services vus par la gateway (Redpanda/Timescale/
      RisingWave joignables ?, profils actifs). Limite assumée : la gateway ne voit que de
      l'intérieur ; le monitoring infra « vrai » reste externe (Console, Grafana).

### Assistant IA — 100 % local (cf. docs/llm-integration.md)
> 🧭 **Fil conducteur terrain → harness → modèle : [docs/assistant-roadmap.md](assistant-roadmap.md)**
> (câblage = llm-integration.md ; terrain données = simulator-scenarios.md)
- [x] **v1 — agent in-app (Chemin B)** : profil Docker `ai` (**Ollama**, modèle open-source
      `qwen2.5:3b`), boucle d'agent dans la gateway (`POST /api/assistant/chat`) + **tools de
      lecture** (`get_oee`, `get_production`, `list_alarms`, `get_history`) exécutés côté gateway.
      Le LLM ne touche jamais la base (il propose des tool-calls, la gateway exécute). **Validé en
      live** : qwen2.5:3b a appelé `get_oee` et répondu le bon chiffre (~49 s CPU). UI chat = front.
      *Pas de MCP* (inutile en in-app) ni LangChain (boucle directe).
- [x] **v2 — Part A : questions imprévues (text-to-SQL en bac à sable)** : tools
      `describe_schema` (catalogue des tables de données via les grants) + `query_readonly`
      (SELECT exécuté via rôle Postgres **read-only** `strata_ro` + transaction READ ONLY +
      timeout + LIMIT). **Sandbox validé** (lecture données OK, auth refusée, écriture refusée).
      ⚠️ **Bridé par le modèle local** : qwen2.5:3b n'arrivait pas à piloter le flux
      describe→query (thrash) — testé sur l'ancienne machine, CPU seul. **À réévaluer sur le
      Mac M4 (GPU Metal, 16 Go) avec un modèle 14B.**
- [x] **v2 — Part B : action encadrée** (propose → confirme → exécute) : write tools
      (`set_command`, `ack_alarm`) **interceptés** par la boucle → proposition à **confirmation
      humaine** (`pending_action`) ; `POST /api/assistant/confirm` re-vérifie `can(write)`, exécute,
      audite, **consomme** (one-shot). **Validé en live** (le 3B propose, l'humain confirme, l'ack
      s'exécute). Sûr même avec un petit modèle (l'humain est le garde-fou).
- [x] **v3 — tools d'investigation enrichis** : `get_batch_context` (dossier batch complet :
      déviations par cuve vs bande nominale `[temp_cible ± temp_tol]`, exclusion du transitoire
      de chauffe, alarmes pendant le batch, changements de consigne, CIP — réf = id ou recette
      `"dernier ipa"`), `get_line_status` (état temps réel machine par machine), `get_shift_summary`
      (OEE + batches + alarmes du shift courant), `get_oee_breakdown` (cascade des pertes),
      `get_active_batches`, `search_knowledge` (RAG pgvector sur SOPs/incidents).
      Système prompt enrichi : guide le LLM pour ne jamais inventer de déviation, lire `conforme`
      en premier, appeler `search_knowledge` avant d'investiguer les tags sur une question procédurale.
      SSE live trace : le front voit les tools s'enchaîner en temps réel.
- [x] **v4 — routing + hypothèses/preuves forcées** : `detectBatchDiagnostic` (heuristique légère :
      verbe diagnostic + mot batch/recette connue/id) route les questions de diagnostic batch ;
      `get_batch_context` puis (si non conforme) `search_knowledge` ciblé sur le défaut réel
      (`defaut_type`/`cip_ok`/`cuves_hors_bande`) sont **appelés en code, jamais laissés au choix
      du modèle**, et injectés dans l'historique avant la boucle ReAct existante (même mécanique
      de tool-call, zéro changement front). Le modèle n'a plus qu'à corréler/conclure sur un
      dossier déjà complet ; il garde la liberté d'appeler un tool de plus en filet de sécurité.
- [ ] **v4 — streaming token** (UX) + valider en live avec `qwen2.5:14b` sur le Mac M4.

### Documentation utilisateur / aide en ligne (in-app)
But : qu'un **utilisateur non-tech** découvre **toutes** les features et **comment les utiliser**.
À distinguer des docs **dev/infra** existantes (`docs/`, ce fichier) : ici c'est du **produit/end-user**.
- [ ] **Doc d'utilisation ultra-précise de l'interface** : couvrir CHAQUE vue (Explorer,
      Dashboards, Alarmes, Production, OEE, Automates, écriture de consignes, Paramètres,
      comptes/RBAC) — le *comment*, pas juste le *quoi*. Captures/exemples.
- [ ] **Accessible DEPUIS l'interface** (pas qu'un PDF externe) : un **centre d'aide / « wiki »
      intégré, moderne et cherchable**. Pistes :
      - pages rendues depuis du **Markdown** (contenu versionné, facile à maintenir, proche du code) ;
      - **recherche** branchée sur la palette de commandes **⌘K** déjà en place ;
      - **aide contextuelle** par page (bouton « ? » → la rubrique correspondante) ;
      - optionnel : **tour d'onboarding** au 1er login, tooltips.
- [ ] Frontière : c'est du **front** (chat dédié) ; le contenu vit près du code (`web/help/` ou
      `docs/user/`) pour évoluer avec les features. Le backend peut servir le Markdown si besoin.

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
- [ ] Sink PLC4X : écriture de consignes dans les tags (le `Plc4xSinkConnector` est déjà dispo).
      *Précision (2026-07-02)* : ne concerne QUE un vrai déploiement avec automate physique —
      l'écriture de consigne EN DÉMO fonctionne déjà intégralement (`/api/command` → topic
      Kafka `tags.cmd` → `command_face.py` du simulateur, RBAC write par user × ligne déjà en
      place via Admin → Rôles & droits). Pas de besoin tant qu'aucun vrai automate n'est à piloter.
- [x] **Pilotage (démarrer/arrêter une ligne) — fait (2026-07-02)**. Section « Pilotage » en
      haut de la page Production : un bouton par ligne (celles configurées dans `oee_line`,
      via leur `running_tag`), visible seulement si l'utilisateur a le droit `write` sur la
      ligne (`canWrite`, même check que `CommandBox`). Réutilise entièrement l'écriture
      existante — aucune nouvelle route ni nouveau modèle de droits. Validé en live : écriture
      0 puis 1 sur `brasserie.jalapeno.embouteilleuse.state`, effet visible en ~2 s.

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
- [x] RisingWave : profil Docker optionnel déjà dans `main` (chaîne validée
      `tags.raw→MV→tags.derived→alarms source=derived`, cf. `risingwave/README.md`). Le modèle
      `alarms` est bien indépendant du détecteur (`source: rule|tag|derived`), comme prévu.
      ⚠️ **Dernier recours, non construit par défaut** : pour la dérive/self-baseline (le cas
      d'usage visé ici), un continuous aggregate TimescaleDB + le mode bande de `alarm_rules`
      (cf. `docs/infra-architecture.md` §3) suffit largement, sans le coût d'un service
      streaming de plus. Ne réactiver RisingWave que si un vrai besoin **sub-seconde** apparaît
      (cf. ADR 0001).
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
    - [x] **Planifié/non-planifié dans le calcul OEE** : la Dispo divise par le PPT NET
          (durée du shift − minutes des arrêts étiquetés `planned`, ex. nettoyage/pause) au lieu
          de la durée brute — nouveau champ `planned_downtime_minutes` sur `/api/oee`. Ne
          fonctionne que sur les arrêts déjà étiquetés par l'opérateur (pas de calendrier de
          pauses déclaré à l'avance, cf. ligne suivante). Validé en live (`docs/oee-design.md`).
    - [ ] *v2 restant* : codes motif PLC (auto), durées exactes (sub-bucket, hors du chemin déjà
          exact des arrêts étiquetés).
  - [x] **Calendrier d'arrêts planifiés** (déclaré à l'avance, sans dépendre d'un étiquetage a
        posteriori) : table `planned_stop` (par ligne ou toute l'usine), branché dans le calcul
        de la Dispo avec anti-double-comptage vs les arrêts déjà étiquetés. UI : OEE →
        Configuration. Validé en live (`docs/oee-design.md`).
  - [ ] Cadence **par produit** — *bloqué pour l'instant (2026-07-02)* : dans le simulateur,
        **une ligne = une recette, en permanence** (`brain.py`, pas de changement de série sur
        une ligne) — donc rien à valider en live tant que cette physique n'existe pas. Repris
        si un changement de série est ajouté au simulateur, ou si un vrai besoin client apparaît.
  - [ ] **OEE *live*** (RisingWave) : fenêtre glissante sub-seconde pour la **réactivité atelier**
        — andon (écran qui égraine l'OEE en direct), **alerte OEE** sous seuil (réutilise le modèle
        d'alarmes `source='derived'`), capter les micro-arrêts que les buckets 15 min lissent.
        À distinguer du **batch** actuel (reporting manager). ⚠️ *Ne vaut que si quelqu'un AGIT*
        *sur le chiffre temps réel* (opérateur / alerte / andon) ; sinon le batch suffit.
- [x] **Prévision de séries — TimesFM (essayé, abandonné, 2026-07)**. Implémenté (service Python
      natif Mac, prévision +30 min affichée dans le panel batch), puis retiré après évaluation :
      trop de moyennage (bucket SQL avant l'inférence), modèle zero-shot univarié aveugle à la
      consigne (donc incapable de suivre un changement de setpoint), et courbe figée +30 min peu
      lisible/actionnable. Aucun cas d'usage identifié qui ne soit pas déjà mieux couvert, sans
      dépendance lourde ni GPU, par le mode bande de `alarm_rules` (écart à la consigne, cf.
      `docs/infra-architecture.md` §3) ou par un calcul déterministe depuis la recette (ETA vers
      la consigne). La branche `feat/forecaster` a été supprimée — jamais mergée dans `main`.
- [x] **« Santé équipement » — bande + self-baseline générique (essayé, abandonné, 2026-07)**.
      Page dédiée (`/health`) exposant les modes bande (`ref_tag`/`tolerance`) et self-baseline
      (`baseline_sigma`, tendance 1 min vs 5 min) de `alarm_rules` comme « équipements surveillés »,
      avec démos dédiées (groupe froid/dégivrage pour la bande, usure/vibration embouteilleuse pour
      le self-baseline). Retirée après évaluation en conditions réelles : le mode bande, pour être
      lisible, exige d'éviter le régime transitoire (cf. démo fermenteur vs `temp_cible`, mauvais
      choix initial à cause du cycle de batch accéléré) — une fois ce cherry-picking fait, ça reste
      proche d'une alarme classique déguisée. Le mode self-baseline détecte une dérive
      statistiquement réelle (vibration embouteilleuse) mais sans rattachement à un mode de
      défaillance identifiable : la courbe (dents de scie court/long terme) n'est pas actionnable
      pour un mainteneur — "la moyenne a bougé" ne dit pas quoi faire. Aucune des deux formes
      génériques ne justifie une page produit auto-service.
      **Gardé** (briques bas niveau, réutilisables sans coût à les laisser en place) : modes
      bande/self-baseline de `alarm_rules` (gateway `alarms.ts`), agrégats continus
      `tag_stats_1m`/`tag_stats_5m`, route `GET /api/tag-stats`, physique de démo simulateur (usure
      embouteilleuse, groupe froid + cycle de dégivrage). Ces règles restent visibles/gérables
      depuis Alarmes → Règles de seuil, juste sans page de visualisation dédiée.
      **Retiré** : `web/src/HealthView.tsx`, route `/health`, entrée nav, `fetchTagStats` côté front
      (orpheline sans la page).
      **Piste envisagée** : pas une feature générique de plus, mais un **bloc de maintenance
      prédictive taillé par installation** — mesure et paramètres spécifiques à un mode de
      défaillance connu d'un équipement donné, écrits par un dev à l'installation chez un client
      (potentiellement un petit modèle ML dédié plutôt qu'une statistique générique sur un tag
      arbitraire), pas un self-service. Non dimensionné à date (pas de client/besoin réel identifié).
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
- [x] **Phase C alarmes (fait, 2026-07-02)** :
      - **Historique d'alarmes daté** : `/api/alarms/history` existait déjà côté gateway
        (non branché) — nouvel onglet « Historique » dans Alarmes (période 24h/7j/30j,
        filtre sévérité, durée par alarme).
      - **Push WS instantané** : `/ws` porte maintenant deux types de message
        (`type: "measure"` inchangé, nouveau `type: "alarm"`), même filtrage RBAC par tag
        que les mesures. `AlarmEngine` accepte un callback `onEvent` appelé à chaque
        raise/clear (`gateway/src/alarms.ts`). Le polling REST ~7s reste le filet de
        rattrapage (1er chargement, reconnexion) — pas de reconnexion auto sur le WS,
        cohérent avec `useRealtimeBuffers.ts`. Validé en live : bascule d'un seuil de
        règle observée en direct sur le socket, forme du message correcte.
      - **Indicateurs d'alarme en contexte** : `MultiChart` accepte `alarmBands` (bandes
        verticales teintées par sévérité, peintes derrière les séries via le hook uPlot
        `drawClear`) — branché dans Dashboards (tous modes) et Explorer (**mode historique
        uniquement** ; le direct reste sans bandes, le badge/toast suffit pour le temps réel).
      - **Son optionnel** : bip généré (Web Audio, pas de fichier), préférence
        `alarmSound` — **désactivée par défaut**, dépend de `alarmToasts` (Paramètres →
        Préférences d'affichage).

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
- [x] **Enrichir `/api/system`** : nouveau champ `services[]` — TimescaleDB (`SELECT 1`),
      Redpanda (admin Kafka), Kafka Connect, Ollama (assistant IA), RisingWave (TCP direct sur
      4566, même sonde que son propre healthcheck Docker), chacun avec `reachable`+latence,
      timeout 1,5 s. Pour les profils optionnels, « injoignable » = non démarré OU en panne,
      indifférencié (limite assumée : la gateway ne voit que de l'intérieur ; le monitoring
      infra « vrai » reste externe, Console/Grafana). UI : section « Services » dans Paramètres
      → Système. Validé en live contre l'état réel des conteneurs (Kafka Connect/RisingWave
      arrêtés, Timescale/Redpanda/Ollama actifs — correspond exactement).

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
      (`request_operation`, `ack_alarm`) **interceptés** par la boucle → proposition à **confirmation
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
- [x] **v4 — streaming token** (UX). `stream:true` sur l'appel Ollama `/api/chat` : les
      `tool_calls` n'arrivent jamais fragmentés (Ollama les livre d'un bloc), seul le texte
      d'une réponse finale est lu au fil de l'eau (NDJSON) et relayé par un nouvel événement
      SSE `{type:"token", step, content}` — la logique d'exécution des tools est inchangée.
      Front (`assistant.tsx`/`AssistantView.tsx`) : bulle qui grandit token par token avec
      curseur clignotant (au lieu d'attendre la réponse en bloc). Validé en live avec
      `qwen2.5:14b` (Metal, Mac M4) : `GET /api/oee` → réponse correcte et fluide (~59 s tout
      compris, tool call + génération). ⚠️ Un tool au résultat volumineux (`list_alarms`,
      ~14 Ko) a fait exploser le temps de traitement du prompt (~190 s pour 2 caractères
      générés) — pré-existant (indépendant du streaming, reproduit en direct contre Ollama),
      pas corrigé ici : à traiter plus tard en bornant/résumant les résultats de tools volumineux.
- [x] **RAG — ingestion PDF (2026-07-09)**. `search_knowledge`/`knowledge` (pgvector)
      n'acceptait jusqu'ici que des textes écrits à la main (`seed-knowledge.ts`, ~20 entrées
      déjà taille chunk). Ajout de `seed-knowledge-pdf.ts` : lit les PDF de
      `gateway/knowledge-pdfs/` (committés, contenu inventé/non confidentiel), extrait le texte
      (**`pdfjs-dist`**, pas `pdf-parse` — sa version interne de pdf.js échoue sur des PDF
      valides, vérifié en direct contre un PDF généré par `pdfkit` et confirmé lisible par
      `pypdf`), découpe en chunks (**`RecursiveCharacterTextSplitter`** de
      `@langchain/textsplitters`, chunkSize 1000/overlap 150), embedde chaque chunk (même
      `nomic-embed-text` qu'avant) et upsert dans `knowledge` (catégorie `manuel`, titre =
      `<fichier> — chunk i/N`, pas de migration de schéma nécessaire). Idempotent
      (`ON CONFLICT (category, title)`).
      ⚠️ **`@langchain/community` (qui porte `PDFLoader`) est déprécié** par LangChain
      lui-même (les mainteneurs recommandent des paquets dédiés ou du code applicatif direct
      plutôt qu'un gros paquet "community") — écarté au profit de `pdfjs-dist` en direct.
      Seul `@langchain/textsplitters` est utilisé, pas le reste du framework.
      Chunking sémantique et *contextual retrieval* (Anthropic) évalués et écartés pour l'instant :
      corpus trop petit/trop propre (écrit par nous) pour qu'un problème de perte de contexte
      aux frontières de chunk se manifeste — à reconsidérer seulement si les métriques de
      récupération le justifient un jour. Validé en live : question sur le changement de fût
      CO2 → `search_knowledge` retrouve le bon chunk, réponse correcte et sourcée.

### Migration vers un microservice Python (FastAPI + LangGraph) — `ai-service/`
> Décision : garder la gateway TS **inchangée** (Kafka, WS, RBAC, alarmes, OEE) ; tout le
> chat/RAG/agent bascule vers un microservice Python dédié, appelé en HTTP. Frontière de sécurité
> préservée : `ai-service` n'a **aucun accès direct** à Postgres/Kafka — seule porte d'entrée =
> la gateway, comme n'importe quel client HTTP. Objectif : isoler l'IA dans un service dédié,
> avec l'écosystème Python (LangGraph, Docling), sans toucher au cœur temps réel.
- [x] **Étape 1 — squelette + preuve de frontière (2026-07-17)**. `ai-service/` (`uv`, FastAPI,
      LangGraph `create_react_agent`, `langchain-ollama`), un seul tool (`get_oee`, appelle
      `GET /api/oee` sur la gateway). Dockerfile + service `ai-service` dans `docker-compose.yml`
      (profil `ai`, comme `ollama`) ; Ollama tourne nativement sur ce Mac (GPU Metal), d'où
      `OLLAMA_URL=host.docker.internal`, même schéma que `gateway`. Modèle de test découplé de la
      prod via `AI_SERVICE_MODEL` (pas `ASSISTANT_MODEL`, sinon `.env` écraserait silencieusement) :
      `qwen2.5:7b` retenu après comparaison — `mistral:7b` a un vrai support tool-calling (Ollama
      l'annonce, confirmé) mais s'est montré trop sensible à la formulation exacte de la question
      via LangGraph/`bind_tools` (« résume » échoue, « donne-moi » marche) ; `qwen2.5:7b`, même
      famille que le 14b de prod, est resté fiable sur les mêmes reformulations.
      ⚠️ **Flakiness Ollama locale découverte en cours de route** : fuite de tool-call en texte
      brut (`<tool_call>` corrompu en tag illisible), reproduite en direct sur l'agent TS existant
      (`/api/assistant/chat`) sur une instance Ollama fraîchement redémarrée — donc **pas un bug de
      code**, un problème d'infra locale (charge/thermal du Mac pendant des tests concurrents
      répétés). Non résolu, pas bloquant : réapparaît occasionnellement selon la formulation même
      hors charge (ex. « Combien y a-t-il de batches en cours ? » vs « Liste les batches en cours »
      qui marche) — sensibilité connue des petits modèles locaux au tool-calling, à garder en tête.
- [x] **Étape 2 — portage complet du graphe (2026-07-17)**. Tous les tools de
      `assistant.ts::TOOLS` portés en tools LangChain (`ai-service/tools.py`), chacun appelant la
      gateway en HTTP (jamais Postgres/Kafka direct) :
      - 7 déjà couverts par des routes REST existantes (`get_oee`, `get_production`, `list_alarms`
        → `/api/alarms`, `get_history`, `get_active_batches`/`get_shift_summary`/`get_oee_breakdown`
        composés côté Python à partir de `/api/oee` (qui fait déjà `SELECT *` sur `oee_by_shift`,
        donc `is_current`/`on_track` étaient déjà là) + `/api/batches` + `/api/oee/downtime`).
      - **6 nouvelles routes REST ajoutées à la gateway** (thin wrappers du SQL déjà présent dans
        `assistant.ts::execTool`, rien de nouveau inventé) : `GET /api/batches/:ref/context`,
        `GET /api/schema`, `POST /api/query-readonly` (sandbox SQL en lecture seule — mêmes
        garde-fous qu'avant : rôle `strata_ro`, transaction READ ONLY, timeout, LIMIT 500 — décision
        explicitement validée avant implémentation, pas prise seul vu la surface exposée), `POST
        /api/knowledge/search`, `GET /api/lines/status`, `GET /api/factory-context` (contexte usine
        dynamique injecté dans le system prompt). Toutes gated `requireAuth`.
      - `ai-service` s'authentifie contre la gateway via un **compte de service** (login + cookie de
        session, `gateway.py`) — pas encore l'identité de l'opérateur qui discute (ça viendra avec
        le rebranchement du frontend, étape 6).
      - **Routage forcé RCA** (`routing.py` : portage exact de `detectBatchDiagnostic`/
        `buildKnowledgeQuery`) devenu une **entrée conditionnelle du graphe** (`StateGraph`,
        pas du code impératif avant la boucle comme en TS) : diagnostic de batch détecté → nœud
        `forced_batch` (appelle `get_batch_context` puis, si non conforme, `search_knowledge` ciblé)
        → `agent`, sinon direct → `agent`. Validé en live : « Pourquoi le dernier batch ipa est-il
        hors spec ? » déclenche bien la séquence forcée, résout « dernier ipa » côté serveur,
        conclut sur `cip_ok`/`cuves_hors_bande` sans halluciner.
      - **Tools d'écriture interceptés** (`request_operation`, `ack_alarm`) : routées vers un nœud dédié
        AVANT tout `ToolNode` — jamais exécutées, réponse = proposition à confirmer. Persistance +
        `/confirm` réels repoussés à l'étape 4 (`interrupt()` + checkpointer Postgres) ; pour
        l'instant la proposition est éphémère (pas de `PENDING` map côté Python).
      - **Streaming SSE** (`astream_events` v2) sur `POST /chat` : mêmes types d'événements que
        `AgentEvent` côté TS (`tool_call`/`tool_result`/`token`/`answer`), pour rester branchable
        tel quel une fois le front rewiré sur ce service.
      - Bug trouvé et corrigé en testant : `get_batch_context` recevait le `batch_ref` non
        URL-encodé (espaces/`?` cassaient le routing Fastify côté gateway) ; descriptions par
        paramètre (perdues en portant juste la docstring Python) réintroduites via
        `Annotated[..., Field(description=...)]` — sans elles le modèle passait `line='blonde'`
        au lieu de `'brasserie.blonde'` (correspondance exacte côté SQL, donc résultat vide) ;
        `list_alarms` plafonné à 20 lignes (pas 50 comme le TS) après une réponse vide du modèle
        face à 601 alarmes accumulées pendant les tests de la soirée (dépassement de contexte).
- [x] **Étape 3 — ingestion RAG en Python (2026-07-17)**. Arbitrage préalable, explicitement
      tranché : le plan visait `PGVectorStore` (`langchain-postgres`), mais ce client a besoin
      d'une connexion Postgres directe — en tension avec l'invariant tenu toute la soirée
      (`ai-service` ne touche jamais la base directement). Décision : **rester 100% gateway-only**,
      pas de `PGVectorStore`. Nouvelle route `POST /api/knowledge/ingest` (gateway) — upsert pur,
      l'embedding est calculé côté Python et envoyé déjà prêt (la gateway n'a pas besoin de
      connaître le modèle d'embedding). `ai-service/ingest.py` (`uv run python ingest.py`,
      portage de `seed-knowledge-pdf.ts`) : extraction + découpage (`RecursiveCharacterTextSplitter`,
      `langchain-text-splitters`, mêmes chunk_size=1000/overlap=150), embed via Ollama en direct
      (pas par la gateway : calcul stateless, pas une donnée métier), upsert via
      `/api/knowledge/ingest`. PDF dupliqués dans `ai-service/knowledge-pdfs/` (Python est
      désormais propriétaire du pipeline RAG).
      ⚠️ **Correction en cours de route, notable** : prévu d'utiliser `PyPDFLoader`
      (`langchain_community.document_loaders`) — une recherche web juste avant disait cet import
      toujours recommandé. Mais à l'exécution : `DeprecationWarning` en direct annonçant que
      `langchain-community` a été **archivé/sunset le 19 juin 2026** (annonce du 22 mai 2026,
      [issue #674](https://github.com/langchain-ai/langchain-community/issues/674)) — la doc de
      référence trouvée par recherche web n'était simplement pas encore à jour vu la fraîcheur de
      l'annonce (~1 mois). Corrigé : extraction via `pypdf` (la lib sous-jacente que `PyPDFLoader`
      ne faisait qu'envelopper) en direct, `langchain-community` retiré des dépendances. Même
      schéma de décision que côté JS (`pdfjs-dist` en direct plutôt que `@langchain/community`
      pour `PDFLoader`) — décidé indépendamment, pour la même raison, à ~5 mois d'écart.
      Validé en live : ré-ingestion (7 chunks, 2 PDF, mêmes comptes qu'avant), `search_knowledge`
      retrouve le chunk fraîchement ré-ingéré en 1er (score 0.764) sur une question ciblée, et
      l'agent complet (`ai-service` /chat) répond correctement et de façon sourcée.
- [x] **Étape 4 — human-in-the-loop via `interrupt()` (2026-07-17)**. Remplace le `pending_action`
      fait main de `assistant.ts` par le mécanisme natif LangGraph : `_write_intercept_node`
      (`graph.py`) appelle `interrupt(payload)`, qui suspend le graphe (au lieu de le terminer)
      et renvoie le `thread_id` de la session ; `POST /confirm` reprend l'exécution exactement au
      point de suspension via `Command(resume={"confirmed": bool})`.
      Arbitrage préalable (même tension qu'à l'étape 3, encore un checkpointer voulait une
      connexion Postgres directe) : **checkpointer `InMemorySaver`**, pas `AsyncPostgresSaver` —
      constat que le `PENDING` actuel de `assistant.ts` (`new Map()`) est *déjà* purement en
      mémoire, pas persisté ; passer en mémoire côté Python n'est donc pas une régression de
      fiabilité, juste la même caractéristique (perdu si le service redémarre), et ça évite un
      nouvel accès DB direct.
      ⚠️ **Scope explicitement limité** : sur confirmation, RIEN n'est réellement exécuté (pas de
      vrai `POST /api/command`/`ack`). Raison : `ai-service` s'authentifie contre la gateway comme
      un compte de service admin (cf. étape 2), pas comme l'opérateur qui discute — or
      `/api/assistant/confirm` (TS) re-vérifie `can(user,"write",tag)` avec l'identité RÉELLE de
      qui confirme avant d'exécuter. Exécuter maintenant sous le compte admin contournerait cette
      RBAC par utilisateur — un vrai affaiblissement de sécurité sur une action d'ÉCRITURE, pas
      juste une fonctionnalité manquante. Décision explicitement validée avant implémentation :
      mécanique interrupt()/reprise construite et testée maintenant, exécution réelle repoussée à
      l'étape 6 (identité de l'opérateur transmise depuis le front rewiré, RBAC re-vérifiable pour
      de vrai). Validé en live : propose → confirme (message de simulation) ; propose → annule
      (« Action annulée ») ; re-confirmer un thread déjà traité → « rien à confirmer » (idempotent,
      même comportement one-shot que `consumePending` côté TS).
- [x] **Étape 5 — LangGraph Studio, PAS LangSmith (2026-07-17)**. LangSmith explicitement écarté :
      SaaS externe, potentiellement payant — hors de question pour un projet 100% local (même
      logique que le choix Ollama depuis le début). LangGraph Studio retenu à la place : exécution
      et données **100% locales** (`langgraph dev`, mode `--in-mem`) — seule l'UI de visualisation
      est une page web (`studio.langchain.com`) qui parle en direct au serveur local
      (`localhost:2024`) depuis le navigateur, rien ne transite par les serveurs de LangChain.
      Nuance vérifiée puis validée explicitement avec l'utilisateur avant implémentation (accepté).
      Setup : `langgraph-cli[inmem]` en **dépendance dev uniquement**
      (`[dependency-groups] dev`, PEP 735) — absent de l'image Docker de prod (`Dockerfile` fait
      `uv sync --locked` sans `--group dev`). `langgraph.json` pointe sur une instance
      module-level `graph` (`graph.py`) **sans checkpointer** : la plateforme Studio gère sa
      propre persistance et rejette un `InMemorySaver` fourni à la compilation (erreur rencontrée
      et corrigée) — `build_graph()` accepte donc un `checkpointer` optionnel, `None` pour Studio,
      `InMemorySaver()` explicite côté FastAPI (`main.py`, inchangé sinon).
      Validé en live : `langgraph dev` charge le graphe sans erreur, `POST /threads` +
      `POST /threads/:id/runs/stream` exécute réellement la boucle (tool call `get_active_batches`
      → résultat → réponse finale), chaque étape apparaît comme un événement `values` distinct —
      exactement ce que visualise l'UI Studio nœud par nœud. C'est directement ce que l'utilisateur
      voulait dès le départ de ce chantier (« je veux voir comment ça se passe mon workflow LLM »).
      Usage : `cd ai-service && uv run --group dev langgraph dev`, ouvrir l'URL Studio affichée
      dans le terminal.
- [~] **Étape 6 — front CopilotKit (2026-07-17 → 2026-07-20, 3/3 parties codées, PAS reconfirmé
      en direct après la migration v2)**. Découverte en amont, pas
      anticipée par le plan initial : CopilotKit **exige** un runtime Node/JS entre le front React
      et l'agent Python (protocole AG-UI) — ce n'est pas juste remplacer des composants front.
      Architecture retenue (validée avec l'utilisateur avant implémentation) : `web/` → runtime
      CopilotKit monté **dans la gateway existante** (pas un 4ᵉ service séparé) → `ai-service`.
      - **Partie 1 (Python, faite)** : package `copilotkit` + `ag-ui-langgraph[fastapi]`
        (versions exactes trouvées via le repo de référence officiel
        [`CopilotKit/with-langgraph-fastapi`](https://github.com/CopilotKit/CopilotKit/tree/main/examples/integrations/langgraph-fastapi),
        récupéré en brut via `curl` après que `WebFetch` résumait/paraphrasait au lieu de donner le
        code exact). `LangGraphAGUIAgent` enveloppe le `graph` déjà exposé pour Studio (étape 5),
        monté via `add_langgraph_fastapi_endpoint` sur une nouvelle route `/copilotkit`
        (`ai-service/main.py`), instance de graphe séparée (son propre `InMemorySaver`) de celle du
        SSE fait main `/chat`+`/confirm` (qui reste utilisé tel quel, inchangé). Validé en live
        (local ET Docker) : requête AG-UI brute → vraie exécution du graphe (tool call
        `get_active_batches` réel), événements protocole conformes (`RUN_STARTED`,
        `TOOL_CALL_START/END`, `STATE_SNAPSHOT`...).
      - **Partie 2 (gateway, faite — la plus incertaine)** : pas d'adaptateur Fastify officiel pour
        `@copilotkit/runtime` (seulement Next.js/Express/Nest nommément supportés) ; une issue
        GitHub documentait un adaptateur générique cassant avec un autre framework (Hono) — risque
        explicitement signalé à l'utilisateur avant de tenter. Monté quand même via
        `copilotRuntimeNodeHttpEndpoint(...)` appelé directement avec `req.raw`/`reply.raw` (Node
        `IncomingMessage`/`ServerResponse` — exactement le type que Fastify expose), `reply.hijack()`
        pour laisser le handler écrire la réponse lui-même. **Ça marche** : testé en Docker,
        401 sans session (auth `requireAuth` intacte malgré le hijack), 400 avec une erreur
        structurée du runtime CopilotKit lui-même (donc le handler tourne réellement, pas un crash
        Fastify/Hono-style). `copilotKitEndpoint({url})` utilisé (pas `langGraphPlatformEndpoint`,
        qui attend le protocole complet `langgraph_api`/`/threads`+`/runs`, différent de la route
        AG-UI custom exposée en partie 1). Effet de bord trouvé et corrigé : le runtime envoie de la
        télémétrie anonyme par défaut — désactivée (`COPILOTKIT_TELEMETRY_DISABLED=true`), cohérent
        avec le choix 100% local du projet (LangSmith explicitement écarté à l'étape 5 pour la même
        raison).
      - **Partie 3 (front React, faite en deux passes — 2026-07-20)**. 1ʳᵉ passe : bug de lecture du
        corps de requête côté gateway — Fastify bufferise TOUJOURS le corps avant d'appeler un
        content-type parser (même custom), donc `req.raw` était déjà un flux vidé quand
        `copilotRuntimeNodeHttpEndpoint` essayait de le relire lui-même ("Invalid JSON payload").
        Fix : capturer le buffer déjà lu par Fastify (`parseAs: "buffer"`) et reconstruire un flux
        rejouable (`Readable.from(buffer)` + `Object.assign` des headers/method/url) pour le handler.
        Puis mauvais appariement de protocole (`copilotKitEndpoint`/`remoteEndpoints` attend une
        découverte `/info` que notre endpoint Python n'expose pas → "No agents registered") — corrigé
        en passant à `agents: { strata_assistant: new HttpAgent(...) }` (AG-UI direct, `@ag-ui/client`).
        **Bug le plus sérieux, trouvé en testant l'acquittement d'une alarme** : `graph.py` avait déjà
        le correctif tolérant string/dict/bool pour la valeur de résolution de `interrupt()`, mais
        l'image Docker `ai-service` n'avait jamais été rebuild avec ce correctif — l'ancien code
        plantait (`AttributeError`) en plein streaming, ce qui coupait le flux vers la gateway, ce qui
        faisait planter TOUT le process Node (`unhandledRejection` non catché dans les internals
        undici de `@copilotkit/runtime`) — un bug applicatif ponctuel avait un rayon d'impact bien
        trop large. Corrigé à deux niveaux : rebuild de l'image (le vrai fix), ET ajout d'un
        `process.on("unhandledRejection", ...)` côté gateway pour qu'un souci similaire, futur, ne
        puisse plus jamais faire tomber la gateway entière.
        Retour utilisateur après un premier essai fonctionnel (v1) : bulle Inspector gênante pour un
        opérateur (désactivée, `enableInspector={false}`), onglets Threads/Learning confirmés être des
        fonctionnalités payantes (Enterprise Intelligence Platform — vérifié via recherche), onglet
        Context vide car `useCopilotReadable` jamais câblé (pas un bug). Tentative de monter
        `CopilotKitInspector` seul (composant "v2") sur le provider v1 existant → échec
        ("CopilotKit core not attached", les deux générations ne partagent pas leur contexte React).
        **Décision, à la demande explicite de l'utilisateur** : migration complète vers la génération
        "v2" du SDK (`@copilotkit/react-core/v2` pour `CopilotKit`, `CopilotChat`, `useInterrupt`,
        `CopilotKitInspector` — tout au même endroit, `@copilotkit/react-ui` désinstallé). Bénéfice
        inattendu : `useInterrupt` (v2) résout avec un OBJET (`resolve({confirmed: bool})`), pas
        juste une string comme `useLangGraphInterrupt` (v1) — correspond exactement à ce que
        `graph.py::_write_intercept_node` attendait déjà. Régression mineure assumée : les suggestions
        cliquables (chips) n'ont pas d'équivalent en prop directe sur `<CopilotChat>` v2.
        Inspecteur IA rendu accessible via un onglet dédié dans la page Admin (pas la bulle flottante).
- [x] **Étape 6bis — retour en arrière : CopilotKit → assistant-ui (2026-07-23)**. Rétrospective
      honnête demandée par l'utilisateur (déclenchée par le tableau comparatif des frontends sur
      le site LangChain) : CopilotKit n'était pas le bon choix pour Strata. Son vrai
      différenciateur (UI générative pilotée par le graphe) n'a jamais été utilisé ; toute la
      douleur de l'étape 6 (bufferisation du corps Fastify, crash gateway entier sur une
      `unhandledRejection` non catchée, confusion v1/v2 du SDK) venait spécifiquement de sa
      couche runtime Node — un problème qu'assistant-ui n'a pas, car il parle directement le
      protocole natif LangGraph Platform (`/threads`, `/runs/stream`) au lieu de traduire en AG-UI.
      Décision, chantier complet en une session :
      - **`ai-service`** : `copilotkit`/`ag-ui-langgraph` désinstallés ; `main.py` réduit à
        `/health` + `/ingest/pdf` ; le chat passe désormais par le serveur `langgraph dev` natif
        lui-même (monté via `langgraph.json` → `"http": {"app": "./main.py:app"}`), qui gère sa
        propre persistance (checkpointer in-mem). `graph.py` : nouveau nœud `_init_node`
        inconditionnel en tête de graphe qui calcule `factory_context`/`recipes` lui-même — le
        protocole standard parlé par assistant-ui n'a aucun moyen d'injecter des champs d'état
        custom à l'entrée (contrairement à l'ancien `/chat` fait main qui les posait directement).
      - **`gateway`** : `@copilotkit/runtime`/`@ag-ui/client` et toute la mécanique de rejeu du
        corps de requête (`parseAs:"buffer"` + `Readable.from`) supprimés — remplacés par un
        reverse-proxy `@fastify/http-proxy` (`/api/langgraph` → `ai-service`, `preHandler:
        requireAuth`), qui n'a tout simplement pas cette classe de bug. Le garde-fou
        `process.on("unhandledRejection", ...)` gardé (généralisé, utile indépendamment du
        runtime front). ~40 paquets installés au lieu des ~285 de CopilotKit.
      - **`web`** : `@copilotkit/react-core` retiré ; `@assistant-ui/react` +
        `@assistant-ui/react-langgraph` + `@langchain/langgraph-sdk` installés. Nouveau
        `web/src/lib/chatApi.ts` (client SDK partagé). `AssistantView.tsx` réécrit avec les
        primitives assistant-ui (`ThreadPrimitive`/`MessagePrimitive`/`ComposerPrimitive`) ;
        confirmation d'écriture via `useLangGraphInterruptState`/`useLangGraphSendCommand`
        (`sendCommand({resume:"yes"|"no"})`, déjà compatible avec le parsing tolérant existant de
        `_write_intercept_node`, aucun changement graphe nécessaire).
      - ⚠️ **4 bugs réels trouvés uniquement en testant en direct dans le navigateur** (le
        typecheck ne les voyait pas) :
        1. Le SDK LangGraph fait `new URL(apiUrl + path)` sans base — un `apiUrl` relatif
           (`/api/langgraph`) fait planter le constructeur `URL` dans un navigateur (pas de repli
           sur `window.location` comme le ferait `fetch`). Fixé en construisant une URL absolue
           same-origin (`window.location.origin + "/api/langgraph"`).
        2. Le callback `stream` fait main utilisait `remoteId` (retourné par `initialize()`) au
           lieu d'`externalId` — `remoteId` est un identifiant de bookkeeping interne à
           assistant-ui (pas un UUID), pas le vrai thread LangGraph, d'où un
           `HTTP 400: badly formed hexadecimal UUID string` côté serveur. Fixé en utilisant le
           helper officiel `unstable_createLangGraphStream({client, assistantId})` d'assistant-ui,
           qui utilise correctement `externalId`.
        3. Le composant `Text` par défaut d'assistant-ui affiche un curseur "●" statique (non
           animé) pendant la génération — remplacé par un composant `Text` custom avec 3 points
           animés (`MessagePartPrimitive.InProgress`).
        4. **Fil de conversation perdu à chaque changement d'onglet.** Cause : sans backend
           "cloud" assistant-ui réel, `useLangGraphRuntime` retombe sur un
           `InMemoryThreadListAdapter` — toute la liste de threads (pas juste l'id) vit en mémoire
           React et est détruite dès que le composant qui l'a montée est démonté. Un premier
           correctif (persister le `threadId` seul via `sessionStorage` + `onThreadIdChange`) n'a
           pas suffi pour cette raison. Fix réel : `useLangGraphRuntime`/`AssistantRuntimeProvider`
           déplacés dans `Layout.tsx` (montés une seule fois, enveloppent `<Outlet/>`, jamais
           démontés à la navigation) — exactement l'architecture que CopilotKit utilisait déjà,
           `AssistantView.tsx` ne fait plus que consommer le contexte ambiant.
      - **Nettoyage du code mort découvert au passage** : `gateway/src/assistant.ts` (~980 lignes,
        l'agent TS maison v1-v4 originel, « Chemin B » de la section précédente) montait encore
        `/api/assistant/chat`+`/confirm`+`/cancel` mais plus rien dans `web/` ne les appelait —
        supprimé entièrement. Seule sa fonction `embed()` était encore utilisée (par
        `/api/knowledge/search`, le RAG) : extraite dans un nouveau `gateway/src/embeddings.ts`.
        Onglet "Inspecteur IA" (AG-UI, étape 6/7) retiré d'`AdminView.tsx` — pas d'équivalent
        assistant-ui décidé, question ouverte pour plus tard (ex. lien direct vers LangGraph
        Studio, déjà exposé en dev depuis l'étape 5).
        ⚠️ Note pour une future « étape 6 réelle » (exécution effective des actions confirmées) :
        `assistant.ts` contenait la seule implémentation existante d'exécution réelle avec
        re-vérification RBAC par le VRAI utilisateur (`/api/assistant/confirm` : `can(user,
        "write", tag)`) — supprimée avec le reste. Récupérable via l'historique git si besoin de
        référence, mais l'implémentation finale devra de toute façon vivre dans `ai-service`
        (identité opérateur à faire transiter depuis le front, cf. avertissement en tête de
        `graph.py`), pas être ressuscitée telle quelle.
      Validé en direct par l'utilisateur : chat + streaming normal, cycle interrupt/confirmation
      d'écriture (acquittement d'alarme), et persistance de la conversation à la navigation entre
      pages. Gateway redémarré proprement après le nettoyage ; `/api/knowledge/search` re-testé et
      toujours fonctionnel après extraction d'`embed()`.
- [x] **Étape 7 — page Admin « Base de connaissances » (2026-07-20)**. Remplace le script CLI
      (`ai-service/ingest.py`, lancé à la main) par une vraie interface : liste des documents,
      statut d'embedding, upload. `ai-service/ingest.py` refactorisé — `ingest_pdf_bytes(filename,
      data: bytes)` réutilisable depuis le CLI (lit le disque) ET une nouvelle route
      `POST /ingest/pdf` (reçoit `{filename, content_base64}`, décode, même pipeline). Nouvelles
      routes gateway : `GET /api/knowledge` (liste groupée par document — `regexp_replace` sur le
      titre pour retirer le suffixe " — chunk i/N" posé par `ingest.py`, PAS de migration de schéma ;
      les entrées manuelles de `seed-knowledge.ts`, sans ce suffixe, s'affichent comme leur propre
      document à 1 chunk) et `POST /api/knowledge/upload` (relaie le PDF à `ai-service`, la gateway
      ne fait que transporter les octets — même invariant que `/api/copilotkit`). Upload : PDF lu
      côté navigateur (`FileReader.readAsDataURL` → base64), pas de multipart — même convention que
      `importTagsCsv` pour le CSV (aucune dépendance multipart ajoutée à la gateway). Onglet "Base de
      connaissances" dans `AdminView.tsx` (5ᵉ onglet, aux côtés d'Utilisateurs/Rôles/Audit/Inspecteur
      IA). Validé en live à chaque couche : `ingest_pdf_bytes` direct (4 chunks), `/api/knowledge/
      upload` via la gateway (4 chunks), `/api/knowledge` (24 documents, bon regroupement 2 PDF + 22
      entrées manuelles), et `search_knowledge` retrouve le document fraîchement uploadé en 1ʳᵉ
      position (score 0.764) — le pipeline RAG complet, de l'upload à la recherche, fonctionne
      bout-en-bout. PDF de test nettoyés après chaque vérification (pas des données de démo).
      **Ajout (même session)** : le PDF original disparaissait après ingestion (seuls les chunks de
      texte/embeddings étaient conservés) — aucun moyen de reconsulter le document source. Nouvelle
      table `knowledge_files` (`bytea`, clé `(category, doc_name)`) : la gateway conserve le fichier
      reçu EN PLUS de le relayer à `ai-service` pour l'ingestion (`ai-service` ne stocke jamais rien
      après ingestion — seule la gateway a une base à écrire dedans, même invariant que tout le
      chantier). Nouvelle route `GET /api/knowledge/:category/:docName/file` (affichage inline,
      `Content-Disposition: inline`) ; bouton "Ouvrir le PDF" dans l'onglet, visible seulement quand
      `has_file` (LEFT JOIN dans `/api/knowledge`) — les entrées manuelles n'ont jamais de fichier.
      Les 2 PDF de démo ingérés avant cet ajout ont été ré-uploadés pour combler leur fichier
      manquant. Validé : fichier téléchargé via la route est byte-à-byte identique à l'original
      (`diff`), bon `Content-Type`/`Content-Disposition`.

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

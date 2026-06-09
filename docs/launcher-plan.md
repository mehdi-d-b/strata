# Strata — Launcher / superviseur desktop (plan)

> Document de planification (pas d'implémentation). Cadre le **launcher** : une
> application desktop **hors Docker** qui orchestre le stack Strata. Décide la
> techno (Tauri), l'architecture, et surtout **la frontière entre ce qui va dans
> le site web et ce qui va dans le launcher**. À coder plus tard (confort de
> déploiement, pas bloquant). Roadmap : section « Déploiement / prod ».

## 1. Le problème : il manque une couche « en amont » de Docker

Aujourd'hui, lancer Strata = taper des commandes (`docker compose --profile … up`).
Quatre limites réelles, toutes dues à l'**absence d'un composant hors Docker** :

1. **CLI obligatoire** (pénible avec les profils plc4x/risingwave) — il faudrait des
   cases à cocher.
2. **Pas de vérif des prérequis** : rien ne dit « Docker n'est pas installé/lancé ».
   *Seul* un composant hors Docker peut le détecter.
3. **Pas de contrôle du lieu d'exécution** : on lance depuis un terminal WSL. Un client
   voudrait lancer depuis Windows sans se prendre la tête, ou cibler un **serveur
   distant** (possible via Docker context).
4. **Pas de recul pour débugger** : l'appli est *dans* Docker → si Docker plante, elle
   ne peut pas s'afficher pour le montrer (**le paradoxe du « down qui se cache »**).

→ Ces 4 points ne sont pas 4 gadgets : c'est **un seul composant**, un
**launcher/superviseur** qui orchestre le stack depuis l'extérieur. C'est le chaînon
entre « projet de dev lancé au terminal » et « produit qu'on installe ».

## 2. Techno : **Tauri** (vs Electron / Python)

| Critère | **Tauri** ✅ | Electron | Python (PyInstaller + UI) |
|---|---|---|---|
| Poids binaire | ~3-10 Mo (webview système) | ~150 Mo (Chromium embarqué) | ~30-50 Mo |
| RAM | légère | lourde | moyenne |
| Multi-OS | ✅ natif | ✅ | ✅ (packaging pénible) |
| Accès système (Docker, FS) | ✅ backend **Rust** | ✅ (Node) | ✅ |
| Réutiliser le front React/shadcn | ✅ (webview = on fait du React) | ✅ | ❌ (autre UI) |

**Choix : Tauri.** Raisons :
- On **réutilise le savoir-faire front** (React/Vite/shadcn) pour l'UI du launcher — pas de
  nouvelle stack UI à apprendre. ⚠️ Nuance : le launcher est une **app distincte**, il
  **n'embarque pas l'app web en cours** et ne partage pas ses tokens de design (qui vivent dans
  `web/`, source unique — cf. Phase 10). Il aura donc **son propre style** (esprit shadcn pour
  rester cohérent, mais pas l'identité visuelle de l'app, sauf à extraire un jour les tokens dans
  un package partagé). En v1 : style propre et léger.
- Binaire **minuscule** (webview système, pas de Chromium) → cohérent avec la ligne
  « léger, sans JVM » de Strata.
- Backend **Rust** pour parler à Docker / au système : peu de code (lancer des commandes,
  lire des statuts), et cohérent avec l'écosystème (Redpanda, RisingWave sont en Rust).

Seul coût : écrire le petit backend Rust (commandes Docker + statuts). Modeste.

**Build & cible OS.** `tauri build` produit **un bundle par OS** (`.msi`/`.exe` Windows,
`.dmg`/`.app` macOS, `.deb`/`.AppImage` Linux). À l'exécution, l'OS est **connu** (Rust
`std::env::consts::OS` / `cfg!(target_os)`) — donc « sur quel OS tourne-t-on » n'est **jamais**
la difficulté. La difficulté est **où se trouve le démon Docker** *dans* cet OS (voir §6). Note
de cross-build : on peut développer/valider en bundle **Linux** depuis WSL ; produire le `.exe`
**Windows** (la cible cliente réelle) demande un build sur/pour Windows (cross-compilation Tauri
pénible) — étape de packaging ultérieure, pas un prérequis pour coder la logique.

## 3. Architecture (out-of-band)

```
┌──────────────────────────────────────────────┐
│  LAUNCHER (Tauri, HORS Docker)                │
│  UI React  ──cmd──►  backend Rust             │
│                        │                       │
│                        ├─ vérifie prérequis (docker présent ? démarré ?)
│                        ├─ docker compose up/down (+ profils cochés)
│                        ├─ lit l'état des containers (docker ps / events)
│                        ├─ backup/restore des volumes
│                        └─ ouvre le navigateur sur l'appli web
└────────────────────────┬─────────────────────┘
                         │ pilote
              ┌──────────▼───────────┐
              │   Docker (le stack    │   ← l'appli web/gateway/… tourne ICI (in-band)
              │   Strata habituel)    │
              └───────────────────────┘
```

Le launcher **ne contient pas de logique métier** : il orchestre l'infra. L'appli web
reste la seule à manipuler les **données** (via la gateway + RBAC).

## 4. ⚠️ La frontière à NE PAS franchir : web (in-band) vs launcher (out-of-band)

**LE point d'architecture de ce document.** Règle :

> **Le site web gère les DONNÉES MÉTIER (in-band). Le launcher gère le CYCLE DE VIE
> DE L'INFRA (out-of-band).**

| Va dans le **site web** (in-band) | Va dans le **launcher** (out-of-band) |
|---|---|
| Tags, dashboards, alarmes, utilisateurs | Start / stop du stack, choix des profils |
| Export / import de config **métier** (CSV…) | **Backup / restore** des volumes Docker |
| Production, écriture de consignes | Vérif des prérequis (Docker présent/démarré ?) |
| Tout ce qui a besoin du **RBAC** | État *réel* des containers, logs infra, update d'images |

**Mnémotechnique** : si l'opération doit **survivre à « l'appli est down »**, c'est le
launcher. Si elle a besoin de **l'auth/RBAC**, c'est le web.

**Exemple qui a motivé cette règle — le backup** : sauvegarder un volume Docker, c'est
toucher Docker lui-même (arrêt propre → copie du volume → redémarrage). L'appli web **ne
peut pas** sauvegarder le volume qui la fait tourner pendant qu'elle tourne. Donc
backup/restore = **launcher**. Mettre ça dans le web serait un anti-pattern (l'appli
sauvegarde le sol sous ses pieds).

**Piège à éviter** (signalé par Mehdi) : la tentation de tout sortir dans le launcher OU
tout garder dans le web. Non — appliquer la règle ci-dessus au cas par cas.

## 5. Périmètre proposé

**v1 (MVP utile) :**
- [ ] Détection des prérequis : Docker installé ? démarré ? (message clair sinon)
- [ ] Écran de lancement : cases à cocher des **profils** (plc4x, risingwave) → génère le
      bon `docker compose --profile … up -d`
- [ ] Voyants d'état des containers à **3 états** (down / **starting** / healthy), basés sur le
      **healthcheck** Docker (pas seulement `docker ps` : *running* ≠ *ready*, cf. §6)
- [ ] Boutons Start / Stop / Logs
- [ ] Ouvre le navigateur sur **le front de prod** (nginx/Caddy, cf. roadmap). En mode dev
      uniquement, l'URL Vite `http://localhost:5173` ; en produit livré ce port **n'existe pas**

**v2 (confort / produit) :**
- [ ] Backup / restore des volumes (timescale-data, redpanda-data, risingwave-data)
- [ ] Cibler un **hôte distant** (Docker context) — installer/piloter Strata sur un serveur
- [ ] Mise à jour des images (pull + recreate)
- [ ] Première config guidée (mot de passe admin, .env)

## 6. Pièges d'implémentation (cadrage technique avant de coder)

Le plan ci-dessus minimise 4 difficultés réelles. Le risque d'ingénierie n'est **pas l'UI**,
il est dans ces points :

1. **Détecter le démon Docker, de façon portable** — *le vrai point dur*. L'OS est connu (§2),
   mais **où parler à Docker** varie : socket Unix (`/var/run/docker.sock`) sous Linux, **named
   pipe** (`//./pipe/docker_engine`) sous Windows, Docker Desktop **dans WSL2**, ou un **hôte
   distant** (Docker context). **Principe directeur** : on **auto-détecte le cas courant** (socket
   par défaut de l'OS), et **tout ce qui n'est pas détectable de façon fiable → on demande à
   l'utilisateur** (champ « hôte / contexte Docker », avec valeur par défaut + bouton « tester la
   connexion »). Pas de magie fragile : auto si possible, **fallback explicite** sinon.

2. **« Running » ≠ « Ready ».** `docker ps` dit *up*, pas *healthy* — un container peut tourner
   sans accepter de connexions (Timescale au boot). Le compose a déjà des **healthchecks** (P0) :
   les voyants doivent refléter l'**état de santé** (down / starting / healthy), pas la simple
   présence. Lire `docker inspect`/`compose ps` pour le `Health`.

3. **Réutilisation front = savoir-faire, pas l'app.** Le launcher est une **app distincte**
   (cf. §2) → **style propre**. Ne pas promettre l'identité visuelle de l'app web sans extraire
   les tokens (`web/`) dans un package partagé — sinon duplication.

4. **URL d'ouverture = front de prod, pas le port dev.** `5173` est Vite (dev) ; en produit livré
   il n'existe pas. Le launcher ouvre le **front de prod** (nginx/Caddy). Garder le port dev
   *seulement* en mode développement.

**Launcher = orchestrateur, PAS installeur.** Il **détecte** et **guide** (« Docker n'est pas
installé/démarré → voici comment faire »), mais il **n'installe pas Docker** lui-même (poser
Docker Desktop par-dessus est fragile et hors périmètre). « Vérifier les prérequis » = *diagnostiquer
et orienter*, pas *réparer*.

## 7. Quand le faire / priorité

- **Pas prioritaire** : le stack fonctionne ; c'est du confort de déploiement/packaging.
- **Déclencheur** : quand Strata doit être **installé par un non-tech** ou **livré comme
  produit** (pas juste lancé en dev). À ce moment, ce launcher + un front de prod
  (nginx/Caddy, cf. roadmap) forment le « kit d'installation ».
- **Indépendant du reste** : nouveau composant, ne touche ni la gateway ni le web existant.
  Peut être fait dans un repo/dossier séparé (`launcher/`) ou un chat dédié.

## 8. Lien avec le reste

- **Front de prod** (roadmap, Déploiement) : le launcher *ouvre* l'appli ; le service
  nginx/Caddy *sert* l'appli. Complémentaires.
- **`/api/system`** (in-band) : montre ce que la gateway voit de l'intérieur ; le launcher
  montre ce que Docker voit de l'extérieur. Les deux, pas l'un contre l'autre.

## 9. Distribution : du repo cloné au « .exe + images »

**Question clé** : faut-il cloner tout le repo pour lancer Strata, ou un simple `.exe` de
launcher suffit-il ? Cible visée : **le .exe seul** (l'utilisateur ne télécharge que ça).

### Pourquoi aujourd'hui le repo est nécessaire
Le `docker-compose.yml` actuel dépend du repo de deux façons :
1. **Services construits depuis les sources** (`build:`) → il faut le code : `gateway`,
   `simulator`, `kafka-connect` (profil plc4x), et bientôt `web` en prod.
2. **Fichiers de config montés** (bind mounts) → il faut ces fichiers : init SQL
   (`infra/timescale/init`), `infra/mosquitto/mosquitto.conf`, les 3 `connectors/*.yaml`.

Tout le reste (redpanda, console, timescale, mosquitto, redpanda-connect, risingwave) est
déjà des **images publiques pures**.

### Le bon modèle mental
> Ce qu'on **livre** n'est pas le *code source*, ce sont des **images** (le code déjà
> compilé) + un **compose** + la **config**. Le source ne sert qu'à *fabriquer* les images.

Une fois les images publiées sur un **registry** (Docker Hub, GHCR…), la machine cliente
n'a plus besoin des sources : elle **pull** les images.

### Deux modèles (les deux = .exe-only)
- **Modèle A — tout en images, le .exe ne porte QUE le compose** *(le plus pur)* : on publie
  `strata-gateway`/`strata-simulator`/`strata-web`… ; on **cuit la config statique dans les
  images** (init SQL `COPY`é dans une image timescale custom, conf mosquitto, YAML connecteurs) ;
  le **compose de prod** ne contient que des `image:` + volumes + env (petit fichier). Le
  launcher **embarque ce compose** (ressource Tauri), l'écrit, `docker compose up` → pull.
- **Modèle B — le launcher embarque un petit « runtime »** *(pragmatique)* : images
  pré-construites pour le code, **mais** la config reste des fichiers que le launcher **bundle**
  (compose + `infra/` + `connectors/`) et extrait dans un dossier applicatif au 1er lancement.
  Config éditable, gérée par le launcher ; sources jamais nécessaires.

**Reco** : Modèle A pour la config statique (init SQL, mosquitto, connecteurs) + garder **un
seul fichier externe, le `.env`**, généré par le launcher (cf. §10).

### Ce que ça demande
1. **Registry + CI** qui build & push les images custom à chaque version (`strata-gateway:1.0`…).
2. **`docker-compose.prod.yml`** avec des `image:` (sans `build:` ni bind mounts) ; le dev garde
   le compose actuel avec `build:` → pattern **dev compose / prod compose**.
3. **`.env`** = seule chose propre à chaque install → la « config guidée » du launcher (§10).
   Le compose est déjà prêt (`${VAR:-défaut}`), un `.env` écrit par le launcher suffit.
4. Le launcher **embarque le compose de prod** + génère le `.env` + `up`.

### Variante usine sans internet (air-gapped)
Pas de pull possible → livrer les images en **tarballs** (`docker save`/`load`). Le launcher
peut charger un pack d'images local. Même modèle, source d'images différente.

## 10. Éditeur de config dans le launcher : oui, mais lequel ?

Un **éditeur de `.env` dans le launcher = au bon endroit** : le `.env` (mots de passe
Timescale, `ADMIN_PASSWORD` initial) est nécessaire **pour démarrer** le stack → il vit *quand
l'appli est down* → **out-of-band**. C'est la « première config guidée » (v2). À présenter en
**formulaire de clés connues** (champs mot de passe…), pas un éditeur de texte brut — moins de
pièges, comme le principe « pas de SQL arbitraire » de l'onglet Stockage.

**Mais « un GUI sur la config » dépend de QUELLE config** — la frontière in/out-of-band tranche :

| Config | Où | Pourquoi |
|---|---|---|
| `.env` (secrets, identifiants DB, admin initial) | **launcher** | gate le démarrage, secret, app down |
| profils, machine cible, ports | **launcher** | cycle de vie infra |
| **tags, automates, dashboards, alarmes, users, rétention** | **app web (déjà fait)** | stocké en base, **RBAC + audit**, « données sur l'usine » |

⚠️ **Piège à documenter dans l'UI** : certaines valeurs du `.env` n'agissent **qu'au premier
boot**. `ADMIN_PASSWORD` ne *seed* le compte admin qu'une fois (ensuite : changement de mot de
passe **dans l'app**, in-band). Changer `TIMESCALE_PASSWORD` après l'init du volume casse la
connexion tant que la base n'est pas mise à jour. L'éditeur doit donc **avertir** : « ces
réglages s'appliquent surtout à la première installation ». Le launcher pose le *bootstrap* ;
la gestion courante des comptes reste **dans l'app web**.

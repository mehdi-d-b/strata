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
- On **réutilise l'écosystème front** (React/Vite/shadcn, le design system existant) pour
  l'UI du launcher — pas de nouvelle stack UI à apprendre.
- Binaire **minuscule** (webview système, pas de Chromium) → cohérent avec la ligne
  « léger, sans JVM » de Strata.
- Backend **Rust** pour parler à Docker / au système : peu de code (lancer des commandes,
  lire des statuts), et cohérent avec l'écosystème (Redpanda, RisingWave sont en Rust).

Seul coût : écrire le petit backend Rust (commandes Docker + statuts). Modeste.

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
- [ ] Voyants d'état des containers (vert/rouge), via `docker ps` / events
- [ ] Boutons Start / Stop / Logs
- [ ] Ouvre le navigateur sur l'appli (http://localhost:5173 ou le front de prod)

**v2 (confort / produit) :**
- [ ] Backup / restore des volumes (timescale-data, redpanda-data, risingwave-data)
- [ ] Cibler un **hôte distant** (Docker context) — installer/piloter Strata sur un serveur
- [ ] Mise à jour des images (pull + recreate)
- [ ] Première config guidée (mot de passe admin, .env)

## 6. Quand le faire / priorité

- **Pas prioritaire** : le stack fonctionne ; c'est du confort de déploiement/packaging.
- **Déclencheur** : quand Strata doit être **installé par un non-tech** ou **livré comme
  produit** (pas juste lancé en dev). À ce moment, ce launcher + un front de prod
  (nginx/Caddy, cf. roadmap) forment le « kit d'installation ».
- **Indépendant du reste** : nouveau composant, ne touche ni la gateway ni le web existant.
  Peut être fait dans un repo/dossier séparé (`launcher/`) ou un chat dédié.

## 7. Lien avec le reste

- **Front de prod** (roadmap, Déploiement) : le launcher *ouvre* l'appli ; le service
  nginx/Caddy *sert* l'appli. Complémentaires.
- **`/api/system`** (in-band) : montre ce que la gateway voit de l'intérieur ; le launcher
  montre ce que Docker voit de l'extérieur. Les deux, pas l'un contre l'autre.

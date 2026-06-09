# launcher/ — superviseur desktop Strata (Tauri)

App **hors Docker** qui orchestre le stack Strata : vérifie les prérequis Docker,
coche les profils (`plc4x`, `risingwave`), démarre/arrête le stack, montre l'état
**de santé** des containers, ouvre l'appli. Plan & frontière d'archi :
[docs/launcher-plan.md](../docs/launcher-plan.md).

> **Règle d'or** : le launcher gère le **cycle de vie de l'infra** (out-of-band).
> Les **données métier** (tags, alarmes, users…) restent dans l'appli web (in-band,
> via la gateway + RBAC). Ex : un backup de volume = launcher ; éditer un tag = web.

## Stack technique
- **Tauri v2** : webview système (binaire léger) + backend **Rust**.
- Front **React + Vite + TS** (style propre au launcher, pas les tokens de `web/`).
- Le backend **shelle le CLI `docker`** : c'est lui qui résout l'emplacement du démon
  (socket Unix / named pipe Windows / Docker Desktop-WSL2 / hôte distant via
  `docker context`). Le launcher constate juste « docker présent + démon joignable ».

## Prérequis de dev
- Rust (`cargo`), Node (`npm`), et les deps système Tauri (sous Linux :
  `webkit2gtk-4.1`, `libgtk-3`, `librsvg`, `libayatana-appindicator`).
- CLI Tauri : `npm i` l'installe en devDependency (`npm run tauri`).

## Lancer en dev
```bash
cd launcher
npm install
npm run icons      # génère les icônes PNG de remplacement
npm run tauri dev  # build Rust + ouvre la fenêtre (WSL : nécessite WSLg)
```
Dossier projet par défaut : variable `STRATA_DIR` (sinon le cwd, ou saisi dans l'UI).

## Build (bundles par OS)
```bash
npm run tauri build   # .deb/.AppImage (Linux), .dmg (macOS), .msi/.exe (Windows)
```
> Le bundle se fait **par OS** : produire le `.exe` Windows demande un build
> sur/pour Windows (cross-compilation Tauri pénible). Depuis WSL on valide en Linux.

## Commandes backend (Rust → front)
Toutes prennent un `context` optionnel (nom de contexte Docker = **hôte distant**).

| Commande | Rôle |
|---|---|
| `detect_docker` | client installé ? démon joignable ? version + contexte |
| `list_contexts` | contextes Docker disponibles (hôtes) |
| `default_project_dir` | `STRATA_DIR` ou cwd |
| `compose_ps` | services + **santé** (healthy/starting/unhealthy/running/down) |
| `compose_up(profiles)` | `docker compose --profile … up -d` |
| `compose_down(profiles)` | down de **tous** les profils + `--remove-orphans` (stop complet) |
| `compose_logs(service, tail)` | snapshot de logs (le front boucle pour « suivre ») |
| `update_images(profiles)` | `pull` puis recrée le stack (`up -d`) |
| `list_volumes` | volumes Docker du projet |
| `backup_volume(volume, dest)` | tar.gz du volume via un container alpine éphémère |
| `restore_volume(volume, archive)` | vide puis ré-extrait (stack arrêté de préférence) |
| `open_app(url)` | ouvre le navigateur (front de prod ; `5173` = dev only) |

## UI : deux onglets
- **Pilotage** : prérequis Docker, hôte (contexte), dossier projet, profils, start/stop/
  refresh/ouvrir, table de santé des services.
- **Maintenance** : logs (filtre par service + suivi), mise à jour des images,
  sauvegarde/restauration des volumes.

## État
**v1 + v2 (fonctionnels)** : détection Docker, profils, start/stop, santé, ouverture appli,
**logs**, **hôte distant** (contexte), **update d'images**, **backup/restore volumes**.
Reste (polish/produit) : packaging en exécutable (`tauri build` + vraies icônes),
première config guidée (`.env` / mot de passe admin), logs en vrai streaming.

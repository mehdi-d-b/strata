// Strata Launcher — backend Tauri (orchestrateur d'infra, HORS Docker).
//
// Principe : on shelle le CLI `docker`. Le CLI résout DÉJÀ l'emplacement du démon
// (socket Unix, named pipe Windows, Docker Desktop/WSL2, ou hôte distant via
// `docker context`). Le launcher n'a donc qu'à constater « docker présent + démon
// joignable », et le reste de la portabilité est gratuit. Tout ce qui n'est pas
// détectable de façon fiable est laissé à l'utilisateur (champ « dossier projet »).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
struct DockerStatus {
    installed: bool,
    daemon_running: bool,
    client_version: Option<String>,
    server_version: Option<String>,
    context: Option<String>,
    message: String,
}

#[derive(Serialize)]
struct ServiceStatus {
    service: String,
    state: String,
    health: String,
}

/// Lance `docker <args>` (option : dans un répertoire). Ok(stdout) / Err(stderr|erreur).
fn docker(args: &[&str], cwd: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new("docker");
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    match cmd.output() {
        Ok(out) if out.status.success() => {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
        Ok(out) => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        Err(e) => Err(format!("docker introuvable ({e})")),
    }
}

#[tauri::command]
async fn detect_docker() -> DockerStatus {
    // Présence du client : `docker --version` n'a pas besoin du démon.
    let client = docker(&["--version"], None);
    let installed = client.is_ok();
    let client_version = client.ok().map(|s| s.replace("Docker version ", ""));

    // Démon joignable : `docker info` échoue si le démon est arrêté/inaccessible.
    let server = docker(&["info", "--format", "{{.ServerVersion}}"], None);
    let daemon_running = server.is_ok();
    let server_version = server.ok();

    let context = docker(&["context", "show"], None).ok();

    let message = if !installed {
        "Docker n'est pas installé (ou absent du PATH). Installez Docker Desktop puis relancez."
            .to_string()
    } else if !daemon_running {
        "Docker est installé mais le démon n'est pas joignable. Démarrez Docker Desktop, \
         ou vérifiez le contexte (champ projet / `docker context`)."
            .to_string()
    } else {
        "Docker est prêt.".to_string()
    };

    DockerStatus { installed, daemon_running, client_version, server_version, context, message }
}

/// Dossier projet par défaut : variable STRATA_DIR si fournie, sinon le cwd.
#[tauri::command]
fn default_project_dir() -> String {
    if let Ok(dir) = std::env::var("STRATA_DIR") {
        return dir;
    }
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Mappe l'état brut Docker vers un voyant à 3+ états (running ≠ ready).
fn health_of(state: &str, health: &str) -> String {
    match health {
        "healthy" => "healthy",
        "starting" => "starting",
        "unhealthy" => "unhealthy",
        // Pas de healthcheck déclaré : on retombe sur l'état brut.
        _ => match state {
            "running" => "running",
            "" => "unknown",
            _ => "down",
        },
    }
    .to_string()
}

#[tauri::command]
async fn compose_ps(project_dir: String) -> Result<Vec<ServiceStatus>, String> {
    // `--format json` : selon la version de Compose, soit un tableau JSON, soit
    // du NDJSON (un objet par ligne). On gère les deux.
    let raw = docker(&["compose", "ps", "--all", "--format", "json"], Some(&project_dir))?;
    let mut out = Vec::new();

    let push = |out: &mut Vec<ServiceStatus>, v: &serde_json::Value| {
        let service = v
            .get("Service")
            .and_then(|x| x.as_str())
            .or_else(|| v.get("Name").and_then(|x| x.as_str()))
            .unwrap_or("?")
            .to_string();
        let state = v.get("State").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let health = v.get("Health").and_then(|x| x.as_str()).unwrap_or("");
        out.push(ServiceStatus { service, health: health_of(&state, health), state });
    };

    if let Ok(serde_json::Value::Array(arr)) = serde_json::from_str::<serde_json::Value>(&raw) {
        for v in &arr {
            push(&mut out, v);
        }
    } else {
        for line in raw.lines().filter(|l| !l.trim().is_empty()) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                push(&mut out, &v);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
async fn compose_up(project_dir: String, profiles: Vec<String>) -> Result<String, String> {
    let mut args: Vec<String> = vec!["compose".into()];
    for p in &profiles {
        args.push("--profile".into());
        args.push(p.clone());
    }
    args.push("up".into());
    args.push("-d".into());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    docker(&refs, Some(&project_dir)).map(|_| "Stack démarré.".to_string())
}

// `down` reçoit TOUS les profils connus (pas seulement les cochés) : sinon les
// services de profils non activés ne sont pas arrêtés et bloquent le réseau.
// `--remove-orphans` nettoie les containers restés d'une config précédente.
#[tauri::command]
async fn compose_down(project_dir: String, profiles: Vec<String>) -> Result<String, String> {
    let mut args: Vec<String> = vec!["compose".into()];
    for p in &profiles {
        args.push("--profile".into());
        args.push(p.clone());
    }
    args.push("down".into());
    args.push("--remove-orphans".into());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    docker(&refs, Some(&project_dir)).map(|_| "Stack arrêté.".to_string())
}

/// Ouvre une URL dans le navigateur par défaut. Sous Linux/WSL, `xdg-open` n'est
/// pas toujours là : on tente plusieurs ouvreurs (dont `wslview`, qui ouvre le
/// navigateur Windows depuis WSL).
#[cfg(target_os = "linux")]
#[tauri::command]
fn open_app(url: String) -> Result<(), String> {
    let candidates: [(&str, &[&str]); 5] = [
        ("xdg-open", &[]),
        ("wslview", &[]),
        ("gio", &["open"]),
        ("sensible-browser", &[]),
        ("x-www-browser", &[]),
    ];
    for (prog, pre) in candidates {
        let mut args: Vec<&str> = pre.to_vec();
        args.push(&url);
        if Command::new(prog).args(&args).spawn().is_ok() {
            return Ok(());
        }
    }
    Err("aucun ouvreur de navigateur trouvé — installez `xdg-utils`, ou `wslu` \
         (wslview) pour ouvrir le navigateur Windows depuis WSL"
        .to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn open_app(url: String) -> Result<(), String> {
    Command::new("open")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("impossible d'ouvrir le navigateur ({e})"))
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn open_app(url: String) -> Result<(), String> {
    Command::new("cmd")
        .args(["/C", "start", "", &url])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("impossible d'ouvrir le navigateur ({e})"))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            detect_docker,
            default_project_dir,
            compose_ps,
            compose_up,
            compose_down,
            open_app
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri");
}

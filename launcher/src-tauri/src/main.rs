// Strata Launcher — backend Tauri (orchestrateur d'infra, HORS Docker).
//
// Principe : on shelle le CLI `docker`. Le CLI résout DÉJÀ l'emplacement du démon
// (socket Unix, named pipe Windows, Docker Desktop/WSL2) et, via `--context`, un
// hôte DISTANT. Le launcher n'a donc qu'à constater « docker présent + démon
// joignable » et à passer un éventuel contexte. Tout ce qui n'est pas détectable
// de façon fiable est laissé à l'utilisateur (dossier projet, contexte).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

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

/// Lance `docker [--context CTX] <args>` (option : dans un répertoire).
fn docker(context: Option<&str>, args: &[&str], cwd: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new("docker");
    if let Some(ctx) = context {
        if !ctx.is_empty() {
            cmd.args(["--context", ctx]);
        }
    }
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    match cmd.output() {
        Ok(out) if out.status.success() => {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if err.is_empty() { "échec de la commande docker".into() } else { err })
        }
        Err(e) => Err(format!("docker introuvable ({e})")),
    }
}

/// Construit les arguments compose avec les profils : `compose --profile a … <sub…>`.
fn compose_args(profiles: &[String], sub: &[&str]) -> Vec<String> {
    let mut args: Vec<String> = vec!["compose".into()];
    for p in profiles {
        args.push("--profile".into());
        args.push(p.clone());
    }
    args.extend(sub.iter().map(|s| s.to_string()));
    args
}

fn as_refs(v: &[String]) -> Vec<&str> {
    v.iter().map(String::as_str).collect()
}

/// Nom de projet Compose dérivé du dossier (basename minuscule, alnum/_/-).
fn project_name(project_dir: &str) -> String {
    Path::new(project_dir)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect()
}

#[tauri::command]
async fn detect_docker(context: Option<String>) -> DockerStatus {
    let ctx = context.as_deref();
    let client = docker(ctx, &["--version"], None);
    let installed = client.is_ok();
    let client_version = client.ok().map(|s| s.replace("Docker version ", ""));

    let server = docker(ctx, &["info", "--format", "{{.ServerVersion}}"], None);
    let daemon_running = server.is_ok();
    let server_version = server.ok();

    let context_name = docker(ctx, &["context", "show"], None).ok();

    let message = if !installed {
        "Docker n'est pas installé (ou absent du PATH). Installez Docker Desktop puis relancez."
            .to_string()
    } else if !daemon_running {
        "Docker est installé mais le démon n'est pas joignable. Démarrez Docker Desktop, \
         ou vérifiez le contexte sélectionné."
            .to_string()
    } else {
        "Docker est prêt.".to_string()
    };

    DockerStatus {
        installed,
        daemon_running,
        client_version,
        server_version,
        context: context_name,
        message,
    }
}

/// Liste les contextes Docker disponibles (pour cibler un hôte distant).
#[tauri::command]
async fn list_contexts() -> Result<Vec<String>, String> {
    let out = docker(None, &["context", "ls", "--format", "{{.Name}}"], None)?;
    Ok(out.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
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
        _ => match state {
            "running" => "running",
            "" => "unknown",
            _ => "down",
        },
    }
    .to_string()
}

#[tauri::command]
async fn compose_ps(context: Option<String>, project_dir: String) -> Result<Vec<ServiceStatus>, String> {
    let raw = docker(
        context.as_deref(),
        &["compose", "ps", "--all", "--format", "json"],
        Some(&project_dir),
    )?;
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
async fn compose_up(
    context: Option<String>,
    project_dir: String,
    profiles: Vec<String>,
) -> Result<String, String> {
    let args = compose_args(&profiles, &["up", "-d"]);
    docker(context.as_deref(), &as_refs(&args), Some(&project_dir)).map(|_| "Stack démarré.".into())
}

// `down` reçoit TOUS les profils connus (pas seulement les cochés) : sinon les
// services de profils non activés ne sont pas arrêtés et bloquent le réseau.
#[tauri::command]
async fn compose_down(
    context: Option<String>,
    project_dir: String,
    profiles: Vec<String>,
) -> Result<String, String> {
    let args = compose_args(&profiles, &["down", "--remove-orphans"]);
    docker(context.as_deref(), &as_refs(&args), Some(&project_dir)).map(|_| "Stack arrêté.".into())
}

/// Logs (snapshot borné). Le front peut rappeler en boucle pour « suivre ».
#[tauri::command]
async fn compose_logs(
    context: Option<String>,
    project_dir: String,
    service: Option<String>,
    tail: u32,
) -> Result<String, String> {
    let tail_arg = format!("--tail={tail}");
    let mut sub: Vec<&str> = vec!["logs", "--no-color", "--no-log-prefix", &tail_arg];
    if let Some(ref s) = service {
        if !s.is_empty() {
            sub.push(s);
        }
    }
    let args = compose_args(&[], &sub);
    docker(context.as_deref(), &as_refs(&args), Some(&project_dir))
}

/// Met à jour les images (pull) puis recrée le stack (up -d).
#[tauri::command]
async fn update_images(
    context: Option<String>,
    project_dir: String,
    profiles: Vec<String>,
) -> Result<String, String> {
    let ctx = context.as_deref();
    let pull = compose_args(&profiles, &["pull"]);
    docker(ctx, &as_refs(&pull), Some(&project_dir))?;
    let up = compose_args(&profiles, &["up", "-d"]);
    docker(ctx, &as_refs(&up), Some(&project_dir))?;
    Ok("Images à jour, stack recréé.".into())
}

/// Liste les volumes Docker du projet (pour backup/restore).
#[tauri::command]
async fn list_volumes(context: Option<String>, project_dir: String) -> Result<Vec<String>, String> {
    let proj = project_name(&project_dir);
    let filter = format!("label=com.docker.compose.project={proj}");
    let out = docker(
        context.as_deref(),
        &["volume", "ls", "--filter", &filter, "--format", "{{.Name}}"],
        None,
    )?;
    Ok(out.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

fn timestamp() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Sauvegarde un volume dans `dest_dir` (sur l'hôte du démon) : tar.gz via un
/// container alpine éphémère. Pattern Docker standard pour backuper un volume.
#[tauri::command]
async fn backup_volume(
    context: Option<String>,
    volume: String,
    dest_dir: String,
) -> Result<String, String> {
    let file = format!("{volume}-{}.tar.gz", timestamp());
    let vol_mount = format!("{volume}:/data:ro");
    let dst_mount = format!("{dest_dir}:/backup");
    let archive = format!("/backup/{file}");
    docker(
        context.as_deref(),
        &[
            "run", "--rm",
            "-v", &vol_mount,
            "-v", &dst_mount,
            "alpine", "tar", "czf", &archive, "-C", "/data", ".",
        ],
        None,
    )?;
    Ok(format!("Sauvegarde créée : {dest_dir}/{file}"))
}

/// Restaure un volume depuis une archive .tar.gz (hôte du démon). À faire stack
/// ARRÊTÉ. Vide le volume puis ré-extrait.
#[tauri::command]
async fn restore_volume(
    context: Option<String>,
    volume: String,
    archive_path: String,
) -> Result<String, String> {
    let p = Path::new(&archive_path);
    let dir = p
        .parent()
        .and_then(|d| d.to_str())
        .filter(|s| !s.is_empty())
        .ok_or("chemin d'archive invalide")?;
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("nom d'archive invalide")?;
    let dir_mount = format!("{dir}:/backup:ro");
    let vol_mount = format!("{volume}:/data");
    let script = format!("find /data -mindepth 1 -delete && tar xzf /backup/{name} -C /data");
    docker(
        context.as_deref(),
        &[
            "run", "--rm",
            "-v", &vol_mount,
            "-v", &dir_mount,
            "alpine", "sh", "-c", &script,
        ],
        None,
    )?;
    Ok(format!("Volume {volume} restauré depuis {name}."))
}

/// Ouvre une URL dans le navigateur par défaut. Sous Linux/WSL, `xdg-open` n'est
/// pas toujours là : on tente plusieurs ouvreurs (dont `wslview`).
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            detect_docker,
            list_contexts,
            default_project_dir,
            compose_ps,
            compose_up,
            compose_down,
            compose_logs,
            update_images,
            list_volumes,
            backup_volume,
            restore_volume,
            open_app
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri");
}

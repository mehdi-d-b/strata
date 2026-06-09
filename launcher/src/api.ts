// Pont typé vers les commandes Rust (Tauri). Le launcher ne contient AUCUNE
// logique métier : il orchestre l'infra Docker via ces commandes.
import { invoke } from "@tauri-apps/api/core";

export type DockerStatus = {
  installed: boolean;
  daemon_running: boolean;
  client_version: string | null;
  server_version: string | null;
  context: string | null;
  message: string;
};

// Voyant à 3 états : « running » ≠ « ready » (cf. docs/launcher-plan.md §6).
export type Health = "healthy" | "starting" | "unhealthy" | "running" | "down" | "unknown";

export type ServiceStatus = {
  service: string;
  state: string; // running / exited / ...
  health: Health;
};

export const PROFILES = [
  { id: "plc4x", label: "Automates industriels", hint: "connexion aux automates (Siemens, Schneider, Allen-Bradley…)" },
  { id: "risingwave", label: "Détection d'anomalies", hint: "analyse des mesures en temps réel" },
] as const;

// `ctx` : nom de contexte Docker (hôte distant). null/"" = contexte courant.
const c = (ctx: string) => (ctx ? ctx : null);

export const detectDocker = (ctx: string) =>
  invoke<DockerStatus>("detect_docker", { context: c(ctx) });

export const listContexts = () => invoke<string[]>("list_contexts");

export const defaultProjectDir = () => invoke<string>("default_project_dir");

export const composePs = (ctx: string, projectDir: string) =>
  invoke<ServiceStatus[]>("compose_ps", { context: c(ctx), projectDir });

export const composeUp = (ctx: string, projectDir: string, profiles: string[]) =>
  invoke<string>("compose_up", { context: c(ctx), projectDir, profiles });

export const composeDown = (ctx: string, projectDir: string, profiles: string[]) =>
  invoke<string>("compose_down", { context: c(ctx), projectDir, profiles });

export const composeLogs = (ctx: string, projectDir: string, service: string, tail: number) =>
  invoke<string>("compose_logs", { context: c(ctx), projectDir, service: service || null, tail });

export const updateImages = (ctx: string, projectDir: string, profiles: string[]) =>
  invoke<string>("update_images", { context: c(ctx), projectDir, profiles });

export const listVolumes = (ctx: string, projectDir: string) =>
  invoke<string[]>("list_volumes", { context: c(ctx), projectDir });

export const backupVolume = (ctx: string, volume: string, destDir: string) =>
  invoke<string>("backup_volume", { context: c(ctx), volume, destDir });

export const restoreVolume = (ctx: string, volume: string, archivePath: string) =>
  invoke<string>("restore_volume", { context: c(ctx), volume, archivePath });

export type EnvData = {
  exists: boolean;
  example_exists: boolean;
  values: Record<string, string>;
};

export const readEnv = (projectDir: string) =>
  invoke<EnvData>("read_env", { projectDir });

export const writeEnv = (projectDir: string, values: Record<string, string>) =>
  invoke<string>("write_env", { projectDir, values });

export const openApp = (url: string) => invoke<void>("open_app", { url });

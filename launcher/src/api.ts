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
  { id: "plc4x", label: "PLC4X", hint: "automates S7 / Modbus / EtherNet-IP (1 container JVM)" },
  { id: "risingwave", label: "RisingWave", hint: "anomalies temps réel (SQL streaming)" },
] as const;

export const detectDocker = () => invoke<DockerStatus>("detect_docker");

export const defaultProjectDir = () => invoke<string>("default_project_dir");

export const composePs = (projectDir: string) =>
  invoke<ServiceStatus[]>("compose_ps", { projectDir });

export const composeUp = (projectDir: string, profiles: string[]) =>
  invoke<string>("compose_up", { projectDir, profiles });

export const composeDown = (projectDir: string, profiles: string[]) =>
  invoke<string>("compose_down", { projectDir, profiles });

export const openApp = (url: string) => invoke<void>("open_app", { url });

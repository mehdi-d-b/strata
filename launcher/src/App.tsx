import { useCallback, useEffect, useState } from "react";
import {
  PROFILES,
  composeDown,
  composePs,
  composeUp,
  defaultProjectDir,
  detectDocker,
  openApp,
  type DockerStatus,
  type Health,
  type ServiceStatus,
} from "./api";

const APP_URL = "http://localhost:5173"; // TODO: front de prod (nginx/Caddy) en mode produit
const HEALTH_DOT: Record<Health, string> = {
  healthy: "#16a34a",
  running: "#16a34a",
  starting: "#d97706",
  unhealthy: "#dc2626",
  down: "#6b7280",
  unknown: "#6b7280",
};

export default function App() {
  const [docker, setDocker] = useState<DockerStatus | null>(null);
  const [projectDir, setProjectDir] = useState("");
  const [profiles, setProfiles] = useState<Record<string, boolean>>({});
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null); // libellé de l'opération en cours
  const [log, setLog] = useState<string>("");

  // Détection Docker + dossier projet par défaut au démarrage.
  useEffect(() => {
    detectDocker().then(setDocker).catch((e) => setLog(String(e)));
    const saved = localStorage.getItem("strata.projectDir");
    if (saved) setProjectDir(saved);
    else defaultProjectDir().then(setProjectDir).catch(() => {});
  }, []);

  const onProjectDir = (v: string) => {
    setProjectDir(v);
    localStorage.setItem("strata.projectDir", v);
  };

  const refresh = useCallback(async () => {
    if (!projectDir) return;
    try {
      setServices(await composePs(projectDir));
    } catch (e) {
      setLog(String(e));
    }
  }, [projectDir]);

  // Poll de l'état tant que Docker tourne (running ≠ ready : on relit la santé).
  useEffect(() => {
    if (!docker?.daemon_running || !projectDir) return;
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [docker?.daemon_running, projectDir, refresh]);

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    try {
      setLog(await fn());
      await refresh();
    } catch (e) {
      setLog(String(e));
    } finally {
      setBusy(null);
    }
  };

  const selectedProfiles = Object.entries(profiles)
    .filter(([, on]) => on)
    .map(([id]) => id);
  const allProfiles = PROFILES.map((p) => p.id); // arrêt = tous les profils (stop complet)

  const dockerReady = docker?.installed && docker?.daemon_running;

  return (
    <main className="app">
      <header>
        <h1>Strata <span className="muted">— launcher</span></h1>
        <p className="muted">Orchestrateur d'infra (hors Docker). Pilote le stack, ne touche pas aux données métier.</p>
      </header>

      {/* Prérequis Docker */}
      <section className="card">
        <h2>Prérequis</h2>
        {!docker && <p className="muted">Détection…</p>}
        {docker && (
          <ul className="checks">
            <li>
              <Dot ok={docker.installed} />
              Docker installé {docker.client_version ? `(${docker.client_version})` : ""}
            </li>
            <li>
              <Dot ok={docker.daemon_running} />
              Démon démarré {docker.server_version ? `(serveur ${docker.server_version})` : ""}
              {docker.context ? ` · contexte « ${docker.context} »` : ""}
            </li>
          </ul>
        )}
        {docker && !dockerReady && <p className="warn">{docker.message}</p>}
      </section>

      {/* Dossier du projet Strata */}
      <section className="card">
        <h2>Projet Strata</h2>
        <label className="field">
          <span>Dossier (contient <code>docker-compose.yml</code>)</span>
          <input
            value={projectDir}
            onChange={(e) => onProjectDir(e.target.value)}
            placeholder="/chemin/vers/strata"
            spellCheck={false}
          />
        </label>
      </section>

      {/* Profils + actions */}
      <section className="card">
        <h2>Lancement</h2>
        <div className="profiles">
          {PROFILES.map((p) => (
            <label key={p.id} className="profile">
              <input
                type="checkbox"
                checked={!!profiles[p.id]}
                onChange={(e) => setProfiles((s) => ({ ...s, [p.id]: e.target.checked }))}
              />
              <span><strong>{p.label}</strong> <span className="muted">— {p.hint}</span></span>
            </label>
          ))}
        </div>
        <div className="actions">
          <button
            disabled={!dockerReady || !projectDir || !!busy}
            onClick={() => run("Démarrage du stack…", () => composeUp(projectDir, selectedProfiles))}
          >
            {busy === "Démarrage du stack…" ? "⏳ Démarrage…" : "▶ Démarrer"}
          </button>
          <button
            className="ghost"
            disabled={!dockerReady || !projectDir || !!busy}
            onClick={() => run("Arrêt du stack…", () => composeDown(projectDir, allProfiles))}
          >
            {busy === "Arrêt du stack…" ? "⏳ Arrêt…" : "■ Arrêter"}
          </button>
          <button className="ghost" disabled={!dockerReady || !projectDir || !!busy} onClick={refresh}>
            ⟳ Rafraîchir
          </button>
          <button
            className="ghost"
            disabled={!!busy}
            onClick={() => openApp(APP_URL).catch((e) => setLog(String(e)))}
          >
            ↗ Ouvrir l'appli
          </button>
        </div>
        {busy && (
          <div className="banner">
            <span className="spinner" /> {busy} <span className="muted">(Docker travaille en arrière-plan, patiente)</span>
          </div>
        )}
      </section>

      {/* État des services */}
      <section className="card">
        <h2>Services {busy && <span className="muted">— opération en cours…</span>}</h2>
        {services.length === 0 ? (
          <p className="muted">Aucun container (stack arrêté).</p>
        ) : (
          <table>
            <thead><tr><th>Service</th><th>État</th><th>Santé</th></tr></thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.service}>
                  <td>{s.service}</td>
                  <td>{s.state}</td>
                  <td>
                    <span className="dot" style={{ background: HEALTH_DOT[s.health] }} />
                    {s.health}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {log && <pre className="log">{log}</pre>}
    </main>
  );
}

function Dot({ ok }: { ok: boolean }) {
  return <span className="dot" style={{ background: ok ? "#16a34a" : "#dc2626" }} />;
}

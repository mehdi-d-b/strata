import { useCallback, useEffect, useState } from "react";
import {
  PROFILES,
  backupVolume,
  composeDown,
  composeLogs,
  composePs,
  composeUp,
  defaultProjectDir,
  detectDocker,
  listContexts,
  listVolumes,
  openApp,
  restoreVolume,
  updateImages,
  type DockerStatus,
  type Health,
  type ServiceStatus,
} from "./api";
import { open } from "@tauri-apps/plugin-dialog";

const APP_URL = "http://localhost:5173"; // TODO: front de prod (nginx/Caddy) en mode produit
const HEALTH_DOT: Record<Health, string> = {
  healthy: "#16a34a",
  running: "#16a34a",
  starting: "#d97706",
  unhealthy: "#dc2626",
  down: "#6b7280",
  unknown: "#6b7280",
};

type Tab = "pilotage" | "maintenance";

export default function App() {
  const [tab, setTab] = useState<Tab>("pilotage");
  const [context, setContextState] = useState(() => localStorage.getItem("strata.context") || "");
  const [contexts, setContexts] = useState<string[]>([]);
  const [docker, setDocker] = useState<DockerStatus | null>(null);
  const [projectDir, setProjectDir] = useState(() => localStorage.getItem("strata.projectDir") || "");
  const [profiles, setProfiles] = useState<Record<string, boolean>>({});
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string>("");

  // Maintenance
  const [logService, setLogService] = useState("");
  const [logTail, setLogTail] = useState(200);
  const [logsText, setLogsText] = useState("");
  const [follow, setFollow] = useState(false);
  const [volumes, setVolumes] = useState<string[]>([]);
  const [backupDir, setBackupDir] = useState(() => localStorage.getItem("strata.backupDir") || "");
  const [restoreVol, setRestoreVol] = useState("");
  const [restoreArchive, setRestoreArchive] = useState("");

  const setContext = (v: string) => {
    setContextState(v);
    localStorage.setItem("strata.context", v);
  };
  const onProjectDir = (v: string) => {
    setProjectDir(v);
    localStorage.setItem("strata.projectDir", v);
  };
  const onBackupDir = (v: string) => {
    setBackupDir(v);
    localStorage.setItem("strata.backupDir", v);
  };

  const detect = useCallback(() => {
    detectDocker(context).then(setDocker).catch((e) => setLog(String(e)));
  }, [context]);

  useEffect(() => {
    listContexts().then(setContexts).catch(() => {});
    if (!projectDir) defaultProjectDir().then(onProjectDir).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-détecte Docker quand le contexte change.
  useEffect(() => {
    detect();
  }, [detect]);

  const refresh = useCallback(async () => {
    if (!projectDir) return;
    try {
      setServices(await composePs(context, projectDir));
    } catch (e) {
      setLog(String(e));
    }
  }, [context, projectDir]);

  // Poll de l'état (running ≠ ready : on relit la santé).
  useEffect(() => {
    if (!docker?.daemon_running || !projectDir) return;
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [docker?.daemon_running, projectDir, refresh]);

  const loadLogs = useCallback(async () => {
    if (!projectDir) return;
    try {
      setLogsText(await composeLogs(context, projectDir, logService, logTail));
    } catch (e) {
      setLogsText(String(e));
    }
  }, [context, projectDir, logService, logTail]);

  // Suivi des logs (polling : pas de child-process à gérer côté Rust).
  useEffect(() => {
    if (!follow) return;
    loadLogs();
    const t = setInterval(loadLogs, 2000);
    return () => clearInterval(t);
  }, [follow, loadLogs]);

  // Sélecteur natif (dossier ou fichier). r est string|string[]|null.
  const browse = async (
    setter: (v: string) => void,
    opts: Parameters<typeof open>[0],
  ) => {
    try {
      const r = await open(opts);
      if (typeof r === "string") setter(r);
    } catch (e) {
      setLog(String(e));
    }
  };

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
  const allProfiles = PROFILES.map((p) => p.id);
  const dockerReady = !!docker?.installed && !!docker?.daemon_running;
  const canAct = dockerReady && !!projectDir && !busy;

  return (
    <main className="app">
      <header>
        <h1>Strata <span className="muted">— launcher</span></h1>
        <p className="muted">Démarrez, arrêtez et surveillez Strata en quelques clics.</p>
      </header>

      <nav className="tabs">
        <button className={tab === "pilotage" ? "tab on" : "tab"} onClick={() => setTab("pilotage")}>Pilotage</button>
        <button className={tab === "maintenance" ? "tab on" : "tab"} onClick={() => setTab("maintenance")}>Maintenance</button>
      </nav>

      {/* Prérequis + contexte : visibles partout */}
      <section className="card">
        <h2>Prérequis</h2>
        {!docker && <p className="muted">Détection…</p>}
        {docker && (
          <ul className="checks">
            <li><Dot ok={docker.installed} /> Docker installé {docker.client_version ? `(${docker.client_version})` : ""}</li>
            <li>
              <Dot ok={docker.daemon_running} /> Docker démarré {docker.server_version ? `(v${docker.server_version})` : ""}
              {docker.context && docker.context !== "default" ? ` · machine « ${docker.context} »` : ""}
            </li>
          </ul>
        )}
        {docker && !dockerReady && <p className="warn">{docker.message}</p>}
        <label className="field inline">
          <span>Machine</span>
          <select value={context} onChange={(e) => setContext(e.target.value)}>
            <option value="">Cette machine</option>
            {contexts.filter((c) => c !== "default").map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <span className="muted">— avancé : piloter une autre machine</span>
        </label>
      </section>

      {tab === "pilotage" && (
        <>
          <section className="card">
            <h2>Projet Strata</h2>
            <label className="field">
              <span>Dossier (contient <code>docker-compose.yml</code>)</span>
              <div className="input-row">
                <input value={projectDir} onChange={(e) => onProjectDir(e.target.value)} placeholder="/chemin/vers/strata" spellCheck={false} />
                <button className="ghost" onClick={() => browse(onProjectDir, { directory: true, title: "Dossier du projet Strata" })}>Parcourir…</button>
              </div>
            </label>
          </section>

          <section className="card">
            <h2>Lancement</h2>
            <div className="profiles">
              {PROFILES.map((p) => (
                <label key={p.id} className="profile">
                  <input type="checkbox" checked={!!profiles[p.id]} onChange={(e) => setProfiles((s) => ({ ...s, [p.id]: e.target.checked }))} />
                  <span><strong>{p.label}</strong> <span className="muted">— {p.hint}</span></span>
                </label>
              ))}
            </div>
            <div className="actions">
              <button disabled={!canAct} onClick={() => run("Démarrage de Strata…", () => composeUp(context, projectDir, selectedProfiles))}>
                {busy === "Démarrage de Strata…" ? "⏳ Démarrage…" : "▶ Démarrer"}
              </button>
              <button className="ghost" disabled={!canAct} onClick={() => run("Arrêt de Strata…", () => composeDown(context, projectDir, allProfiles))}>
                {busy === "Arrêt de Strata…" ? "⏳ Arrêt…" : "■ Arrêter"}
              </button>
              <button className="ghost" disabled={!canAct} onClick={refresh}>⟳ Rafraîchir</button>
              <button className="ghost" disabled={!!busy} onClick={() => openApp(APP_URL).catch((e) => setLog(String(e)))}>↗ Ouvrir l'appli</button>
            </div>
            {busy && <div className="banner"><span className="spinner" /> {busy} <span className="muted">(opération en cours, patientez…)</span></div>}
          </section>

          <section className="card">
            <h2>Services</h2>
            {services.length === 0 ? (
              <p className="muted">Strata est arrêté.</p>
            ) : (
              <table>
                <thead><tr><th>Service</th><th>État</th><th>Santé</th></tr></thead>
                <tbody>
                  {services.map((s) => (
                    <tr key={s.service}>
                      <td>{s.service}</td><td>{s.state}</td>
                      <td><span className="dot" style={{ background: HEALTH_DOT[s.health] }} />{s.health}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {tab === "maintenance" && (
        <>
          <section className="card">
            <h2>Logs</h2>
            <div className="row">
              <label className="field inline">
                <span>Service</span>
                <select value={logService} onChange={(e) => setLogService(e.target.value)}>
                  <option value="">(tous)</option>
                  {services.map((s) => <option key={s.service} value={s.service}>{s.service}</option>)}
                </select>
              </label>
              <label className="field inline">
                <span>Lignes</span>
                <input type="number" min={20} max={2000} value={logTail} onChange={(e) => setLogTail(Number(e.target.value) || 200)} style={{ width: 90 }} />
              </label>
              <button className="ghost" disabled={!dockerReady || !projectDir} onClick={loadLogs}>⟳ Charger</button>
              <label className="profile">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> <span>Suivre (2 s)</span>
              </label>
            </div>
            <pre className="log tall">{logsText || "— aucun log chargé —"}</pre>
          </section>

          <section className="card">
            <h2>Mise à jour</h2>
            <p className="muted">Télécharge la dernière version de Strata, puis le redémarre (avec les options cochées dans Pilotage).</p>
            <div className="actions">
              <button disabled={!canAct} onClick={() => run("Mise à jour des images…", () => updateImages(context, projectDir, selectedProfiles))}>
                {busy === "Mise à jour des images…" ? "⏳ Mise à jour…" : "⤓ Mettre à jour"}
              </button>
            </div>
          </section>

          <section className="card">
            <h2>Sauvegarde des données</h2>
            <p className="muted">
              Sauvegarde les données de Strata dans un fichier <code>.tar.gz</code> que vous pouvez
              archiver ou copier ailleurs. Choisissez un dossier, puis « Sauvegarder » sur une donnée.
            </p>
            <p className="muted">⚠️ Restaurez de préférence <strong>Strata arrêté</strong> (écrase les données existantes).</p>
            <label className="field">
              <span>Dossier de sauvegarde</span>
              <div className="input-row">
                <input value={backupDir} onChange={(e) => onBackupDir(e.target.value)} placeholder="(choisir un dossier)" spellCheck={false} />
                <button className="ghost" onClick={() => browse(onBackupDir, { directory: true, title: "Dossier de sauvegarde" })}>Parcourir…</button>
              </div>
            </label>
            <div className="actions">
              <button className="ghost" disabled={!dockerReady || !projectDir || !!busy} onClick={() => run("Recherche des données…", async () => { const v = await listVolumes(context, projectDir); setVolumes(v); return `${v.length} donnée(s) trouvée(s).`; })}>
                ⟳ Voir les données à sauvegarder
              </button>
            </div>
            {volumes.length > 0 && (
              <table>
                <thead><tr><th>Donnée</th><th></th></tr></thead>
                <tbody>
                  {volumes.map((v) => (
                    <tr key={v}>
                      <td>{v}</td>
                      <td><button className="ghost" disabled={!backupDir || !!busy} onClick={() => run(`Sauvegarde ${v}…`, () => backupVolume(context, v, backupDir))}>Sauvegarder</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="restore">
              <h3>Restaurer</h3>
              <label className="field inline">
                <span>Donnée à restaurer</span>
                <select value={restoreVol} onChange={(e) => setRestoreVol(e.target.value)}>
                  <option value="">(choisir)</option>
                  {volumes.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Archive .tar.gz</span>
                <div className="input-row">
                  <input value={restoreArchive} onChange={(e) => setRestoreArchive(e.target.value)} placeholder="(choisir un fichier .tar.gz)" spellCheck={false} />
                  <button className="ghost" onClick={() => browse(setRestoreArchive, { multiple: false, title: "Archive à restaurer", filters: [{ name: "Archive", extensions: ["gz", "tgz"] }] })}>Parcourir…</button>
                </div>
              </label>
              <div className="actions">
                <button className="danger" disabled={!restoreVol || !restoreArchive || !!busy} onClick={() => run(`Restauration ${restoreVol}…`, () => restoreVolume(context, restoreVol, restoreArchive))}>
                  ⚠️ Restaurer (écrase le volume)
                </button>
              </div>
            </div>
          </section>
        </>
      )}

      {log && <pre className="log">{log}</pre>}
    </main>
  );
}

function Dot({ ok }: { ok: boolean }) {
  return <span className="dot" style={{ background: ok ? "#16a34a" : "#dc2626" }} />;
}

import { useEffect, useState } from "react";
import {
  ApiError,
  changeMyPassword,
  fetchStorage,
  fetchSystem,
  setCompression,
  setRetention,
  userIsAdmin,
  type Storage,
  type SystemInfo,
} from "./api";
import { useAuth } from "./auth";

type Section = "account" | "display" | "storage" | "system";

export function SettingsView() {
  const { user } = useAuth();
  const admin = userIsAdmin(user);
  const [section, setSection] = useState<Section>("account");

  // Sections visibles selon le rôle.
  const tabs: { id: Section; label: string; adminOnly?: boolean }[] = [
    { id: "account", label: "Mon compte" },
    { id: "display", label: "Affichage" },
    { id: "storage", label: "Stockage", adminOnly: true },
    { id: "system", label: "Système", adminOnly: true },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="subnav">
        {tabs
          .filter((t) => !t.adminOnly || admin)
          .map((t) => (
            <button
              key={t.id}
              className={section === t.id ? "active" : ""}
              onClick={() => setSection(t.id)}
            >
              {t.label}
            </button>
          ))}
      </div>
      {section === "account" && <AccountSection />}
      {section === "display" && <DisplaySection />}
      {section === "storage" && admin && <StorageSection />}
      {section === "system" && admin && <SystemSection />}
    </div>
  );
}

// ─── Mon compte ──────────────────────────────────────────────────────────

function AccountSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (next !== confirm) {
      setMsg({ ok: false, text: "la confirmation ne correspond pas" });
      return;
    }
    try {
      await changeMyPassword(current, next);
      setMsg({ ok: true, text: "mot de passe modifié" });
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setMsg({
        ok: false,
        text:
          err instanceof ApiError && err.status === 403
            ? "mot de passe actuel incorrect"
            : "échec de la modification",
      });
    }
  };

  return (
    <div className="card">
      <h2 className="card-title">Changer mon mot de passe</h2>
      <form onSubmit={submit} className="form-col">
        <label className="field">
          Mot de passe actuel
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="field">
          Nouveau mot de passe
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label className="field">
          Confirmer
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <div>
          <button className="add" type="submit" disabled={!current || !next}>
            Mettre à jour
          </button>
          {msg && (
            <span className={`hint ${msg.ok ? "ok-text" : "err-text"}`} style={{ marginLeft: 10 }}>
              {msg.text}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

// ─── Affichage (préférences locales) ─────────────────────────────────────

const PREF_KEY = "strata.prefs";
export function loadPrefs(): { defaultWindowSec: number } {
  try {
    return { defaultWindowSec: 300, ...JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}") };
  } catch {
    return { defaultWindowSec: 300 };
  }
}

function DisplaySection() {
  const [win, setWin] = useState(loadPrefs().defaultWindowSec);
  const [saved, setSaved] = useState(false);

  const save = () => {
    localStorage.setItem(PREF_KEY, JSON.stringify({ defaultWindowSec: win }));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="card">
      <h2 className="card-title">Préférences d'affichage</h2>
      <label className="field">
        Fenêtre temps réel par défaut
        <select value={win} onChange={(e) => setWin(Number(e.target.value))}>
          <option value={300}>5 minutes</option>
          <option value={900}>15 minutes</option>
          <option value={3600}>60 minutes</option>
        </select>
      </label>
      <p className="hint">Stocké dans ce navigateur uniquement.</p>
      <button className="add" onClick={save}>
        Enregistrer
      </button>
      {saved && <span className="hint ok-text" style={{ marginLeft: 10 }}>enregistré</span>}
    </div>
  );
}

// ─── Stockage (Timescale) ────────────────────────────────────────────────

function StorageSection() {
  const [st, setSt] = useState<Storage | null>(null);
  const [retention, setRet] = useState(365);
  const [compress, setComp] = useState(7);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => fetchStorage().then(setSt).catch(() => setSt(null));
  useEffect(() => {
    load();
  }, []);

  const applyRetention = async () => {
    await setRetention(retention);
    setMsg(retention === 0 ? "purge désactivée" : `rétention : ${retention} j`);
    load();
  };
  const applyCompression = async () => {
    await setCompression(compress);
    setMsg(compress === 0 ? "compression désactivée" : `compression après ${compress} j`);
    load();
  };

  const ratio =
    st?.compression.before_b && st?.compression.after_b && Number(st.compression.after_b) > 0
      ? (Number(st.compression.before_b) / Number(st.compression.after_b)).toFixed(1)
      : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card">
        <h2 className="card-title">État du stockage</h2>
        <div className="kpi-grid">
          <Stat label="Taille (mesures)" value={st?.size.total ?? "…"} />
          <Stat label="Lignes" value={st?.size.rows ?? "…"} />
          <Stat label="Compressé" value={st?.compression.after ?? "—"} />
          <Stat label="Ratio compression" value={ratio ? `${ratio}×` : "—"} />
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Rétention du brut</h2>
        <p className="hint">
          Supprime automatiquement les mesures plus anciennes. 0 = ne jamais purger.
          Les agrégats production/shift ne sont pas affectés.
        </p>
        <label className="field">
          Conserver (jours)
          <input
            type="number"
            min={0}
            max={3650}
            value={retention}
            onChange={(e) => setRet(Number(e.target.value))}
          />
        </label>
        <button className="add" onClick={applyRetention}>
          Appliquer
        </button>
        <p className="hint">Actuel : {st?.retention_after ?? "non configuré"}</p>
      </div>

      <div className="card">
        <h2 className="card-title">Compression</h2>
        <p className="hint">
          Compresse les chunks plus vieux que N jours (gain ~10-20×, restent
          interrogeables). 0 = désactiver.
        </p>
        <label className="field">
          Compresser après (jours)
          <input
            type="number"
            min={0}
            max={3650}
            value={compress}
            onChange={(e) => setComp(Number(e.target.value))}
          />
        </label>
        <button className="add" onClick={applyCompression}>
          Appliquer
        </button>
        <p className="hint">Actuel : {st?.compress_after ?? "non configuré"}</p>
        {msg && <p className="hint ok-text">{msg}</p>}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={{ fontSize: 22 }}>{value}</div>
    </div>
  );
}

// ─── Système ─────────────────────────────────────────────────────────────

function SystemSection() {
  const [sys, setSys] = useState<SystemInfo | null>(null);
  useEffect(() => {
    fetchSystem().then(setSys).catch(() => setSys(null));
  }, []);

  if (!sys) return <div className="card hint">Chargement…</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card">
        <h2 className="card-title">Inventaire</h2>
        <div className="kpi-grid">
          <Stat label="Tags" value={String(sys.counts.tags)} />
          <Stat label="Automates" value={String(sys.counts.devices)} />
          <Stat label="Utilisateurs" value={String(sys.counts.users)} />
          <Stat label="Mesures" value={String(sys.counts.mesures)} />
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Versions</h2>
        <table className="tags">
          <tbody>
            <tr><td>TimescaleDB</td><td><code>{sys.timescaledb_version}</code></td></tr>
            <tr><td>Node (gateway)</td><td><code>{sys.node_version}</code></td></tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 className="card-title">Connecteurs PLC4X</h2>
        {sys.connectors.length === 0 ? (
          <p className="hint">Aucun connecteur (profil plc4x non démarré ou aucun déployé).</p>
        ) : (
          <table className="tags">
            <thead>
              <tr><th>Connecteur</th><th>État</th></tr>
            </thead>
            <tbody>
              {sys.connectors.map((c) => (
                <tr key={c.name}>
                  <td><code>{c.name}</code></td>
                  <td>
                    <span className={`status ${c.state === "RUNNING" ? "live" : "off"}`}>
                      {c.state}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import {
  PROTOCOLS,
  deleteDevice,
  deployDevice,
  fetchDeviceTags,
  fetchDevices,
  importTagsCsv,
  saveDevice,
  saveTagAddress,
  undeployDevice,
  type Device,
  type DeviceTag,
  type Protocol,
} from "./api";

export function DevicesView() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const load = () => fetchDevices().then(setDevices).catch(() => setDevices([]));
  useEffect(() => {
    load();
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <DeviceList
        devices={devices}
        selected={selected}
        onSelect={setSelected}
        onChange={load}
      />
      {selected && <DeviceDetail device={selected} onChange={load} />}
    </div>
  );
}

// ─── Liste + création d'automates ────────────────────────────────────────

function DeviceList({
  devices,
  selected,
  onSelect,
  onChange,
}: {
  devices: Device[];
  selected: string | null;
  onSelect: (n: string) => void;
  onChange: () => void;
}) {
  const blank = {
    name: "",
    protocol: "simulated" as Protocol,
    host: "127.0.0.1",
    base_tag: "",
    poll_ms: 1000,
  };
  const [nd, setNd] = useState(blank);
  const [deploying, setDeploying] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const create = async () => {
    if (!nd.name || !nd.host) return;
    await saveDevice({ ...nd, enabled: true });
    setNd(blank);
    onChange();
  };

  const onDeploy = async (name: string) => {
    setDeploying(name);
    setMsg(null);
    const r = await deployDevice(name);
    setMsg(`${r.ok ? "✅" : "⚠️"} ${r.device} : ${r.detail}`);
    setDeploying(null);
  };

  return (
    <div className="card">
      <h2 className="card-title">Automates</h2>
      <table className="tags">
        <thead>
          <tr>
            <th>Nom</th>
            <th>Protocole</th>
            <th>Hôte</th>
            <th>Base tag</th>
            <th>Tags</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr
              key={d.name}
              className={selected === d.name ? "row-selected" : ""}
            >
              <td>
                <button className="linkish" onClick={() => onSelect(d.name)}>
                  {d.name}
                </button>
              </td>
              <td><code>{d.protocol}</code></td>
              <td>{d.host}</td>
              <td><code>{d.base_tag ?? "—"}</code></td>
              <td>{d.tag_count}</td>
              <td>
                <button onClick={() => onDeploy(d.name)} disabled={deploying === d.name}>
                  {deploying === d.name ? "…" : "Déployer"}
                </button>
                <button className="ghost" onClick={() => undeployDevice(d.name).then(onChange)}>
                  Retirer
                </button>
                <button
                  className="ghost"
                  onClick={() => {
                    if (confirm(`Supprimer l'automate ${d.name} ?`))
                      deleteDevice(d.name).then(onChange);
                  }}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {msg && <p className="hint">{msg}</p>}

      <div className="newrow">
        <input
          placeholder="nom (ex: ipa-fermenteur)"
          value={nd.name}
          onChange={(e) => setNd({ ...nd, name: e.target.value })}
        />
        <select
          value={nd.protocol}
          onChange={(e) => setNd({ ...nd, protocol: e.target.value as Protocol })}
        >
          {PROTOCOLS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input
          placeholder="hôte/IP"
          value={nd.host}
          onChange={(e) => setNd({ ...nd, host: e.target.value })}
        />
        <input
          placeholder="base tag (ex: brasserie.ipa)"
          value={nd.base_tag}
          onChange={(e) => setNd({ ...nd, base_tag: e.target.value })}
        />
        <button className="add" onClick={create}>
          + Ajouter
        </button>
      </div>
      <p className="hint">
        Le <code>base tag</code> est le préfixe métier appliqué aux points de cet
        automate (ex : <code>brasserie.ipa</code> →{" "}
        <code>brasserie.ipa.fermenteur.temperature</code>). « Déployer » génère et
        pousse le connecteur PLC4X vers Kafka Connect (profil <code>plc4x</code> requis).
      </p>
    </div>
  );
}

// ─── Détail d'un automate : tags + adresses + import CSV ─────────────────

function DeviceDetail({ device, onChange }: { device: string; onChange: () => void }) {
  const [tags, setTags] = useState<DeviceTag[]>([]);
  const [nt, setNt] = useState({ name: "", address: "", datatype: "DINT" });
  const [csv, setCsv] = useState("");
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const load = () =>
    fetchDeviceTags(device).then(setTags).catch(() => setTags([]));
  useEffect(() => {
    load();
  }, [device]);

  const addTag = async () => {
    if (!nt.name || !nt.address) return;
    await saveTagAddress(nt.name, device, nt.address, nt.datatype);
    setNt({ name: "", address: "", datatype: "DINT" });
    load();
    onChange();
  };

  const doImport = async () => {
    const r = await importTagsCsv(device, csv);
    setImportMsg(
      `${r.imported} tag(s) importé(s)` +
        (r.errors.length ? ` — ${r.errors.length} ligne(s) ignorée(s)` : ""),
    );
    setCsv("");
    load();
    onChange();
  };

  return (
    <div className="card">
      <h2 className="card-title">Tags de « {device} »</h2>
      <table className="tags">
        <thead>
          <tr>
            <th>Tag</th>
            <th>Adresse physique</th>
            <th>Type</th>
            <th>Unité</th>
          </tr>
        </thead>
        <tbody>
          {tags.map((t) => (
            <tr key={t.name}>
              <td><code>{t.name}</code></td>
              <td><code>{t.address ?? "—"}</code></td>
              <td>{t.datatype ?? "—"}</td>
              <td>{t.unit ?? "—"}</td>
            </tr>
          ))}
          {tags.length === 0 && (
            <tr>
              <td colSpan={4} style={{ color: "#8b97a7" }}>
                Aucun tag. Ajoute-en un ou importe un CSV.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="newrow">
        <input
          placeholder="nom du tag (ex: brasserie.ipa.fermenteur.temperature)"
          value={nt.name}
          onChange={(e) => setNt({ ...nt, name: e.target.value })}
          style={{ flex: 2 }}
        />
        <input
          placeholder="adresse (ex: holding-register:1:DINT)"
          value={nt.address}
          onChange={(e) => setNt({ ...nt, address: e.target.value })}
          style={{ flex: 1 }}
        />
        <button className="add" onClick={addTag}>
          + Tag
        </button>
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="hint" style={{ marginBottom: 6 }}>
          Import CSV — une ligne par tag : <code>tag,adresse[,type[,unité]]</code>
        </div>
        <textarea
          className="csv"
          rows={4}
          placeholder={
            "brasserie.ipa.fermenteur.temperature,holding-register:1:DINT,DINT,°C\n" +
            "brasserie.ipa.fermenteur.pression,holding-register:2:DINT,DINT,bar"
          }
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
        <div style={{ marginTop: 8 }}>
          <button className="add" onClick={doImport} disabled={!csv.trim()}>
            Importer
          </button>
          {importMsg && <span className="hint" style={{ marginLeft: 10 }}>{importMsg}</span>}
        </div>
      </div>
    </div>
  );
}

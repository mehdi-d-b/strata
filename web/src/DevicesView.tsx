import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function DevicesView() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const load = () => fetchDevices().then(setDevices).catch(() => setDevices([]));
  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <PageHeader
        title="Automates"
        description="Sources d'acquisition : protocole, adresses, déploiement des connecteurs."
      />
      <DeviceList
        devices={devices}
        selected={selected}
        onSelect={setSelected}
        onChange={load}
      />
      {selected && <DeviceDetail device={selected} onChange={load} />}
    </>
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

  const create = async () => {
    if (!nd.name || !nd.host) return;
    await saveDevice({ ...nd, enabled: true });
    setNd(blank);
    onChange();
  };

  const onDeploy = async (name: string) => {
    setDeploying(name);
    const r = await deployDevice(name);
    (r.ok ? toast.success : toast.error)(`${r.device} : ${r.detail}`);
    setDeploying(null);
  };

  return (
    <Section
      title="Automates"
      hint={
        <>
          Le <code>base tag</code> est le préfixe métier appliqué aux points de cet
          automate (ex : <code>brasserie.ipa</code> →{" "}
          <code>brasserie.ipa.fermenteur.temperature</code>). « Déployer » génère et
          pousse le connecteur PLC4X vers Kafka Connect (profil <code>plc4x</code> requis).
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Nom</TableHead>
            <TableHead>Protocole</TableHead>
            <TableHead>Hôte</TableHead>
            <TableHead>Base tag</TableHead>
            <TableHead>Tags</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {devices.map((d) => (
            <TableRow key={d.name} data-state={selected === d.name ? "selected" : undefined}>
              <TableCell>
                <button
                  className="font-medium text-[var(--chart-2)] underline-offset-2 hover:underline"
                  onClick={() => onSelect(d.name)}
                >
                  {d.name}
                </button>
              </TableCell>
              <TableCell>
                <code className="text-[var(--chart-2)]">{d.protocol}</code>
              </TableCell>
              <TableCell>{d.host}</TableCell>
              <TableCell>
                <code className="text-[var(--chart-2)]">{d.base_tag ?? "—"}</code>
              </TableCell>
              <TableCell className="tabular-nums">{d.tag_count}</TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  <Button size="sm" onClick={() => onDeploy(d.name)} disabled={deploying === d.name}>
                    {deploying === d.name ? "…" : "Déployer"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => undeployDevice(d.name).then(onChange)}
                  >
                    Retirer
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    title="Supprimer l'automate"
                    onClick={() => {
                      if (confirm(`Supprimer l'automate ${d.name} ?`))
                        deleteDevice(d.name).then(onChange);
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Input
          className="w-56"
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
        <Input
          className="w-40"
          placeholder="hôte/IP"
          value={nd.host}
          onChange={(e) => setNd({ ...nd, host: e.target.value })}
        />
        <Input
          className="w-56"
          placeholder="base tag (ex: brasserie.ipa)"
          value={nd.base_tag}
          onChange={(e) => setNd({ ...nd, base_tag: e.target.value })}
        />
        <Button size="sm" variant="outline" onClick={create}>
          <Plus />
          Ajouter
        </Button>
      </div>
    </Section>
  );
}

// ─── Détail d'un automate : tags + adresses + import CSV ─────────────────

function DeviceDetail({ device, onChange }: { device: string; onChange: () => void }) {
  const [tags, setTags] = useState<DeviceTag[]>([]);
  const [nt, setNt] = useState({ name: "", address: "", datatype: "DINT" });
  const [csv, setCsv] = useState("");

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
    const txt =
      `${r.imported} tag(s) importé(s)` +
      (r.errors.length ? ` — ${r.errors.length} ligne(s) ignorée(s)` : "");
    (r.errors.length ? toast.warning : toast.success)(txt);
    setCsv("");
    load();
    onChange();
  };

  return (
    <Section title={`Tags de « ${device} »`}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tag</TableHead>
            <TableHead>Adresse physique</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Unité</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tags.map((t) => (
            <TableRow key={t.name}>
              <TableCell>
                <code className="text-[var(--chart-2)]">{t.name}</code>
              </TableCell>
              <TableCell>
                <code className="text-[var(--chart-2)]">{t.address ?? "—"}</code>
              </TableCell>
              <TableCell>{t.datatype ?? "—"}</TableCell>
              <TableCell>{t.unit ?? "—"}</TableCell>
            </TableRow>
          ))}
          {tags.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="text-muted-foreground">
                Aucun tag. Ajoute-en un ou importe un CSV.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Input
          className="flex-[2]"
          placeholder="nom du tag (ex: brasserie.ipa.fermenteur.temperature)"
          value={nt.name}
          onChange={(e) => setNt({ ...nt, name: e.target.value })}
        />
        <Input
          className="flex-1"
          placeholder="adresse (ex: holding-register:1:DINT)"
          value={nt.address}
          onChange={(e) => setNt({ ...nt, address: e.target.value })}
        />
        <Button size="sm" variant="outline" onClick={addTag}>
          <Plus />
          Tag
        </Button>
      </div>

      <div className="mt-5">
        <div className="mb-1.5 text-xs text-muted-foreground">
          Import CSV — une ligne par tag : <code>tag,adresse[,type[,unité]]</code>
        </div>
        <textarea
          rows={4}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
          placeholder={
            "brasserie.ipa.fermenteur.temperature,holding-register:1:DINT,DINT,°C\n" +
            "brasserie.ipa.fermenteur.pression,holding-register:2:DINT,DINT,bar"
          }
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
        <div className="mt-2">
          <Button size="sm" onClick={doImport} disabled={!csv.trim()}>
            Importer
          </Button>
        </div>
      </div>
    </Section>
  );
}

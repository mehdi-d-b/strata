import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
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
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { TabBar } from "@/components/TabBar";
import { KpiCard } from "@/components/KpiCard";
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

type Tab = "account" | "display" | "storage" | "system";

/** Champ de formulaire : libellé au-dessus, contenu en dessous. */
function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="flex max-w-sm flex-col gap-1.5 text-sm text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

export function SettingsView() {
  const { user } = useAuth();
  const admin = userIsAdmin(user);
  const [tab, setTab] = useState<Tab>("account");

  const tabs = (
    [
      { id: "account", label: "Mon compte" },
      { id: "display", label: "Affichage" },
      { id: "storage", label: "Stockage", adminOnly: true },
      { id: "system", label: "Système", adminOnly: true },
    ] as { id: Tab; label: string; adminOnly?: boolean }[]
  ).filter((t) => !t.adminOnly || admin);

  return (
    <>
      <PageHeader title="Paramètres" description="Compte, affichage, stockage et système." />
      <TabBar tabs={tabs} value={tab} onChange={setTab} />
      {tab === "account" && <AccountSection />}
      {tab === "display" && <DisplaySection />}
      {tab === "storage" && admin && <StorageSection />}
      {tab === "system" && admin && <SystemSection />}
    </>
  );
}

// ─── Mon compte ──────────────────────────────────────────────────────────

function AccountSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      toast.error("La confirmation ne correspond pas.");
      return;
    }
    try {
      await changeMyPassword(current, next);
      toast.success("Mot de passe modifié.");
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 403
          ? "Mot de passe actuel incorrect."
          : "Échec de la modification.",
      );
    }
  };

  return (
    <Section title="Changer mon mot de passe">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Mot de passe actuel">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="Nouveau mot de passe">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Confirmer">
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={!current || !next}>
            Mettre à jour
          </Button>
        </div>
      </form>
    </Section>
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

  const save = () => {
    localStorage.setItem(PREF_KEY, JSON.stringify({ defaultWindowSec: win }));
    toast.success("Préférences enregistrées.");
  };

  return (
    <Section title="Préférences d'affichage" hint="Stocké dans ce navigateur uniquement.">
      <div className="flex flex-col gap-3">
        <Field label="Fenêtre temps réel par défaut">
          <select value={win} onChange={(e) => setWin(Number(e.target.value))}>
            <option value={300}>5 minutes</option>
            <option value={900}>15 minutes</option>
            <option value={3600}>60 minutes</option>
          </select>
        </Field>
        <div>
          <Button size="sm" onClick={save}>
            Enregistrer
          </Button>
        </div>
      </div>
    </Section>
  );
}

// ─── Stockage (Timescale) ────────────────────────────────────────────────

function StorageSection() {
  const [st, setSt] = useState<Storage | null>(null);
  const [retention, setRet] = useState(365);
  const [compress, setComp] = useState(7);

  const load = () => fetchStorage().then(setSt).catch(() => setSt(null));
  useEffect(() => {
    load();
  }, []);

  const applyRetention = async () => {
    await setRetention(retention);
    toast.success(retention === 0 ? "Purge désactivée." : `Rétention : ${retention} j.`);
    load();
  };
  const applyCompression = async () => {
    await setCompression(compress);
    toast.success(
      compress === 0 ? "Compression désactivée." : `Compression après ${compress} j.`,
    );
    load();
  };

  const ratio =
    st?.compression.before_b && st?.compression.after_b && Number(st.compression.after_b) > 0
      ? (Number(st.compression.before_b) / Number(st.compression.after_b)).toFixed(1)
      : null;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Taille (mesures)" value={st?.size.total ?? "…"} />
        <KpiCard label="Lignes" value={st?.size.rows ?? "…"} />
        <KpiCard label="Compressé" value={st?.compression.after ?? "—"} />
        <KpiCard label="Ratio compression" value={ratio ? `${ratio}×` : "—"} tone="good" />
      </div>

      <Section title="Rétention du brut">
        <p className="mb-3 text-xs text-muted-foreground">
          Supprime automatiquement les mesures plus anciennes. 0 = ne jamais purger. Les
          agrégats production/shift ne sont pas affectés.
        </p>
        <div className="flex flex-col gap-3">
          <Field label="Conserver (jours)">
            <Input
              type="number"
              min={0}
              max={3650}
              value={retention}
              onChange={(e) => setRet(Number(e.target.value))}
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={applyRetention}>
              Appliquer
            </Button>
            <span className="text-xs text-muted-foreground">
              Actuel : {st?.retention_after ?? "non configuré"}
            </span>
          </div>
        </div>
      </Section>

      <Section title="Compression">
        <p className="mb-3 text-xs text-muted-foreground">
          Compresse les chunks plus vieux que N jours (gain ~10-20×, restent interrogeables).
          0 = désactiver.
        </p>
        <div className="flex flex-col gap-3">
          <Field label="Compresser après (jours)">
            <Input
              type="number"
              min={0}
              max={3650}
              value={compress}
              onChange={(e) => setComp(Number(e.target.value))}
            />
          </Field>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={applyCompression}>
              Appliquer
            </Button>
            <span className="text-xs text-muted-foreground">
              Actuel : {st?.compress_after ?? "non configuré"}
            </span>
          </div>
        </div>
      </Section>
    </>
  );
}

// ─── Système ─────────────────────────────────────────────────────────────

function SystemSection() {
  const [sys, setSys] = useState<SystemInfo | null>(null);
  useEffect(() => {
    fetchSystem().then(setSys).catch(() => setSys(null));
  }, []);

  if (!sys) {
    return (
      <Section title="Système">
        <p className="text-sm text-muted-foreground">Chargement…</p>
      </Section>
    );
  }

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Tags" value={sys.counts.tags} />
        <KpiCard label="Automates" value={sys.counts.devices} />
        <KpiCard label="Utilisateurs" value={sys.counts.users} />
        <KpiCard label="Mesures" value={sys.counts.mesures} />
      </div>

      <Section title="Versions">
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>TimescaleDB</TableCell>
              <TableCell>
                <code className="text-[var(--chart-2)]">{sys.timescaledb_version}</code>
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Node (gateway)</TableCell>
              <TableCell>
                <code className="text-[var(--chart-2)]">{sys.node_version}</code>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Section>

      <Section title="Connecteurs PLC4X">
        {sys.connectors.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aucun connecteur (profil plc4x non démarré ou aucun déployé).
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Connecteur</TableHead>
                <TableHead>État</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sys.connectors.map((c) => (
                <TableRow key={c.name}>
                  <TableCell>
                    <code className="text-[var(--chart-2)]">{c.name}</code>
                  </TableCell>
                  <TableCell>
                    <span className={`status ${c.state === "RUNNING" ? "live" : "off"}`}>
                      {c.state}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </>
  );
}

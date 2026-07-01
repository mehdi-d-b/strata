import { useEffect, useRef, useState } from "react";
import { Check, Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  ALARM_OPERATORS,
  deleteAlarmRule,
  fetchAlarmRules,
  saveAlarmRule,
  userIsAdmin,
  type AlarmOperator,
  type AlarmRule,
  type Severity,
} from "./api";
import { useAlarms } from "./alarms";
import { useAuth } from "./auth";
import { readSpreadsheet, rowsToRules } from "./alarmImport";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { TabBar } from "@/components/TabBar";
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
import { cn } from "@/lib/utils";

const SEV_LABEL: Record<Severity, string> = {
  critical: "Critique",
  warning: "Warning",
  info: "Info",
};
const SEV_CLASS: Record<Severity, string> = {
  critical: "border-bad/45 text-bad",
  warning: "border-warn/45 text-warn",
  info: "border-chart-2/45 text-chart-2",
};

function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-md border px-2 py-0.5 text-xs font-medium",
        SEV_CLASS[severity],
      )}
    >
      {SEV_LABEL[severity]}
    </span>
  );
}

function since(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return new Date(iso).toLocaleString();
}

type Tab = "current" | "rules";

export function AlarmsView() {
  const { user } = useAuth();
  const admin = userIsAdmin(user);
  const [tab, setTab] = useState<Tab>("current");

  return (
    <>
      <PageHeader
        title="Alarmes"
        description="Alarmes actives et configuration des seuils."
      />
      {admin && (
        <TabBar
          tabs={[
            { id: "current", label: "Alarmes courantes" },
            { id: "rules", label: "Règles de seuil" },
          ]}
          value={tab}
          onChange={setTab}
        />
      )}
      {(!admin || tab === "current") && <CurrentSection />}
      {admin && tab === "rules" && <RulesSection />}
    </>
  );
}

// ─── Alarmes courantes (résumé + filtres + liste) ────────────────────────

const SEVERITIES: Severity[] = ["critical", "warning", "info"];

function FilterChip({
  label,
  count,
  active,
  tone,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  tone?: Severity;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
        active ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
        tone ? SEV_CLASS[tone] : "border-border",
      )}
    >
      {label}
      <span className="tabular-nums font-semibold">{count}</span>
    </button>
  );
}

function CurrentSection() {
  const { alarms, ack, ackAll } = useAlarms();
  const [sev, setSev] = useState<Severity | "all">("all");
  const [onlyUnacked, setOnlyUnacked] = useState(false);
  const [state, setState] = useState<"all" | "active" | "cleared">("all");

  const bySev: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
  for (const a of alarms) bySev[a.severity] += 1;
  const unacked = alarms.filter((a) => !a.acked).length;

  const filtered = alarms.filter(
    (a) =>
      (sev === "all" || a.severity === sev) &&
      (!onlyUnacked || !a.acked) &&
      (state === "all" || a.state === state),
  );

  const toggleSev = (s: Severity) => setSev((cur) => (cur === s ? "all" : s));

  return (
    <Section
      title="Alarmes courantes"
      action={
        unacked > 0 ? (
          <Button size="sm" variant="outline" onClick={() => ackAll()}>
            <Check />
            Tout acquitter ({unacked})
          </Button>
        ) : undefined
      }
    >
      {/* Résumé par sévérité (cliquable = filtre) + filtres */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterChip
          label="Toutes"
          count={alarms.length}
          active={sev === "all"}
          onClick={() => setSev("all")}
        />
        {SEVERITIES.map((s) => (
          <FilterChip
            key={s}
            label={SEV_LABEL[s]}
            count={bySev[s]}
            tone={s}
            active={sev === s}
            onClick={() => toggleSev(s)}
          />
        ))}
        <span className="mx-1 h-5 w-px bg-border" />
        <select value={state} onChange={(e) => setState(e.target.value as typeof state)}>
          <option value="all">Tous états</option>
          <option value="active">Actives</option>
          <option value="cleared">Rétablies</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={onlyUnacked}
            onChange={(e) => setOnlyUnacked(e.target.checked)}
          />
          Non acquittées
        </label>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Sévérité</TableHead>
            <TableHead>Tag</TableHead>
            <TableHead>Message</TableHead>
            <TableHead>Depuis</TableHead>
            <TableHead>État</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((a) => (
            <TableRow key={a.id}>
              <TableCell>
                <SeverityBadge severity={a.severity} />
              </TableCell>
              <TableCell>
                <code className="text-[var(--chart-2)]">{a.tag}</code>
              </TableCell>
              <TableCell>{a.message}</TableCell>
              <TableCell className="tabular-nums text-muted-foreground">
                {since(a.raised_at)}
              </TableCell>
              <TableCell>
                {a.state === "active" ? (
                  <span className="text-bad">● active</span>
                ) : (
                  <span className="text-muted-foreground">○ rétablie</span>
                )}
              </TableCell>
              <TableCell>
                {a.acked ? (
                  <span className="text-xs text-muted-foreground">
                    acq. {a.acked_by ?? ""}
                  </span>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => ack(a.id)}>
                    <Check />
                    Acquitter
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
          {filtered.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-muted-foreground">
                {alarms.length === 0
                  ? "Aucune alarme. Tout est nominal."
                  : "Aucune alarme ne correspond aux filtres."}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Section>
  );
}

// ─── Configuration des règles de seuil (admin) ───────────────────────────

const BLANK = {
  tag: "",
  operator: ">" as AlarmOperator,
  threshold: 0,
  severity: "critical" as Severity,
  message: "",
  enabled: true,
  ref_tag: "",
  tolerance: 0,
};

function RulesSection() {
  const [rules, setRules] = useState<AlarmRule[]>([]);
  const [nu, setNu] = useState({ ...BLANK });
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => fetchAlarmRules().then(setRules).catch(() => setRules([]));
  useEffect(() => {
    load();
  }, []);

  const onImport = async (file: File) => {
    try {
      const parsed = rowsToRules(await readSpreadsheet(file));
      if (parsed.length === 0) {
        toast.error("Aucune règle valide dans le fichier.");
        return;
      }
      await Promise.all(parsed.map((r) => saveAlarmRule(r)));
      toast.success(`${parsed.length} règle(s) importée(s).`);
      load();
    } catch {
      toast.error("Import impossible.");
    }
  };

  const patch = (id: string, p: Partial<AlarmRule>) =>
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  const save = async (rule: AlarmRule) => {
    try {
      await saveAlarmRule(rule);
      toast.success("Règle enregistrée.");
      load();
    } catch {
      toast.error("Enregistrement impossible (endpoint indisponible ?).");
    }
  };

  const add = async () => {
    if (!nu.tag.trim()) return;
    try {
      await saveAlarmRule({
        ...nu,
        message: nu.message || null,
        ref_tag: nu.ref_tag.trim() || null,
        tolerance: nu.ref_tag.trim() ? nu.tolerance : null,
      });
      setNu({ ...BLANK });
      load();
    } catch {
      toast.error("Création impossible (endpoint indisponible ?).");
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteAlarmRule(id);
      load();
    } catch {
      toast.error("Suppression impossible.");
    }
  };

  return (
    <Section
      title="Règles de seuil"
      action={
        <>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImport(f);
              e.target.value = "";
            }}
          />
          <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload />
            Importer
          </Button>
        </>
      }
      hint={
        <>
          Plusieurs règles par tag sont possibles (ex. un <code>hi</code> et un{" "}
          <code>hihi</code>). Le message est généré si laissé vide. Import CSV/Excel —
          colonnes : <code>tag, opérateur, seuil, sévérité, message</code> (opérateur/seuil
          vides = alarme booléenne <code>== 1</code>). Mode <b>bande</b> : renseigne un tag de
          référence (ex. une consigne) — la règle compare alors à sa valeur courante ± la
          tolérance, et ignore opérateur/seuil.
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tag</TableHead>
            <TableHead>Cond.</TableHead>
            <TableHead>Seuil</TableHead>
            <TableHead>Réf. (bande)</TableHead>
            <TableHead>Tolérance</TableHead>
            <TableHead>Sévérité</TableHead>
            <TableHead>Message</TableHead>
            <TableHead>Actif</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.map((r) => (
            <TableRow key={r.id}>
              <TableCell>
                <Input
                  className="w-56"
                  value={r.tag}
                  onChange={(e) => patch(r.id, { tag: e.target.value })}
                />
              </TableCell>
              <TableCell>
                <select
                  value={r.operator}
                  onChange={(e) => patch(r.id, { operator: e.target.value as AlarmOperator })}
                >
                  {ALARM_OPERATORS.map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
                </select>
              </TableCell>
              <TableCell>
                <Input
                  type="number"
                  step="any"
                  className="w-24"
                  value={r.threshold}
                  onChange={(e) => patch(r.id, { threshold: Number(e.target.value) })}
                />
              </TableCell>
              <TableCell>
                <Input
                  className="w-40"
                  placeholder="tag de référence"
                  value={r.ref_tag ?? ""}
                  onChange={(e) => patch(r.id, { ref_tag: e.target.value || null })}
                />
              </TableCell>
              <TableCell>
                <Input
                  type="number"
                  step="any"
                  className="w-20"
                  value={r.tolerance ?? ""}
                  onChange={(e) => patch(r.id, { tolerance: e.target.value === "" ? null : Number(e.target.value) })}
                />
              </TableCell>
              <TableCell>
                <select
                  value={r.severity}
                  onChange={(e) => patch(r.id, { severity: e.target.value as Severity })}
                >
                  <option value="critical">Critique</option>
                  <option value="warning">Warning</option>
                  <option value="info">Info</option>
                </select>
              </TableCell>
              <TableCell>
                <Input
                  className="w-48"
                  value={r.message ?? ""}
                  onChange={(e) => patch(r.id, { message: e.target.value })}
                />
              </TableCell>
              <TableCell>
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={(e) => patch(r.id, { enabled: e.target.checked })}
                />
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  <Button size="sm" onClick={() => save(r)}>
                    Enregistrer
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    title="Supprimer"
                    onClick={() => remove(r.id)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
          {rules.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="text-muted-foreground">
                Aucune règle. Ajoute-en une ci-dessous ou importe un fichier.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Input
          className="w-56"
          placeholder="tag (ex: brasserie.blonde.four.temperature)"
          value={nu.tag}
          onChange={(e) => setNu({ ...nu, tag: e.target.value })}
        />
        <select
          value={nu.operator}
          onChange={(e) => setNu({ ...nu, operator: e.target.value as AlarmOperator })}
        >
          {ALARM_OPERATORS.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
        <Input
          type="number"
          step="any"
          className="w-24"
          placeholder="seuil"
          value={nu.threshold}
          onChange={(e) => setNu({ ...nu, threshold: Number(e.target.value) })}
        />
        <Input
          className="w-40"
          placeholder="tag de référence (bande)"
          value={nu.ref_tag}
          onChange={(e) => setNu({ ...nu, ref_tag: e.target.value })}
        />
        <Input
          type="number"
          step="any"
          className="w-20"
          placeholder="tolérance"
          value={nu.tolerance}
          onChange={(e) => setNu({ ...nu, tolerance: Number(e.target.value) })}
        />
        <select
          value={nu.severity}
          onChange={(e) => setNu({ ...nu, severity: e.target.value as Severity })}
        >
          <option value="critical">Critique</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
        <Input
          className="w-48"
          placeholder="message (optionnel)"
          value={nu.message}
          onChange={(e) => setNu({ ...nu, message: e.target.value })}
        />
        <Button size="sm" variant="outline" onClick={add}>
          <Plus />
          Ajouter
        </Button>
      </div>
    </Section>
  );
}

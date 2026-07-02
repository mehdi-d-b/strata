import { useEffect, useMemo, useState } from "react";
import type uPlot from "uplot";
import { X } from "lucide-react";
import { fetchAlarmRules, fetchHistoryRange, fetchTagStats, type Alarm, type AlarmRule } from "./api";
import { useAlarms } from "./alarms";
import { MultiChart, type SeriesDef } from "./MultiChart";
import { PageHeader } from "@/components/PageHeader";
import { cn } from "@/lib/utils";

/** Dernier(s) segments du nom de tag, capitalisés — même idiome que BatchesView. */
function tagLabel(tag: string): string {
  return tag
    .split(".")
    .slice(-2)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" · ");
}

function modeLabel(rule: AlarmRule): string {
  if (rule.ref_tag) return `Bande vs ${rule.ref_tag} (± ${rule.tolerance})`;
  if (rule.baseline_sigma != null) return `Self-baseline (σ = ${rule.baseline_sigma})`;
  return "Seuil fixe";
}

type Status = "ok" | "warning" | "critical" | "info";

const STATUS_CFG: Record<Status, { label: string; className: string }> = {
  ok: { label: "Nominal", className: "border-good/45 text-good" },
  warning: { label: "Vigilance", className: "border-warn/45 text-warn" },
  critical: { label: "Critique", className: "border-bad/45 text-bad" },
  info: { label: "Info", className: "border-chart-2/45 text-chart-2" },
};

function HealthBadge({ status }: { status: Status }) {
  const c = STATUS_CFG[status];
  return (
    <span className={cn("inline-flex rounded-md border px-2 py-0.5 text-xs font-medium", c.className)}>
      {c.label}
    </span>
  );
}

// ─── Panneau de détail (drawer) — même idiome que BatchesView.DetailPanel ───

function DetailPanel({ rule, onClose }: { rule: AlarmRule; onClose: () => void }) {
  const [chartData, setChartData] = useState<uPlot.AlignedData>([[]]);
  const [loading, setLoading] = useState(true);

  // Mode bande : la courbe + son tag de référence (l'équivalent visuel d'une bande).
  // Mode self-baseline : la courbe + ses tendances lissées 1 min / 5 min (ce que la
  // règle compare réellement, cf. gateway/src/alarms.ts).
  const series: SeriesDef[] = useMemo(() => {
    if (rule.ref_tag) {
      return [
        { tag: rule.tag, label: tagLabel(rule.tag), color: "#3b82f6", axis: "left" as const },
        { tag: rule.ref_tag, label: `Référence (${rule.ref_tag})`, color: "#94a3b8", axis: "left" as const },
      ];
    }
    return [
      { tag: rule.tag, label: "Valeur", color: "#3b82f6", axis: "left" as const },
      { tag: `${rule.tag}::1m`, label: "Tendance 1 min", color: "#22c55e", axis: "left" as const },
      { tag: `${rule.tag}::5m`, label: "Tendance 5 min", color: "#f97316", axis: "left" as const },
    ];
  }, [rule]);

  useEffect(() => {
    setLoading(true);
    setChartData([[]]);
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 3 * 60 * 60_000).toISOString();

    const fetches = rule.ref_tag
      ? [fetchHistoryRange(rule.tag, from, to), fetchHistoryRange(rule.ref_tag, from, to)]
      : [
          fetchHistoryRange(rule.tag, from, to),
          fetchTagStats(rule.tag, "1m", from, to),
          fetchTagStats(rule.tag, "5m", from, to),
        ];

    Promise.all(fetches)
      .then((results) => {
        const tsSet = new Set<number>();
        for (const r of results) for (const row of r) tsSet.add(new Date(row.ts).getTime() / 1000);
        const xs = Array.from(tsSet).sort((a, b) => a - b);
        const pos = new Map(xs.map((t, i) => [t, i]));
        const cols = results.map((r) => {
          const col: (number | null)[] = new Array(xs.length).fill(null);
          r.forEach((row) => {
            const p = pos.get(new Date(row.ts).getTime() / 1000);
            if (p !== undefined) col[p] = row.value;
          });
          return col;
        });
        setChartData([xs, ...cols] as uPlot.AlignedData);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [rule]);

  const hasChart = !loading && (chartData[0] as number[]).length > 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative z-10 flex w-full max-w-xl flex-col overflow-y-auto border-l border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <div className="font-semibold">{tagLabel(rule.tag)}</div>
            <div className="text-xs text-muted-foreground">{rule.tag}</div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 space-y-5 p-5">
          <div className="space-y-0.5 text-sm">
            <div className="text-xs text-muted-foreground">Mode</div>
            <div className="font-medium">{modeLabel(rule)}</div>
          </div>

          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Dernières 3 heures
            </div>
            {loading ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                Chargement…
              </div>
            ) : !hasChart ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                Pas de données sur cette fenêtre.
              </div>
            ) : (
              <MultiChart data={chartData} series={series} height={220} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Grille — même idiome que OeeView (grid + carte par entité) ────────────

function RuleCard({
  rule,
  activeAlarm,
  onSelect,
}: {
  rule: AlarmRule;
  activeAlarm: Alarm | undefined;
  onSelect: () => void;
}) {
  const status: Status = activeAlarm ? activeAlarm.severity : "ok";
  return (
    <button
      onClick={onSelect}
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium">{tagLabel(rule.tag)}</div>
        <HealthBadge status={status} />
      </div>
      <div className="text-xs text-muted-foreground">{modeLabel(rule)}</div>
      {activeAlarm && <div className="text-xs text-bad">{activeAlarm.message}</div>}
    </button>
  );
}

export function HealthView() {
  const [rules, setRules] = useState<AlarmRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<AlarmRule | null>(null);
  const { alarms } = useAlarms();

  useEffect(() => {
    // Cette page est la vitrine des modes bande/self-baseline uniquement — les
    // règles à seuil fixe restent dans Alarmes (pas un "équipement surveillé" ici).
    fetchAlarmRules()
      .then((rs) => setRules(rs.filter((r) => r.ref_tag != null || r.baseline_sigma != null)))
      .catch(() => setRules([]))
      .finally(() => setLoading(false));
  }, []);

  const activeByRuleId = useMemo(() => {
    const m = new Map<string, Alarm>();
    for (const a of alarms) if (a.state === "active" && a.rule_id) m.set(a.rule_id, a);
    return m;
  }, [alarms]);

  return (
    <>
      <PageHeader
        title="Santé équipement"
        description="Tags surveillés en mode bande (vs consigne) ou self-baseline (dérive)."
      />
      {loading ? (
        <div className="text-sm text-muted-foreground">Chargement…</div>
      ) : rules.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Aucun équipement surveillé. Crée une règle en mode bande ou self-baseline depuis
          Alarmes → Règles de seuil.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rules.map((r) => (
            <RuleCard
              key={r.id}
              rule={r}
              activeAlarm={activeByRuleId.get(r.id)}
              onSelect={() => setSelected(r)}
            />
          ))}
        </div>
      )}
      {selected && <DetailPanel rule={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

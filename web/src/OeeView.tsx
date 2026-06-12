import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  fetchDowntime,
  fetchOee,
  type DowntimeKind,
  type DowntimeRow,
  type OeeRow,
} from "./api";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const DAYS = [
  { label: "1 jour", v: 1 },
  { label: "7 jours", v: 7 },
  { label: "30 jours", v: 30 },
];

/** Couleur sémantique d'un facteur (tokens) : ≥85 % vert, 60–85 % ambre, sinon rouge. */
function toneVar(v: number | null): string {
  if (v == null) return "var(--muted-foreground)";
  if (v >= 0.85) return "var(--good)";
  if (v >= 0.6) return "var(--warn)";
  return "var(--bad)";
}

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)} %`);
const tint = (color: string) => `color-mix(in srgb, ${color} 22%, transparent)`;

/** Pour un shift EN COURS, on compare au temps écoulé (sinon faux % en milieu de shift). */
const dispoOf = (r: OeeRow) => (r.is_current ? r.availability_elapsed : r.availability);
const oeeOf = (r: OeeRow): number | null => {
  if (!r.is_current) return r.oee;
  const a = r.availability_elapsed;
  return a != null && r.performance != null && r.quality != null
    ? a * r.performance * r.quality
    : null;
};

/** Couleur de remplissage d'une barre objectif (sur `on_track` si dispo, sinon ratio). */
function fillColor(ratio: number | null, onTrack: boolean | null): string {
  if (onTrack === true) return "var(--good)";
  if (onTrack === false) return ratio != null && ratio >= 0.8 ? "var(--warn)" : "var(--bad)";
  if (ratio == null) return "var(--muted-foreground)";
  return ratio >= 1 ? "var(--good)" : ratio >= 0.8 ? "var(--warn)" : "var(--bad)";
}

function OnTrackPill({ onTrack }: { onTrack: boolean | null }) {
  if (onTrack == null) return null;
  return (
    <span
      className={
        onTrack
          ? "rounded-full border border-good/45 px-2 py-0.5 text-[11px] text-good"
          : "rounded-full border border-bad/45 px-2 py-0.5 text-[11px] text-bad"
      }
    >
      {onTrack ? "Dans les temps" : "Sous l'objectif"}
    </span>
  );
}

// ─── Jauge circulaire (OEE) ──────────────────────────────────────────────

function OeeGauge({ value }: { value: number | null }) {
  const R = 52;
  const C = 2 * Math.PI * R;
  const frac = value == null ? 0 : Math.min(1, Math.max(0, value));
  return (
    <svg viewBox="0 0 120 120" className="size-32 shrink-0">
      <circle cx="60" cy="60" r={R} fill="none" stroke="var(--border)" strokeWidth="10" />
      <circle
        cx="60"
        cy="60"
        r={R}
        fill="none"
        stroke={toneVar(value)}
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={C * (1 - frac)}
        transform="rotate(-90 60 60)"
      />
      <text x="60" y="58" textAnchor="middle" fontSize="26" fontWeight="700" fill="var(--foreground)">
        {value == null ? "—" : Math.round(value * 100)}
      </text>
      <text x="60" y="78" textAnchor="middle" fontSize="11" fill="var(--muted-foreground)">
        OEE %
      </text>
    </svg>
  );
}

// ─── Barre de facteur (A / P / Q) avec repère 85 % ───────────────────────

function Factor({ label, value }: { label: string; value: number | null }) {
  const w = value == null ? 0 : Math.min(1, Math.max(0, value)) * 100;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums" style={{ color: toneVar(value) }}>
          {pct(value)}
        </span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full" style={{ width: `${w}%`, background: toneVar(value) }} />
        <div className="absolute top-0 h-full w-px bg-foreground/40" style={{ left: "85%" }} />
      </div>
    </div>
  );
}

// ─── Cascade des pertes (où part le temps) ───────────────────────────────

function Waterfall({
  a,
  p,
  q,
  oee,
  onPickLoss,
}: {
  a: number | null;
  p: number | null;
  q: number | null;
  oee: number | null;
  onPickLoss?: (kind: DowntimeKind) => void;
}) {
  if (a == null || p == null || q == null || oee == null) {
    return <div className="text-xs text-muted-foreground">Cascade indisponible (données incomplètes).</div>;
  }
  const segs = [
    { label: "OEE", val: oee * 100, color: toneVar(oee), kind: undefined },
    { label: "Perte dispo", val: (1 - a) * 100, color: "var(--chart-2)", kind: "downtime" as const },
    { label: "Perte perf", val: a * (1 - p) * 100, color: "var(--warn)", kind: "performance" as const },
    { label: "Perte qualité", val: (a * p - oee) * 100, color: "var(--bad)", kind: undefined },
  ];
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full">
        {segs.map(
          (s) => s.val > 0.5 && <div key={s.label} style={{ width: `${s.val}%`, background: s.color }} />,
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {segs.map((s) => {
          const dot = <span className="size-2 rounded-full" style={{ background: s.color }} />;
          const txt = (
            <>
              {dot} {s.label} <span className="tabular-nums">{Math.round(s.val)} %</span>
            </>
          );
          return s.kind && onPickLoss ? (
            <button
              key={s.label}
              onClick={() => onPickLoss(s.kind!)}
              title="Voir le Pareto des motifs"
              className="inline-flex items-center gap-1.5 underline-offset-2 hover:text-foreground hover:underline"
            >
              {txt}
            </button>
          ) : (
            <span key={s.label} className="inline-flex items-center gap-1.5">
              {txt}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ─── Mini-tendance (OEE des derniers shifts) ─────────────────────────────

function Trend({ rows }: { rows: OeeRow[] }) {
  const last = rows.slice(-14);
  return (
    <div className="flex h-10 items-end gap-0.5">
      {last.map((r, i) => {
        const v = oeeOf(r);
        return (
          <div
            key={i}
            className="w-2 flex-1 rounded-sm"
            title={`${r.day.slice(0, 10)} · ${r.shift_label ?? `#${r.shift_no}`} : ${pct(v)}`}
            style={{ height: `${(v ?? 0) * 100}%`, minHeight: 2, background: toneVar(v) }}
          />
        );
      })}
    </div>
  );
}

// ─── Carte par ligne ─────────────────────────────────────────────────────

function LineCard({
  rows,
  onPickLoss,
}: {
  rows: OeeRow[];
  onPickLoss?: (line: string, kind: DowntimeKind) => void;
}) {
  const r = rows[rows.length - 1];
  const a = dispoOf(r);
  const oee = oeeOf(r);
  return (
    <Card className="gap-4 py-5">
      <div className="flex items-baseline justify-between px-5">
        <h3 className="font-semibold">{r.line_label ?? r.line}</h3>
        <span className="text-xs text-muted-foreground">
          {r.is_current ? "Shift en cours" : "Dernier shift"} {r.shift_label ?? `#${r.shift_no}`} ·{" "}
          {r.day.slice(0, 10)}
        </span>
      </div>
      <CardContent className="grid grid-cols-[auto_1fr] items-center gap-5 px-5">
        <div className="flex flex-col items-center gap-1">
          <OeeGauge value={oee} />
          {r.target_oee != null && (
            <div className="text-[11px] text-muted-foreground">Cible {pct(r.target_oee)}</div>
          )}
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Factor label="Dispo" value={a} />
            <Factor label="Perf" value={r.performance} />
            <Factor label="Qualité" value={r.quality} />
          </div>
          <Waterfall
            a={a}
            p={r.performance}
            q={r.quality}
            oee={oee}
            onPickLoss={onPickLoss ? (k) => onPickLoss(r.line, k) : undefined}
          />
        </div>
      </CardContent>

      {/* Objectif pièces + projection fin de shift */}
      {r.target_pieces != null && (
        <div className="space-y-1.5 px-5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Objectif pièces{r.is_current ? " · projection à l'allure actuelle" : ""}</span>
            <OnTrackPill onTrack={r.on_track} />
          </div>
          <div className="relative h-2.5 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(1, r.pieces_ratio ?? 0) * 100}%`,
                background: fillColor(r.pieces_ratio, r.on_track),
              }}
            />
          </div>
          <div className="flex justify-between text-xs tabular-nums">
            <span className="text-foreground">
              <strong>{r.produced ?? "—"}</strong>
              {r.is_current && r.projected_pieces != null && (
                <span className="text-muted-foreground"> → {r.projected_pieces} fin de shift</span>
              )}
            </span>
            <span className="text-muted-foreground">/ {r.target_pieces}</span>
          </div>
        </div>
      )}

      {rows.length > 1 && (
        <div className="px-5">
          <div className="mb-1 text-xs text-muted-foreground">Tendance OEE</div>
          <Trend rows={rows} />
        </div>
      )}
    </Card>
  );
}

/** Cellule avec barre de données (fond rempli proportionnellement). */
function DataBarCell({
  ratio,
  color,
  children,
}: {
  ratio: number | null;
  color: string;
  children: ReactNode;
}) {
  return (
    <TableCell className="relative min-w-36">
      {ratio != null && (
        <div
          className="absolute inset-y-1 left-0 rounded-r-sm"
          style={{ width: `${Math.min(1, ratio) * 100}%`, background: tint(color) }}
        />
      )}
      <span className="relative tabular-nums">{children}</span>
    </TableCell>
  );
}

// ─── Pareto des motifs d'arrêt ───────────────────────────────────────────

const KIND_LABEL: Record<DowntimeKind, string> = {
  downtime: "Disponibilité",
  performance: "Performance",
};

function fmtMin(m: number): string {
  const r = Math.round(m);
  return r < 60 ? `${r} min` : `${Math.floor(r / 60)} h ${r % 60} min`;
}

function ParetoSection({
  downtime,
  lineOptions,
  line,
  kind,
  setLine,
  setKind,
  innerRef,
}: {
  downtime: DowntimeRow[];
  lineOptions: { line: string; label: string }[];
  line: string;
  kind: "all" | DowntimeKind;
  setLine: (l: string) => void;
  setKind: (k: "all" | DowntimeKind) => void;
  innerRef: React.RefObject<HTMLDivElement>;
}) {
  const agg = useMemo(() => {
    const filtered = downtime.filter(
      (d) => (line === "all" || d.line === line) && (kind === "all" || d.kind === kind),
    );
    const map = new Map<string, { label: string; color: string; minutes: number }>();
    for (const d of filtered) {
      const e = map.get(d.reason_code) ?? { label: d.reason_label, color: d.color, minutes: 0 };
      e.minutes += d.minutes;
      map.set(d.reason_code, e);
    }
    return [...map.entries()]
      .map(([code, e]) => ({ code, ...e }))
      .sort((x, y) => y.minutes - x.minutes);
  }, [downtime, line, kind]);

  const total = agg.reduce((s, x) => s + x.minutes, 0);
  const max = agg[0]?.minutes ?? 1;
  let cum = 0;

  return (
    <div ref={innerRef}>
      <Section
        title="Pareto des pertes (motifs d'arrêt)"
        action={
          <div className="flex items-center gap-2">
            <select value={line} onChange={(e) => setLine(e.target.value)}>
              <option value="all">Toutes lignes</option>
              {lineOptions.map((o) => (
                <option key={o.line} value={o.line}>
                  {o.label}
                </option>
              ))}
            </select>
            <div className="range">
              {(["all", "downtime", "performance"] as const).map((k) => (
                <button key={k} className={kind === k ? "active" : ""} onClick={() => setKind(k)}>
                  {k === "all" ? "Tous" : KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>
        }
      >
        {agg.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            Aucune perte enregistrée sur la période (ou endpoint downtime indisponible).
          </div>
        ) : (
          <div className="space-y-1.5">
            {agg.map((item) => {
              cum += item.minutes;
              const cumPct = total ? Math.round((cum / total) * 100) : 0;
              return (
                <div key={item.code} className="flex items-center gap-3 text-sm">
                  <div className="w-44 shrink-0 truncate" title={item.label}>
                    {item.label}
                  </div>
                  <div className="relative h-5 flex-1 overflow-hidden rounded bg-secondary">
                    <div
                      className="h-full rounded"
                      style={{ width: `${(item.minutes / max) * 100}%`, background: item.color }}
                    />
                  </div>
                  <div className="w-20 shrink-0 text-right tabular-nums">{fmtMin(item.minutes)}</div>
                  <div className="w-12 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    {cumPct} %
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}

// ─── Vue ─────────────────────────────────────────────────────────────────

export function OeeView() {
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<OeeRow[]>([]);
  const [downtime, setDowntime] = useState<DowntimeRow[]>([]);
  const [paretoLine, setParetoLine] = useState<string>("all");
  const [paretoKind, setParetoKind] = useState<"all" | DowntimeKind>("all");
  const paretoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchOee(days).then(setRows).catch(() => setRows([]));
    fetchDowntime(days).then(setDowntime).catch(() => setDowntime([]));
  }, [days]);

  const lines = useMemo(() => {
    const map = new Map<string, OeeRow[]>();
    for (const r of rows) {
      const arr = map.get(r.line) ?? [];
      arr.push(r);
      map.set(r.line, arr);
    }
    for (const arr of map.values())
      arr.sort((x, y) => x.day.localeCompare(y.day) || x.shift_no - y.shift_no);
    return [...map.values()];
  }, [rows]);

  const lineOptions = useMemo(
    () => lines.map((rs) => ({ line: rs[0].line, label: rs[0].line_label ?? rs[0].line })),
    [lines],
  );

  const onPickLoss = (line: string, kind: DowntimeKind) => {
    setParetoLine(line);
    setParetoKind(kind);
    paretoRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <>
      <PageHeader
        title="OEE"
        description="Disponibilité × Performance × Qualité, par ligne et par shift. Repère world-class : 85 %."
        actions={
          <div className="range">
            {DAYS.map((d) => (
              <button key={d.v} className={days === d.v ? "active" : ""} onClick={() => setDays(d.v)}>
                {d.label}
              </button>
            ))}
          </div>
        }
      />

      {lines.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Aucune donnée OEE. Vérifie que le backend OEE est déployé (gateway + vues SQL) et
          qu'au moins une ligne est configurée (cadence nominale + tag « running »).
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {lines.map((rs) => (
            <LineCard key={rs[0].line} rows={rs} onPickLoss={onPickLoss} />
          ))}
        </div>
      )}

      {lines.length > 0 && (
        <ParetoSection
          downtime={downtime}
          lineOptions={lineOptions}
          line={paretoLine}
          kind={paretoKind}
          setLine={setParetoLine}
          setKind={setParetoKind}
          innerRef={paretoRef}
        />
      )}

      {rows.length > 0 && (
        <Section title="Détail par shift">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ligne</TableHead>
                <TableHead>Jour</TableHead>
                <TableHead>Shift</TableHead>
                <TableHead>Dispo</TableHead>
                <TableHead>Perf</TableHead>
                <TableHead>Qualité</TableHead>
                <TableHead>OEE</TableHead>
                <TableHead>Objectif (pièces)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => {
                const a = dispoOf(r);
                const oee = oeeOf(r);
                return (
                  <TableRow key={`${r.line}-${r.day}-${r.shift_no}-${i}`}>
                    <TableCell>{r.line_label ?? r.line}</TableCell>
                    <TableCell className="tabular-nums">{r.day.slice(0, 10)}</TableCell>
                    <TableCell>
                      {r.shift_label ?? `#${r.shift_no}`}
                      {r.is_current && <span className="ml-1 text-[10px] text-good">● en cours</span>}
                    </TableCell>
                    <TableCell className="tabular-nums" style={{ color: toneVar(a) }}>
                      {pct(a)}
                    </TableCell>
                    <TableCell className="tabular-nums" style={{ color: toneVar(r.performance) }}>
                      {pct(r.performance)}
                    </TableCell>
                    <TableCell className="tabular-nums" style={{ color: toneVar(r.quality) }}>
                      {pct(r.quality)}
                    </TableCell>
                    <TableCell className="font-semibold tabular-nums" style={{ color: toneVar(oee) }}>
                      {pct(oee)}
                    </TableCell>
                    {r.target_pieces != null ? (
                      <DataBarCell ratio={r.pieces_ratio} color={fillColor(r.pieces_ratio, r.on_track)}>
                        {r.produced ?? "—"} / {r.target_pieces}
                        {r.is_current && r.projected_pieces != null && (
                          <span className="text-muted-foreground"> → {r.projected_pieces}</span>
                        )}
                      </DataBarCell>
                    ) : (
                      <TableCell className="text-muted-foreground">—</TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Section>
      )}
    </>
  );
}

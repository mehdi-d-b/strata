import { useEffect, useMemo, useState } from "react";
import { fetchOee, type OeeRow } from "./api";
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

function Waterfall({ r }: { r: OeeRow }) {
  const { availability: a, performance: p, quality: q, oee } = r;
  if (a == null || p == null || q == null || oee == null) {
    return (
      <div className="text-xs text-muted-foreground">
        Cascade indisponible (données incomplètes).
      </div>
    );
  }
  const segs = [
    { label: "OEE", val: oee * 100, color: toneVar(oee) },
    { label: "Perte dispo", val: (1 - a) * 100, color: "var(--chart-2)" },
    { label: "Perte perf", val: a * (1 - p) * 100, color: "var(--warn)" },
    { label: "Perte qualité", val: (a * p - oee) * 100, color: "var(--bad)" },
  ];
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full">
        {segs.map(
          (s) =>
            s.val > 0.5 && <div key={s.label} style={{ width: `${s.val}%`, background: s.color }} />,
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {segs.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: s.color }} />
            {s.label} <span className="tabular-nums">{Math.round(s.val)} %</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Mini-tendance (OEE des derniers shifts) ─────────────────────────────

function Trend({ rows }: { rows: OeeRow[] }) {
  const last = rows.slice(-14);
  return (
    <div className="flex h-10 items-end gap-0.5">
      {last.map((r, i) => (
        <div
          key={i}
          className="w-2 flex-1 rounded-sm"
          title={`${r.day} · ${r.shift_label ?? `#${r.shift_no}`} : ${pct(r.oee)}`}
          style={{
            height: `${(r.oee ?? 0) * 100}%`,
            minHeight: 2,
            background: toneVar(r.oee),
          }}
        />
      ))}
    </div>
  );
}

// ─── Carte par ligne ─────────────────────────────────────────────────────

function LineCard({ rows }: { rows: OeeRow[] }) {
  const current = rows[rows.length - 1];
  return (
    <Card className="gap-4 py-5">
      <div className="flex items-baseline justify-between px-5">
        <h3 className="font-semibold">{current.line_label ?? current.line}</h3>
        <span className="text-xs text-muted-foreground">
          Shift {current.shift_label ?? `#${current.shift_no}`} · {current.day.slice(0, 10)}
        </span>
      </div>
      <CardContent className="grid grid-cols-[auto_1fr] items-center gap-5 px-5">
        <OeeGauge value={current.oee} />
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Factor label="Dispo" value={current.availability} />
            <Factor label="Perf" value={current.performance} />
            <Factor label="Qualité" value={current.quality} />
          </div>
          <Waterfall r={current} />
        </div>
      </CardContent>
      {rows.length > 1 && (
        <div className="px-5">
          <div className="mb-1 text-xs text-muted-foreground">Tendance OEE</div>
          <Trend rows={rows} />
        </div>
      )}
    </Card>
  );
}

// ─── Vue ─────────────────────────────────────────────────────────────────

export function OeeView() {
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<OeeRow[]>([]);

  useEffect(() => {
    fetchOee(days).then(setRows).catch(() => setRows([]));
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

  return (
    <>
      <PageHeader
        title="OEE"
        description="Disponibilité × Performance × Qualité, par ligne et par shift. Repère world-class : 85 %."
        actions={
          <div className="range">
            {DAYS.map((d) => (
              <button
                key={d.v}
                className={days === d.v ? "active" : ""}
                onClick={() => setDays(d.v)}
              >
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
            <LineCard key={rs[0].line} rows={rs} />
          ))}
        </div>
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
                <TableHead>Produit</TableHead>
                <TableHead>OK</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={`${r.line}-${r.day}-${r.shift_no}-${i}`}>
                  <TableCell>{r.line_label ?? r.line}</TableCell>
                  <TableCell className="tabular-nums">{r.day.slice(0, 10)}</TableCell>
                  <TableCell>{r.shift_label ?? `#${r.shift_no}`}</TableCell>
                  <TableCell className="tabular-nums" style={{ color: toneVar(r.availability) }}>
                    {pct(r.availability)}
                  </TableCell>
                  <TableCell className="tabular-nums" style={{ color: toneVar(r.performance) }}>
                    {pct(r.performance)}
                  </TableCell>
                  <TableCell className="tabular-nums" style={{ color: toneVar(r.quality) }}>
                    {pct(r.quality)}
                  </TableCell>
                  <TableCell className="font-semibold tabular-nums" style={{ color: toneVar(r.oee) }}>
                    {pct(r.oee)}
                  </TableCell>
                  <TableCell className="tabular-nums">{r.produced ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{r.ok ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}
    </>
  );
}

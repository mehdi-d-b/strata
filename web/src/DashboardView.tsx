import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import type uPlot from "uplot";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Pencil,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  fetchDashboard,
  fetchHistory,
  fetchHistoryRange,
  fetchTags,
  tagLabel,
  updateDashboard,
  type DashboardPanel as PanelType,
  type DashboardRange,
  type DashboardSpec,
  type PanelSeries,
  type Tag,
} from "./api";
import { MultiChart, type SeriesDef } from "./MultiChart";
import { chartPalette } from "./chartTheme";
import { useTheme } from "./theme";
import { alignSeries } from "./series";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const PRESETS = [
  { label: "15 min", sec: 900 },
  { label: "1 h", sec: 3600 },
  { label: "6 h", sec: 21600 },
  { label: "24 h", sec: 86400 },
];

/** Charge les données d'un panneau (REST) et les aligne pour uPlot. */
async function loadPanelData(
  series: PanelSeries[],
  range: DashboardRange,
): Promise<uPlot.AlignedData> {
  const results = await Promise.all(
    series.map((s) => {
      const p =
        range.mode === "relative"
          ? fetchHistory(s.tag, Math.max(1, Math.ceil(range.sec / 60)))
          : fetchHistoryRange(
              s.tag,
              new Date(range.from).toISOString(),
              new Date(range.to).toISOString(),
            );
      return p
        .then((rows) => ({
          ts: rows.map((r) => new Date(r.ts).getTime() / 1000),
          val: rows.map((r) => Number(r.value)) as (number | null)[],
        }))
        .catch(() => ({ ts: [] as number[], val: [] as (number | null)[] }));
    }),
  );
  return alignSeries(results);
}

function newId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `p${Date.now()}${Math.random().toString(16).slice(2)}`;
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export function DashboardView() {
  const { id } = useParams<{ id: string }>();
  const [name, setName] = useState("");
  const [spec, setSpec] = useState<DashboardSpec | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [edit, setEdit] = useState(false);
  const [editingPanel, setEditingPanel] = useState<PanelType | null>(null);
  const [tick, setTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [showRange, setShowRange] = useState(false);

  useEffect(() => {
    if (!id) return;
    fetchDashboard(id)
      .then((d) => {
        setName(d.name);
        setSpec(d.spec);
      })
      .catch(() => toast.error("Dashboard introuvable (ou endpoint indisponible)."));
    fetchTags().then(setTags).catch(() => setTags([]));
  }, [id]);

  // Auto-refresh (suspendu en édition).
  const refreshSec = spec?.refreshSec ?? 0;
  useEffect(() => {
    if (edit || refreshSec <= 0) return;
    const iv = setInterval(() => setTick((t) => t + 1), refreshSec * 1000);
    return () => clearInterval(iv);
  }, [refreshSec, edit]);

  const tagInfo = useMemo(() => {
    const map = new Map(tags.map((t) => [t.name, t]));
    return (tag: string) => {
      const t = map.get(tag);
      return { label: t ? tagLabel(t) : tag, unit: t?.unit ?? null };
    };
  }, [tags]);

  if (!spec) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <p className="text-sm text-muted-foreground">Chargement…</p>
      </>
    );
  }

  const setRange = (range: DashboardRange) => setSpec({ ...spec, range });
  const patchPanels = (panels: PanelType[]) => setSpec({ ...spec, panels });

  const addPanel = () => {
    const panel: PanelType = { id: newId(), title: "Nouveau panneau", series: [] };
    patchPanels([...spec.panels, panel]);
    setEditingPanel(panel);
  };
  const removePanel = (pid: string) =>
    patchPanels(spec.panels.filter((p) => p.id !== pid));
  const movePanel = (pid: string, dir: -1 | 1) => {
    const i = spec.panels.findIndex((p) => p.id === pid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= spec.panels.length) return;
    const panels = [...spec.panels];
    [panels[i], panels[j]] = [panels[j], panels[i]];
    patchPanels(panels);
  };
  const savePanel = (p: PanelType) => {
    patchPanels(spec.panels.map((x) => (x.id === p.id ? p : x)));
    setEditingPanel(null);
  };

  const save = async () => {
    if (!id) return;
    setSaving(true);
    try {
      await updateDashboard(id, name, spec);
      toast.success("Dashboard enregistré.");
    } catch {
      toast.error("Enregistrement impossible.");
    } finally {
      setSaving(false);
    }
  };

  const isRel = spec.range.mode === "relative";

  return (
    <>
      <PageHeader
        title={
          edit ? (
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9 w-64 text-xl font-semibold"
            />
          ) : (
            name
          )
        }
        description={
          <Link to="/dashboards" className="inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="size-3" /> Dashboards
          </Link>
        }
        actions={
          <div className="flex items-center gap-2">
            {edit && (
              <Button size="sm" variant="outline" onClick={addPanel}>
                <Plus />
                Panneau
              </Button>
            )}
            <Button size="sm" variant={edit ? "default" : "outline"} onClick={() => setEdit((e) => !e)}>
              {edit ? "Terminer" : "Éditer"}
            </Button>
            <Button size="sm" onClick={save} disabled={saving}>
              <Save />
              {saving ? "…" : "Enregistrer"}
            </Button>
          </div>
        }
      />

      {/* Barre de temps + refresh */}
      <div className="toolbar">
        <div className="range">
          {PRESETS.map((p) => (
            <button
              key={p.sec}
              className={isRel && spec.range.mode === "relative" && spec.range.sec === p.sec ? "active" : ""}
              onClick={() => setRange({ mode: "relative", sec: p.sec })}
            >
              {p.label}
            </button>
          ))}
          <button className={!isRel ? "active" : ""} onClick={() => setShowRange((s) => !s)}>
            ◷ Plage…
          </button>
        </div>
        <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          Rafraîchir
          <select
            value={spec.refreshSec}
            onChange={(e) => setSpec({ ...spec, refreshSec: Number(e.target.value) })}
          >
            <option value={0}>Off</option>
            <option value={5}>5 s</option>
            <option value={10}>10 s</option>
            <option value={30}>30 s</option>
            <option value={60}>60 s</option>
          </select>
        </label>
      </div>

      {showRange && (
        <AbsoluteRange range={spec.range} onApply={(from, to) => setRange({ mode: "absolute", from, to })} />
      )}

      {/* Panneaux */}
      {spec.panels.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Aucun panneau. Passe en <strong>Éditer</strong> puis « Panneau » pour en
          ajouter un et choisir ses tags.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {spec.panels.map((p, i) => (
            <Panel
              key={p.id}
              panel={p}
              range={spec.range}
              tick={tick}
              tagInfo={tagInfo}
              edit={edit}
              canUp={i > 0}
              canDown={i < spec.panels.length - 1}
              onEdit={() => setEditingPanel(p)}
              onRemove={() => removePanel(p.id)}
              onUp={() => movePanel(p.id, -1)}
              onDown={() => movePanel(p.id, 1)}
            />
          ))}
        </div>
      )}

      {editingPanel && (
        <PanelEditDialog
          panel={editingPanel}
          tags={tags}
          onSave={savePanel}
          onClose={() => setEditingPanel(null)}
        />
      )}
    </>
  );
}

// ─── Panneau (données + graphe) ──────────────────────────────────────────

function Panel({
  panel,
  range,
  tick,
  tagInfo,
  edit,
  canUp,
  canDown,
  onEdit,
  onRemove,
  onUp,
  onDown,
}: {
  panel: PanelType;
  range: DashboardRange;
  tick: number;
  tagInfo: (tag: string) => { label: string; unit: string | null };
  edit: boolean;
  canUp: boolean;
  canDown: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onUp: () => void;
  onDown: () => void;
}) {
  const { theme } = useTheme();
  const palette = useMemo(() => chartPalette(), [theme]);
  const [data, setData] = useState<uPlot.AlignedData>([[]]);

  const seriesKey = panel.series.map((s) => `${s.tag}|${s.axis}`).join(",");
  useEffect(() => {
    let cancelled = false;
    if (panel.series.length === 0) {
      setData([[]]);
      return;
    }
    loadPanelData(panel.series, range).then((d) => {
      if (!cancelled) setData(d);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesKey, range, tick]);

  const series: SeriesDef[] = panel.series.map((s, i) => ({
    tag: s.tag,
    label: tagInfo(s.tag).label,
    color: palette[i % palette.length],
    axis: s.axis,
    unit: tagInfo(s.tag).unit,
  }));

  return (
    <Card className="gap-3 py-4">
      <div className="flex items-center justify-between px-5">
        <h3 className="truncate text-sm font-semibold">{panel.title}</h3>
        {edit && (
          <div className="flex items-center gap-1">
            <Button size="icon-sm" variant="ghost" disabled={!canUp} onClick={onUp} title="Monter">
              <ChevronUp />
            </Button>
            <Button size="icon-sm" variant="ghost" disabled={!canDown} onClick={onDown} title="Descendre">
              <ChevronDown />
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={onEdit} title="Éditer">
              <Pencil />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={onRemove}
              title="Supprimer"
            >
              <Trash2 />
            </Button>
          </div>
        )}
      </div>
      <CardContent className="px-5">
        {panel.series.length === 0 ? (
          <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
            Aucun tag — édite le panneau pour en ajouter.
          </div>
        ) : (
          <MultiChart data={data} series={series} height={260} />
        )}
      </CardContent>
    </Card>
  );
}

// ─── Plage absolue ───────────────────────────────────────────────────────

function AbsoluteRange({
  range,
  onApply,
}: {
  range: DashboardRange;
  onApply: (from: string, to: string) => void;
}) {
  const [from, setFrom] = useState(
    range.mode === "absolute" ? range.from : toLocalInput(new Date(Date.now() - 3600_000)),
  );
  const [to, setTo] = useState(
    range.mode === "absolute" ? range.to : toLocalInput(new Date()),
  );
  return (
    <div className="range-abs">
      <label>
        Du{" "}
        <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label>
        Au <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
      </label>
      <Button size="sm" onClick={() => onApply(from, to)}>
        Appliquer
      </Button>
    </div>
  );
}

// ─── Éditeur de panneau (modal) ──────────────────────────────────────────

function PanelEditDialog({
  panel,
  tags,
  onSave,
  onClose,
}: {
  panel: PanelType;
  tags: Tag[];
  onSave: (p: PanelType) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(panel.title);
  const [series, setSeries] = useState<PanelSeries[]>(panel.series);
  const [query, setQuery] = useState("");

  const enabled = tags.filter((t) => t.enabled);
  const filtered = enabled.filter((t) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return t.name.toLowerCase().includes(q) || (t.label ?? "").toLowerCase().includes(q);
  });

  const isSel = (tag: string) => series.some((s) => s.tag === tag);
  const toggle = (tag: string) =>
    setSeries((s) =>
      isSel(tag) ? s.filter((x) => x.tag !== tag) : [...s, { tag, axis: "left" }],
    );
  const setAxis = (tag: string, axis: "left" | "right") =>
    setSeries((s) => s.map((x) => (x.tag === tag ? { ...x, axis } : x)));

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[8vh]"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border p-4">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Titre du panneau"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <input
            className="mb-2 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            placeholder="Rechercher un tag…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="flex flex-col gap-0.5">
            {filtered.map((t) => {
              const sel = series.find((s) => s.tag === t.name);
              return (
                <div
                  key={t.name}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-secondary"
                >
                  <input type="checkbox" checked={!!sel} onChange={() => toggle(t.name)} />
                  <span className="flex-1 truncate">{tagLabel(t)}</span>
                  {sel && (
                    <button
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[11px]",
                        sel.axis === "right"
                          ? "border-chart-2/50 text-chart-2"
                          : "border-border text-muted-foreground",
                      )}
                      onClick={() => setAxis(t.name, sel.axis === "left" ? "right" : "left")}
                      title="Axe gauche/droite"
                    >
                      {sel.axis === "left" ? "◧ G" : "D ◨"}
                    </button>
                  )}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                Aucun tag.
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border p-4">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button size="sm" onClick={() => onSave({ ...panel, title, series })}>
            Valider
          </Button>
        </div>
      </div>
    </div>
  );
}

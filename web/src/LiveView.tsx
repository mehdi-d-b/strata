import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type uPlot from "uplot";
import { Calendar, Download, Pause, Play, RotateCcw } from "lucide-react";
import { MultiChart, type ChartApi, type SeriesDef } from "./MultiChart";
import { useRealtimeBuffers } from "./useRealtimeBuffers";
import { CommandBox } from "./CommandBox";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { useTheme } from "./theme";
import { chartPalette } from "./chartTheme";
import { loadPrefs } from "./prefs";
import {
  fetchHistory,
  fetchHistoryRange,
  fetchTags,
  tagLabel,
  type Tag,
} from "./api";

const WINDOWS = [
  { label: "5 min", sec: 300 },
  { label: "15 min", sec: 900 },
  { label: "60 min", sec: 3600 },
];

/** Plage affichée : relative (suit le direct) ou absolue (historique daté). */
type Range =
  | { mode: "relative"; sec: number }
  | { mode: "absolute"; from: string; to: string };

/** Série sélectionnée : on stocke l'INDEX de couleur (pas la couleur figée), pour
 *  que la teinte soit résolue dans la palette du thème courant au rendu. `axis`
 *  = côté/échelle (gauche/droite), avec un défaut intelligent par unité. */
type Selected = {
  tag: string;
  label: string;
  unit?: string | null;
  idx: number;
  axis: "left" | "right";
  hidden?: boolean;
};

/** Côté par défaut d'une nouvelle série : même unité qu'un côté existant -> ce
 *  côté ; sinon le côté encore libre ; sinon la gauche. (Forçable à la main.) */
function defaultSide(cur: Selected[], unit: string | null): "left" | "right" {
  const sideUnits = (side: "left" | "right") =>
    new Set(cur.filter((s) => s.axis === side).map((s) => s.unit ?? null));
  if (sideUnits("left").has(unit)) return "left";
  if (sideUnits("right").has(unit)) return "right";
  const hasLeft = cur.some((s) => s.axis === "left");
  const hasRight = cur.some((s) => s.axis === "right");
  if (hasLeft && !hasRight) return "right";
  return "left";
}

/** Date -> valeur d'un <input type="datetime-local"> (heure locale). */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** Nom relatif à un préfixe de chemin → { leaf (mesure), path (chemin restant) }. */
function relParts(name: string, prefixStr: string): { leaf: string; path: string } {
  let rel: string;
  if (!prefixStr) rel = name;
  else if (name === prefixStr) rel = name.split(".").pop() ?? name;
  else if (name.startsWith(prefixStr + ".")) rel = name.slice(prefixStr.length + 1);
  else rel = name;
  const i = rel.lastIndexOf(".");
  return { leaf: i >= 0 ? rel.slice(i + 1) : rel, path: i >= 0 ? rel.slice(0, i) : "" };
}

export function LiveView() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [query, setQuery] = useState("");
  const [prefix, setPrefix] = useState<string[]>([]);
  const [selected, setSelected] = useState<Selected[]>([]);
  const sessionRestored = useRef(false);
  const [range, setRange] = useState<Range>(() => ({
    mode: "relative",
    sec: loadPrefs().defaultWindowSec,
  }));
  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);

  const [data, setData] = useState<uPlot.AlignedData>([[]]);

  const isLive = range.mode === "relative";
  const liveSec = range.mode === "relative" ? range.sec : 300;

  // Picker de plage absolue.
  const [showRange, setShowRange] = useState(false);
  const [absFrom, setAbsFrom] = useState(() =>
    toLocalInput(new Date(Date.now() - 3600_000)),
  );
  const [absTo, setAbsTo] = useState(() => toLocalInput(new Date()));

  useEffect(() => {
    if (!sessionRestored.current) return;
    sessionStorage.setItem("explorer:selected", JSON.stringify(selected));
  }, [selected]);

  // Refs pour les guards dans la boucle de frames (sans recréer la socket).
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const isLiveRef = useRef(isLive);
  isLiveRef.current = isLive;

  // En direct : on pousse les frames (sauf pause). En historique : on les ignore
  // (les données viennent du chargement de plage absolue).
  const handleFrame = useCallback((d: uPlot.AlignedData) => {
    if (isLiveRef.current && !pausedRef.current) setData(d);
  }, []);

  // Le zoom au glisser met en pause (sinon la frame suivante annule le zoom).
  const onUserZoom = useCallback(() => {
    if (!isLiveRef.current) return; // en historique, rien à mettre en pause
    pausedRef.current = true;
    setPaused(true);
  }, []);

  // API impérative du graphe (reset zoom).
  const chartApiRef = useRef<ChartApi>(null);

  // Palette résolue dans le thème courant (se met à jour au toggle clair/sombre).
  const { theme } = useTheme();
  const palette = useMemo(() => chartPalette(), [theme]);
  const colorOf = (idx: number) => palette[idx % palette.length];

  // Séries au format MultiChart (couleur concrète résolue depuis l'index).
  const seriesForChart = useMemo<SeriesDef[]>(
    () =>
      selected.map((s) => ({
        tag: s.tag,
        label: s.label,
        color: colorOf(s.idx),
        unit: s.unit,
        axis: s.axis,
        hidden: s.hidden,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, palette],
  );

  // Dernière valeur connue par série (pour l'afficher dans les chips).
  const latest = useMemo<(number | null)[]>(
    () =>
      selected.map((_, i) => {
        const col = data[i + 1] as (number | null)[] | undefined;
        if (!col) return null;
        for (let j = col.length - 1; j >= 0; j--) if (col[j] != null) return col[j];
        return null;
      }),
    [data, selected],
  );

  // 1) Charger la liste des tags configurés.
  useEffect(() => {
    fetchTags().then(setTags).catch(() => setTags([]));
  }, []);

  const enabledTags = useMemo(() => tags.filter((t) => t.enabled), [tags]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return enabledTags;
    return enabledTags.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.label ?? "").toLowerCase().includes(q),
    );
  }, [enabledTags, query]);

  const selectedTags = useMemo(() => selected.map((s) => s.tag), [selected]);

  // Filtre dynamique par niveau de chemin : tags sous le préfixe courant +
  // « dossiers » = segments suivants distincts (dérivés des tags, donc dynamiques).
  const prefixStr = prefix.join(".");
  const visible = useMemo(
    () =>
      filtered.filter(
        (t) =>
          prefix.length === 0 || t.name === prefixStr || t.name.startsWith(prefixStr + "."),
      ),
    [filtered, prefix.length, prefixStr],
  );
  const folders = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of visible) {
      const parts = t.name.split(".");
      if (parts.length > prefix.length) m.set(parts[prefix.length], (m.get(parts[prefix.length]) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible, prefix.length]);

  // 2) Flux temps réel découplé (buffers + redraw cadencé). Toujours connecté ;
  //    les frames ne sont appliquées qu'en mode direct (cf. handleFrame).
  const { clear, seed } = useRealtimeBuffers({
    tags: selectedTags,
    windowSec: liveSec,
    fps: 30,
    onFrame: handleFrame,
    onLive: setLive,
  });

  const seedRef = useRef(seed);
  seedRef.current = seed;

  // Amorce/recharge le buffer d'un tag avec l'historique couvrant la fenêtre (direct).
  const loadHistory = (tag: string, sec: number) =>
    fetchHistory(tag, Math.ceil(sec / 60)).then((rows) => {
      seedRef.current(
        tag,
        rows.map((r) => new Date(r.ts).getTime() / 1000),
        rows.map((r) => Number(r.value)),
      );
    });

  // Charge une plage absolue pour toutes les séries et compose l'AlignedData.
  const loadAbsolute = useCallback(
    async (from: string, to: string, list: Selected[]) => {
      if (list.length === 0) {
        setData([[]]);
        return;
      }
      const fromIso = new Date(from).toISOString();
      const toIso = new Date(to).toISOString();
      const results = await Promise.all(
        list.map((s) =>
          fetchHistoryRange(s.tag, fromIso, toIso)
            .then((rows) => ({
              ts: rows.map((r) => new Date(r.ts).getTime() / 1000),
              val: rows.map((r) => Number(r.value)),
            }))
            .catch(() => ({ ts: [] as number[], val: [] as number[] })),
        ),
      );
      const tsSet = new Set<number>();
      for (const r of results) for (const t of r.ts) tsSet.add(t);
      const xs = Array.from(tsSet).sort((a, b) => a - b);
      const pos = new Map<number, number>();
      xs.forEach((t, i) => pos.set(t, i));
      const cols = results.map((r) => {
        const col: (number | null)[] = new Array(xs.length).fill(null);
        r.ts.forEach((t, i) => {
          const p = pos.get(t);
          if (p !== undefined) col[p] = r.val[i];
        });
        return col;
      });
      setData([xs, ...cols] as uPlot.AlignedData);
    },
    [],
  );

  // 3) (Dé)sélection d'un tag : amorce l'historique direct au moment de l'ajout.
  const toggleTag = (t: Tag) => {
    setSelected((cur) => {
      const exists = cur.find((s) => s.tag === t.name);
      if (exists) {
        clear(t.name);
        return cur.filter((s) => s.tag !== t.name);
      }
      const axis = defaultSide(cur, t.unit ?? null);
      if (isLiveRef.current) loadHistory(t.name, liveSec);
      return [
        ...cur,
        { tag: t.name, label: tagLabel(t), idx: cur.length, unit: t.unit, axis },
      ];
    });
  };

  // Restaure la sélection depuis sessionStorage une fois les tags disponibles.
  // Passe par toggleTag (même chemin que la sélection manuelle) pour garantir
  // que l'historique est bien amorcé dans les buffers.
  useEffect(() => {
    if (sessionRestored.current || enabledTags.length === 0) return;
    sessionRestored.current = true;
    try {
      const saved = sessionStorage.getItem("explorer:selected");
      if (!saved) return;
      const names = (JSON.parse(saved) as { tag: string }[]).map((s) => s.tag).filter(Boolean);
      for (const name of names) {
        const t = enabledTags.find((tag) => tag.name === name);
        if (t) toggleTag(t);
      }
    } catch { /* sessionStorage corrompu */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledTags]);

  // En direct : (re)amorce les buffers au changement de fenêtre OU à l'entrée
  // en mode direct (l'historique au-delà ayant pu être purgé du buffer).
  useEffect(() => {
    if (!isLive) return;
    for (const s of selected) loadHistory(s.tag, liveSec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSec, isLive]);

  // En historique : (re)charge la plage absolue quand elle change ou que la
  // sélection de tags change.
  useEffect(() => {
    if (range.mode !== "absolute") return;
    loadAbsolute(range.from, range.to, selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, selectedTags]);

  const setAxis = (tag: string, axis: "left" | "right") =>
    setSelected((cur) => cur.map((s) => (s.tag === tag ? { ...s, axis } : s)));

  const toggleHidden = (tag: string) =>
    setSelected((cur) =>
      cur.map((s) => (s.tag === tag ? { ...s, hidden: !s.hidden } : s)),
    );

  const removeAll = () => {
    clear();
    setSelected([]);
  };

  const applyAbsolute = () => {
    if (absFrom && absTo) setRange({ mode: "absolute", from: absFrom, to: absTo });
  };
  const backToLive = () => {
    setPaused(false);
    setRange({ mode: "relative", sec: loadPrefs().defaultWindowSec });
  };

  // Export CSV de la fenêtre courante : time ISO + une colonne par série.
  const exportCsv = () => {
    const xs = data[0] as number[] | undefined;
    if (!xs || xs.length === 0) return;
    const cols = seriesForChart.map((_, i) => data[i + 1] as (number | null)[] | undefined);
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const header = ["time", ...seriesForChart.map((s) => esc(s.label))].join(",");
    const lines = xs.map((t, r) => {
      const vals = cols.map((c) => {
        const v = c?.[r];
        return v == null ? "" : String(v);
      });
      return [new Date(t * 1000).toISOString(), ...vals].join(",");
    });
    const csv = [header, ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `strata-export-${new Date().toISOString().slice(0, 19)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const statusClass = !isLive ? "hist" : paused ? "off" : live ? "live" : "off";
  const statusText = !isLive
    ? "◷ historique"
    : paused
      ? "❚❚ en pause"
      : live
        ? "● en direct"
        : "○ déconnecté";

  return (
    <>
      <PageHeader
        title="Explorer"
        description="Visualisation des tags en temps réel ou sur une plage historique."
      />
      <div className="live-layout">
      {/* Panneau de gauche : recherche + liste de tags */}
      <aside className="tag-picker">
        <input
          className="tag-search"
          placeholder="Rechercher un tag…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {/* Fil d'Ariane : filtre par niveau de chemin */}
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <button
            className={prefix.length === 0 ? "text-foreground" : "hover:text-foreground"}
            onClick={() => setPrefix([])}
          >
            Tous
          </button>
          {prefix.map((seg, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="opacity-60">›</span>
              <button
                className={i === prefix.length - 1 ? "text-foreground" : "hover:text-foreground"}
                onClick={() => setPrefix(prefix.slice(0, i + 1))}
              >
                {seg}
              </button>
            </span>
          ))}
        </div>

        {/* Dossiers : segments suivants (clic = on descend d'un niveau) */}
        {folders.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {folders.map(([seg, count]) => (
              <button
                key={seg}
                onClick={() => setPrefix([...prefix, seg])}
                title={`Filtrer sur ${seg}`}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {seg}
                <span className="tabular-nums opacity-60">{count}</span>
              </button>
            ))}
          </div>
        )}

        <div className="tag-list">
          {visible.map((t) => {
            const on = selectedTags.includes(t.name);
            const { leaf, path } = relParts(t.name, prefixStr);
            // Un label n'est « utile » que s'il diffère du nom (l'auto-découverte
            // met souvent label = nom complet → sinon les 2 lignes seraient identiques).
            const label = t.label?.trim();
            const niceLabel = label && label !== t.name ? label : null;
            const primary = niceLabel ?? leaf;
            const secondary = niceLabel ? t.name : path;
            return (
              <label key={t.name} className={`tag-item ${on ? "on" : ""}`}>
                <input type="checkbox" checked={on} onChange={() => toggleTag(t)} />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate">{primary}</span>
                  {secondary && secondary !== primary && (
                    <span className="truncate text-[11px] text-muted-foreground">{secondary}</span>
                  )}
                </span>
                {t.unit && <span className="tag-item-unit">{t.unit}</span>}
              </label>
            );
          })}
          {visible.length === 0 && (
            <div className="hint" style={{ padding: 8 }}>
              Aucun tag ne correspond.
            </div>
          )}
        </div>
      </aside>

      {/* Zone principale : barre d'outils + chips + graphe */}
      <section className="live-main">
        <div className="toolbar">
          <div className="range">
            {WINDOWS.map((w) => (
              <button
                key={w.sec}
                className={isLive && range.sec === w.sec ? "active" : ""}
                onClick={() => setRange({ mode: "relative", sec: w.sec })}
              >
                {w.label}
              </button>
            ))}
            <button
              className={!isLive ? "active" : ""}
              onClick={() => setShowRange((s) => !s)}
              title="Plage de dates (historique)"
            >
              ◷ Plage…
            </button>
          </div>
          <span className={`status ${statusClass}`}>{statusText}</span>
          {selected.length > 0 && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              {isLive && (
                <Button variant="outline" size="sm" onClick={() => setPaused((p) => !p)}>
                  {paused ? <Play /> : <Pause />}
                  {paused ? "Reprendre" : "Pause"}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => chartApiRef.current?.resetZoom()}
                title="Réinitialiser le zoom"
              >
                <RotateCcw />
                Réinit. zoom
              </Button>
              <Button variant="outline" size="sm" onClick={exportCsv} title="Exporter en CSV">
                <Download />
                CSV
              </Button>
              <Button variant="ghost" size="sm" onClick={removeAll}>
                Tout retirer
              </Button>
            </div>
          )}
        </div>

        {/* Sélecteur de plage absolue (historique) */}
        {showRange && (
          <div className="range-abs">
            <Calendar className="size-4" style={{ color: "var(--muted-foreground)" }} />
            <label>
              Du{" "}
              <input
                type="datetime-local"
                value={absFrom}
                onChange={(e) => setAbsFrom(e.target.value)}
              />
            </label>
            <label>
              Au{" "}
              <input
                type="datetime-local"
                value={absTo}
                onChange={(e) => setAbsTo(e.target.value)}
              />
            </label>
            <Button size="sm" onClick={applyAbsolute}>
              Appliquer
            </Button>
            {!isLive && (
              <Button variant="ghost" size="sm" onClick={backToLive}>
                Revenir au direct
              </Button>
            )}
          </div>
        )}

        {/* Chips des séries : couleur, libellé, valeur, choix d'axe, retrait */}
        {selected.length > 0 && (
          <div className="series-chips">
            {selected.map((s, i) => (
              <span key={s.tag} className={`series-chip ${s.hidden ? "off" : ""}`}>
                <button
                  className="series-chip-main"
                  onClick={() => toggleHidden(s.tag)}
                  title={s.hidden ? "Afficher la série" : "Masquer la série"}
                >
                  <span className="dot" style={{ background: colorOf(s.idx) }} />
                  <span className="series-chip-label">{s.label}</span>
                </button>
                <span className="series-chip-val tabular-nums">
                  {latest[i] == null ? "—" : latest[i]!.toFixed(2)}
                  {s.unit ? ` ${s.unit}` : ""}
                </span>
                <button
                  className={`axis-toggle ${s.axis}`}
                  title="Basculer l'axe (gauche/droite)"
                  onClick={() => setAxis(s.tag, s.axis === "left" ? "right" : "left")}
                >
                  {s.axis === "left" ? "◧ G" : "D ◨"}
                </button>
                <button
                  className="x"
                  onClick={() => toggleTag({ name: s.tag } as Tag)}
                  title="Retirer"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="card">
          {selected.length === 0 ? (
            <div className="empty-chart">
              Sélectionne un ou plusieurs tags à gauche pour tracer leurs courbes.
            </div>
          ) : (data[0] as number[]).length === 0 ? (
            <div className="empty-chart">
              Pas de données sur cette fenêtre — le simulateur tourne-t-il ?
            </div>
          ) : (
            <MultiChart
              ref={chartApiRef}
              data={data}
              series={seriesForChart}
              onUserZoom={onUserZoom}
            />
          )}
        </div>

        {/* Écriture de consigne : seulement en direct, une seule série */}
        {isLive && selected.length === 1 && (
          <div className="card">
            <CommandBox tag={selected[0].tag} unit={selected[0].unit ?? undefined} />
          </div>
        )}
      </section>
      </div>
    </>
  );
}

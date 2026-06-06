import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type uPlot from "uplot";
import { Download, Pause, Play, RotateCcw } from "lucide-react";
import { MultiChart, type ChartApi, type SeriesDef } from "./MultiChart";
import { useRealtimeBuffers } from "./useRealtimeBuffers";
import { CommandBox } from "./CommandBox";
import { Button } from "@/components/ui/button";
import { useTheme } from "./theme";
import { chartPalette } from "./chartTheme";
import { fetchHistory, fetchTags, tagLabel, type Tag } from "./api";

const WINDOWS = [
  { label: "5 min", sec: 300 },
  { label: "15 min", sec: 900 },
  { label: "60 min", sec: 3600 },
];

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

export function LiveView() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Selected[]>([]);
  const [windowSec, setWindowSec] = useState(300);
  const [live, setLive] = useState(false);
  const [paused, setPaused] = useState(false);

  const [data, setData] = useState<uPlot.AlignedData>([[]]);

  // Pause du live : on gèle l'arrivée des frames (les buffers continuent de
  // tourner ; à la reprise, on saute à l'instant présent).
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const handleFrame = useCallback((d: uPlot.AlignedData) => {
    if (!pausedRef.current) setData(d);
  }, []);

  // Le zoom au glisser met en pause (sinon la frame suivante annule le zoom).
  // On force le ref tout de suite pour qu'aucune frame ne passe avant le re-render.
  const onUserZoom = useCallback(() => {
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

  // Dernière valeur connue par série (pour l'afficher en direct dans les chips).
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

  // 2) Flux temps réel découplé (buffers + redraw cadencé).
  const { clear, seed } = useRealtimeBuffers({
    tags: selectedTags,
    windowSec,
    fps: 30,
    onFrame: handleFrame,
    onLive: setLive,
  });

  // Pour des callbacks stables (sans recréer la socket).
  const seedRef = useRef(seed);
  seedRef.current = seed;

  // Amorce/recharge le buffer d'un tag avec l'historique couvrant la fenêtre.
  const loadHistory = (tag: string, sec: number) =>
    fetchHistory(tag, Math.ceil(sec / 60)).then((rows) => {
      seedRef.current(
        tag,
        rows.map((r) => new Date(r.ts).getTime() / 1000),
        rows.map((r) => Number(r.value)),
      );
    });

  // 3) (Dé)sélection d'un tag : amorce l'historique au moment où on l'ajoute.
  const toggleTag = (t: Tag) => {
    setSelected((cur) => {
      const exists = cur.find((s) => s.tag === t.name);
      if (exists) {
        clear(t.name);
        return cur.filter((s) => s.tag !== t.name);
      }
      const axis = defaultSide(cur, t.unit ?? null);
      loadHistory(t.name, windowSec);
      return [
        ...cur,
        { tag: t.name, label: tagLabel(t), idx: cur.length, unit: t.unit, axis },
      ];
    });
  };

  // 4) Au changement de fenêtre : recharge l'historique de toutes les séries
  //    affichées (sinon agrandir la fenêtre ne montre rien de plus, le brut
  //    au-delà ayant été purgé du buffer).
  useEffect(() => {
    for (const s of selected) loadHistory(s.tag, windowSec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowSec]);

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

  return (
    <div className="live-layout">
      {/* Panneau de gauche : recherche + liste de tags */}
      <aside className="tag-picker">
        <input
          className="tag-search"
          placeholder="Rechercher un tag…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="tag-list">
          {filtered.map((t) => {
            const on = selectedTags.includes(t.name);
            return (
              <label key={t.name} className={`tag-item ${on ? "on" : ""}`}>
                <input type="checkbox" checked={on} onChange={() => toggleTag(t)} />
                <span className="tag-item-label">{tagLabel(t)}</span>
                {t.unit && <span className="tag-item-unit">{t.unit}</span>}
              </label>
            );
          })}
          {filtered.length === 0 && (
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
                className={windowSec === w.sec ? "active" : ""}
                onClick={() => setWindowSec(w.sec)}
              >
                {w.label}
              </button>
            ))}
          </div>
          <span className={`status ${paused ? "off" : live ? "live" : "off"}`}>
            {paused ? "❚❚ en pause" : live ? "● en direct" : "○ déconnecté"}
          </span>
          {selected.length > 0 && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <Button variant="outline" size="sm" onClick={() => setPaused((p) => !p)}>
                {paused ? <Play /> : <Pause />}
                {paused ? "Reprendre" : "Pause"}
              </Button>
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

        {/* Chips des séries : couleur, libellé, choix d'axe, retrait */}
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
          ) : (
            <MultiChart
              ref={chartApiRef}
              data={data}
              series={seriesForChart}
              onUserZoom={onUserZoom}
            />
          )}
        </div>

        {/* Écriture de consigne : seulement si une seule série est sélectionnée */}
        {selected.length === 1 && (
          <div className="card">
            <CommandBox tag={selected[0].tag} unit={selected[0].unit ?? undefined} />
          </div>
        )}
      </section>
    </div>
  );
}

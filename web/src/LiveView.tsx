import { useEffect, useMemo, useRef, useState } from "react";
import type uPlot from "uplot";
import { MultiChart, type SeriesDef } from "./MultiChart";
import { useRealtimeBuffers } from "./useRealtimeBuffers";
import { CommandBox } from "./CommandBox";
import { fetchHistory, fetchTags, tagLabel, type Tag } from "./api";

const WINDOWS = [
  { label: "1 min", sec: 60 },
  { label: "5 min", sec: 300 },
  { label: "15 min", sec: 900 },
];

// Palette pour distinguer les courbes.
const PALETTE = [
  "#3fb950", "#58a6ff", "#f0883e", "#bc8cff", "#f85149",
  "#39c5cf", "#e3b341", "#ff7b72", "#7ee787", "#d2a8ff",
];

type Selected = SeriesDef & { color: string };

export function LiveView() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Selected[]>([]);
  const [windowSec, setWindowSec] = useState(300);
  const [live, setLive] = useState(false);

  const [data, setData] = useState<uPlot.AlignedData>([[]]);

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
    onFrame: setData,
    onLive: setLive,
  });

  // Pour seed() stable dans les callbacks.
  const seedRef = useRef(seed);
  seedRef.current = seed;

  // 3) (Dé)sélection d'un tag : amorce l'historique au moment où on l'ajoute.
  const toggleTag = (t: Tag) => {
    setSelected((cur) => {
      const exists = cur.find((s) => s.tag === t.name);
      if (exists) {
        clear(t.name);
        return cur.filter((s) => s.tag !== t.name);
      }
      const color = PALETTE[cur.length % PALETTE.length];
      // Amorce avec l'historique récent (en secondes).
      fetchHistory(t.name, Math.ceil(windowSec / 60) || 5).then((rows) => {
        seedRef.current(
          t.name,
          rows.map((r) => new Date(r.ts).getTime() / 1000),
          rows.map((r) => Number(r.value)),
        );
      });
      return [
        ...cur,
        { tag: t.name, label: tagLabel(t), color, axis: "left", unit: t.unit },
      ];
    });
  };

  const setAxis = (tag: string, axis: "left" | "right") =>
    setSelected((cur) => cur.map((s) => (s.tag === tag ? { ...s, axis } : s)));

  const removeAll = () => {
    clear();
    setSelected([]);
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
          <span className={`status ${live ? "live" : "off"}`}>
            {live ? "● live" : "○ déconnecté"}
          </span>
          {selected.length > 0 && (
            <button className="ghost" onClick={removeAll}>
              Tout retirer
            </button>
          )}
        </div>

        {/* Chips des séries : couleur, libellé, choix d'axe, retrait */}
        {selected.length > 0 && (
          <div className="series-chips">
            {selected.map((s) => (
              <span key={s.tag} className="series-chip">
                <span className="dot" style={{ background: s.color }} />
                <span className="series-chip-label">{s.label}</span>
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
            <MultiChart data={data} series={selected} />
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

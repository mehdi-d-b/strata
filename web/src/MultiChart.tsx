import { useEffect, useRef } from "react";
import uPlot from "uplot";
import { useTheme } from "./theme";
import { chartAxisTheme } from "./chartTheme";

export type SeriesDef = {
  tag: string;
  label: string;
  color: string;
  unit?: string | null;
};

type Props = {
  /** Données alignées uPlot : [timestamps(s), ys_série1, ys_série2, …]. */
  data: uPlot.AlignedData;
  series: SeriesDef[];
  height?: number;
};

/** Signature qui déclenche la RECRÉATION du plot (structure des séries changée). */
function structureKey(series: SeriesDef[]): string {
  return series.map((s) => `${s.tag}|${s.color}|${s.unit ?? ""}`).join(",");
}

/**
 * uPlot exige EXACTEMENT series.length+1 colonnes, sinon il plante (accScale lit
 * `undefined.length`). On normalise : x + une colonne par série, en complétant
 * par des colonnes vides si `data` est en retard d'une frame.
 */
function shape(data: uPlot.AlignedData, count: number): uPlot.AlignedData {
  const xs = (data[0] as number[] | undefined) ?? [];
  const cols: (number | null)[][] = [];
  for (let i = 0; i < count; i++) {
    const col = data[i + 1] as (number | null)[] | undefined;
    cols.push(col && col.length === xs.length ? col : new Array(xs.length).fill(null));
  }
  return [xs, ...cols] as uPlot.AlignedData;
}

/** Unités distinctes dans l'ordre d'apparition (null = sans unité). */
function distinctUnits(series: SeriesDef[]): (string | null)[] {
  const units: (string | null)[] = [];
  for (const s of series) {
    const u = s.unit ?? null;
    if (!units.some((x) => x === u)) units.push(u);
  }
  return units;
}

/** Dernière valeur non nulle au plus tard à l'index `idx` (report LOCF). */
function locf(col: readonly (number | null | undefined)[], idx: number): number | null {
  for (let i = idx; i >= 0; i--) {
    const v = col[i];
    if (v != null) return v;
  }
  return null;
}

function fmtTime(tsec: number): string {
  return new Date(tsec * 1000).toLocaleTimeString();
}

/**
 * Tooltip multi-séries : au curseur, affiche pour CHAQUE série sa dernière valeur
 * connue (LOCF). Remplace la légende live de uPlot (qui clignote/recircule).
 * Layout fixe + tabular-nums => pas de saut quand les valeurs changent.
 */
function tooltipPlugin(series: SeriesDef[]): uPlot.Plugin {
  let tip: HTMLDivElement;
  return {
    hooks: {
      init: (u) => {
        tip = document.createElement("div");
        tip.className = "u-tooltip";
        tip.style.display = "none";
        u.over.appendChild(tip);
      },
      setCursor: (u) => {
        const idx = u.cursor.idx;
        const left = u.cursor.left ?? -1;
        const top = u.cursor.top ?? -1;
        if (idx == null || left < 0) {
          tip.style.display = "none";
          return;
        }
        const xs = u.data[0] as number[];
        let html = `<div class="u-tt-time">${fmtTime(xs[idx])}</div>`;
        series.forEach((s, i) => {
          const v = locf(u.data[i + 1] as (number | null)[], idx);
          const val = v == null ? "—" : v.toFixed(2);
          const unit = s.unit ? ` ${s.unit}` : "";
          html +=
            `<div class="u-tt-row">` +
            `<span class="u-tt-dot" style="background:${s.color}"></span>` +
            `<span class="u-tt-lbl">${s.label}</span>` +
            `<span class="u-tt-val">${val}${unit}</span>` +
            `</div>`;
        });
        tip.innerHTML = html;
        tip.style.display = "block";
        // Bascule à gauche du curseur quand on approche du bord droit.
        tip.classList.toggle("flip", left > u.over.clientWidth / 2);
        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
      },
    },
  };
}

/** Graphe uPlot multi-séries : une échelle/axe par unité, tooltip multi-séries. */
export function MultiChart({ data, series, height = 420 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const lastKey = useRef<string>("__none__");
  const { theme } = useTheme();

  useEffect(() => {
    if (!ref.current) return;
    // La clé inclut "y a-t-il des données ?" : un plot créé VIDE ne réveille pas
    // l'auto-range au premier setData. + `theme` => recréation au toggle (couleurs
    // canvas figées à la création).
    const hasData = ((data[0] as number[] | undefined)?.length ?? 0) > 0;
    const key = structureKey(series) + theme + (hasData ? "#data" : "#empty");
    if (plot.current && key === lastKey.current) return; // structure inchangée
    lastKey.current = key;
    plot.current?.destroy();

    const units = distinctUnits(series);
    // Une échelle par unité ; clé stable indexée sur la liste des unités.
    const scaleOf = (u: string | null) => `y${units.findIndex((x) => x === u)}`;

    const uSeries: uPlot.Series[] = [
      {},
      ...series.map((s) => ({
        label: s.label,
        stroke: s.color,
        width: 2,
        scale: scaleOf(s.unit ?? null),
        spanGaps: true, // relie par-dessus les null (séries non synchrones)
        points: { show: false },
      })),
    ];

    const scales: uPlot.Scales = { x: { time: true } };
    for (const u of units) scales[scaleOf(u)] = { auto: true };

    // Couleurs lues dans le thème courant (la classe .dark est déjà à jour ici).
    const ax = chartAxisTheme();
    // x + un axe par unité : 1ʳᵉ unité à gauche, les suivantes à droite (empilées).
    const axes: uPlot.Axis[] = [{ stroke: ax.stroke, grid: { stroke: ax.grid } }];
    units.forEach((u, i) => {
      axes.push({
        scale: scaleOf(u),
        side: i === 0 ? 3 : 1,
        label: u ?? "",
        stroke: ax.stroke,
        grid: i === 0 ? { stroke: ax.grid } : { show: false },
      });
    });

    const opts: uPlot.Options = {
      width: ref.current.clientWidth,
      height,
      scales,
      legend: { show: false }, // remplacée par le tooltip multi-séries
      cursor: { focus: { prox: 16 } },
      series: uSeries,
      axes,
      plugins: [tooltipPlugin(series)],
    };

    plot.current = new uPlot(opts, shape(data, series.length), ref.current);

    const onResize = () =>
      plot.current?.setSize({ width: ref.current!.clientWidth, height });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, height, data, theme]);

  // Mise à jour des données sans recréer le plot (toujours bien dimensionnée).
  useEffect(() => {
    plot.current?.setData(shape(data, series.length));
  }, [data, series]);

  useEffect(() => () => plot.current?.destroy(), []);

  return <div ref={ref} className="multichart" />;
}

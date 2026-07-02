import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import uPlot from "uplot";
import { useTheme } from "./theme";
import { chartAxisTheme } from "./chartTheme";

export type SeriesDef = {
  tag: string;
  label: string;
  color: string;
  unit?: string | null;
  /** Côté/échelle d'affichage (deux échelles indépendantes, auto-range séparé). */
  axis: "left" | "right";
  /** Série masquée (gardée en mémoire mais non tracée). */
  hidden?: boolean;
};

/** Fenêtre où une alarme était active — indicateur en contexte (Phase C). */
export type AlarmBand = {
  /** Timestamps EN SECONDES (même unité que l'axe X uPlot). */
  from: number;
  to: number;
  severity: "critical" | "warning" | "info";
};

/** API impérative exposée par le graphe (contrôles externes). */
export type ChartApi = {
  /** Réinitialise le zoom : ré-auto-range sur l'étendue des données. */
  resetZoom: () => void;
};

type Props = {
  /** Données alignées uPlot : [timestamps(s), ys_série1, ys_série2, …]. */
  data: uPlot.AlignedData;
  series: SeriesDef[];
  height?: number;
  /** Appelé quand l'utilisateur zoome au glisser (pour auto-mettre en pause). */
  onUserZoom?: () => void;
  /** Bandes verticales teintées derrière le graphe, une par fenêtre d'alarme. */
  alarmBands?: AlarmBand[];
};

/** Signature qui déclenche la RECRÉATION du plot (structure des séries changée). */
function structureKey(series: SeriesDef[]): string {
  return series.map((s) => `${s.tag}|${s.color}|${s.axis}|${s.unit ?? ""}`).join(",");
}

const ALARM_BAND_COLOR: Record<AlarmBand["severity"], string> = {
  critical: "rgba(220,38,38,0.14)",
  warning: "rgba(217,119,6,0.14)",
  info: "rgba(37,99,235,0.12)",
};

/** Peint les fenêtres d'alarme en fond, AVANT séries/grille (hook drawClear = sous tout). */
function alarmBandsPlugin(bands: AlarmBand[]): uPlot.Plugin {
  return {
    hooks: {
      drawClear: (u) => {
        if (bands.length === 0) return;
        const ctx = u.ctx;
        ctx.save();
        for (const b of bands) {
          const x0 = u.valToPos(b.from, "x", true);
          const x1 = u.valToPos(b.to, "x", true);
          ctx.fillStyle = ALARM_BAND_COLOR[b.severity];
          ctx.fillRect(x0, u.bbox.top, Math.max(1, x1 - x0), u.bbox.height);
        }
        ctx.restore();
      },
    },
  };
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

/** Unité commune d'un côté si elle est uniforme et non nulle, sinon "" (pas de label). */
function sideUnit(series: SeriesDef[], side: "left" | "right"): string {
  const us = new Set(series.filter((s) => s.axis === side).map((s) => s.unit ?? null));
  if (us.size !== 1) return "";
  const u = [...us][0];
  return u ?? "";
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

/** Graphe uPlot multi-séries : deux échelles indépendantes, tooltip multi-séries. */
export const MultiChart = forwardRef<ChartApi, Props>(function MultiChart(
  { data, series, height = 420, onUserZoom, alarmBands = [] },
  apiRef,
) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const lastKey = useRef<string>("__none__");
  const { theme } = useTheme();
  // Toujours appeler la dernière version du callback depuis le hook uPlot.
  const onZoomRef = useRef(onUserZoom);
  onZoomRef.current = onUserZoom;

  // API impérative : reset zoom = setData avec ré-init des échelles (auto-range).
  useImperativeHandle(
    apiRef,
    () => ({
      resetZoom: () => {
        const u = plot.current;
        if (u) u.setData(u.data as uPlot.AlignedData, true);
      },
    }),
    [],
  );

  useEffect(() => {
    if (!ref.current) return;
    // La clé inclut "y a-t-il des données ?" : un plot créé VIDE ne réveille pas
    // l'auto-range au premier setData. + `theme` => recréation au toggle (couleurs
    // canvas figées à la création).
    const hasData = ((data[0] as number[] | undefined)?.length ?? 0) > 0;
    const key =
      structureKey(series) + theme + (hasData ? "#data" : "#empty") + JSON.stringify(alarmBands);
    if (plot.current && key === lastKey.current) return; // structure inchangée
    lastKey.current = key;
    plot.current?.destroy();

    const hasRight = series.some((s) => s.axis === "right");

    const uSeries: uPlot.Series[] = [
      {},
      ...series.map((s) => ({
        label: s.label,
        stroke: s.color,
        width: 2,
        scale: s.axis, // "left" | "right" = deux échelles indépendantes
        spanGaps: true, // relie par-dessus les null (séries non synchrones)
        points: { show: false },
        show: !s.hidden,
      })),
    ];

    // Deux échelles indépendantes (auto-range séparé) : on superpose ainsi des
    // courbes d'amplitudes très différentes en les plaçant chacune d'un côté.
    // On ne déclare `right` que si utilisée (une scale vide bloque le rendu).
    const scales: uPlot.Scales = { x: { time: true }, left: { auto: true } };
    if (hasRight) scales.right = { auto: true };

    // Couleurs lues dans le thème courant (la classe .dark est déjà à jour ici).
    const ax = chartAxisTheme();
    const axes: uPlot.Axis[] = [
      { stroke: ax.stroke, grid: { stroke: ax.grid } },
      {
        scale: "left",
        side: 3,
        label: sideUnit(series, "left"),
        stroke: ax.stroke,
        grid: { stroke: ax.grid },
      },
    ];
    if (hasRight) {
      axes.push({
        scale: "right",
        side: 1,
        label: sideUnit(series, "right"),
        stroke: ax.stroke,
        grid: { show: false },
      });
    }

    const opts: uPlot.Options = {
      width: ref.current.clientWidth,
      height,
      scales,
      legend: { show: false }, // remplacée par le tooltip multi-séries
      // Glisser = zoom boîte (X et Y). Double-clic = reset (natif uPlot).
      cursor: { drag: { x: true, y: true }, focus: { prox: 16 } },
      series: uSeries,
      axes,
      plugins: [
        tooltipPlugin(series),
        alarmBandsPlugin(alarmBands),
        // Détecte le zoom au glisser pour prévenir le parent (auto-pause).
        {
          hooks: {
            setSelect: (u) => {
              if (u.select.width > 0) onZoomRef.current?.();
            },
          },
        },
      ],
    };

    plot.current = new uPlot(opts, shape(data, series.length), ref.current);

    const onResize = () =>
      plot.current?.setSize({ width: ref.current!.clientWidth, height });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, height, data, theme, alarmBands]);

  // Mise à jour des données sans recréer le plot (toujours bien dimensionnée).
  useEffect(() => {
    plot.current?.setData(shape(data, series.length));
  }, [data, series]);

  // Masquer/afficher une série sans recréer le plot (préserve zoom & co).
  useEffect(() => {
    const u = plot.current;
    if (!u) return;
    series.forEach((s, i) => u.setSeries(i + 1, { show: !s.hidden }));
  }, [series]);

  useEffect(
    () => () => {
      // Sous StrictMode (dev), React monte/démonte/remonte une fois pour détecter les
      // effets non idempotents : ce cleanup s'exécute donc AUSSI à ce faux démontage.
      // Sans remettre plot.current à null, la garde "structure inchangée" de l'effet
      // de création (key === lastKey.current) voit une référence non-nulle (mais
      // détruite) et saute la recréation -> graphe vide en permanence après le
      // double-montage. Recréé ici pour de vrai.
      plot.current?.destroy();
      plot.current = null;
    },
    [],
  );

  return <div ref={ref} className="multichart" />;
});

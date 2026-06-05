import { useEffect, useRef } from "react";
import uPlot from "uplot";

export type SeriesDef = {
  tag: string;
  label: string;
  color: string;
  axis: "left" | "right";
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
  return series.map((s) => `${s.tag}|${s.color}|${s.axis}`).join(",");
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

/** Graphe uPlot multi-séries avec double axe (gauche/droite). */
export function MultiChart({ data, series, height = 420 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const lastKey = useRef<string>("__none__");

  useEffect(() => {
    if (!ref.current) return;
    // La clé inclut "y a-t-il des données ?" : un plot créé VIDE ne réveille pas
    // l'auto-range au premier setData (symptôme : 1 série n'apparaît qu'après un
    // changement d'axe, qui recrée le plot). On force donc une recréation au
    // passage vide -> non-vide.
    const hasData = ((data[0] as number[] | undefined)?.length ?? 0) > 0;
    const key = structureKey(series) + (hasData ? "#data" : "#empty");
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
        scale: s.axis,
        spanGaps: true, // relie par-dessus les null (séries non synchrones)
        points: { show: false },
        value: (_u: uPlot, v: number | null) =>
          v == null ? "—" : v.toFixed(2) + (s.unit ? " " + s.unit : ""),
      })),
    ];

    const axes: uPlot.Axis[] = [
      { stroke: "#8b97a7", grid: { stroke: "#1d242e" } },
      { scale: "left", stroke: "#8b97a7", grid: { stroke: "#1d242e" } },
    ];
    if (hasRight) {
      axes.push({
        scale: "right",
        side: 1,
        stroke: "#8b97a7",
        grid: { show: false },
      });
    }

    // Ne déclarer que les scales réellement utilisées : une scale `right`
    // déclarée sans série dessus empêche uPlot de bien initialiser le rendu
    // (symptôme : rien ne s'affiche tant qu'on n'a pas 2 séries dont une à droite).
    const scales: uPlot.Scales = { x: { time: true }, left: { auto: true } };
    if (hasRight) scales.right = { auto: true };

    const opts: uPlot.Options = {
      width: ref.current.clientWidth,
      height,
      scales,
      legend: { show: true, live: true },
      cursor: { focus: { prox: 16 } },
      series: uSeries,
      axes,
    };

    plot.current = new uPlot(opts, shape(data, series.length), ref.current);

    const onResize = () =>
      plot.current?.setSize({ width: ref.current!.clientWidth, height });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, height, data]);

  // Mise à jour des données sans recréer le plot (toujours bien dimensionnée).
  useEffect(() => {
    plot.current?.setData(shape(data, series.length));
  }, [data, series]);

  useEffect(() => () => plot.current?.destroy(), []);

  return <div ref={ref} className="multichart" />;
}

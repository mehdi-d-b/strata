import { useEffect, useRef } from "react";
import uPlot from "uplot";
import { useTheme } from "./theme";
import { chartAxisTheme, chartPalette } from "./chartTheme";

type Props = {
  /** [timestamps(s), valeurs] au format uPlot. */
  data: [number[], number[]];
  label: string;
};

/** Courbe temps réel uPlot, redimensionnée à la largeur du conteneur. */
export function RealtimeChart({ data, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const { theme } = useTheme();

  // (Re)création du plot quand le label OU le thème change (couleurs canvas figées).
  useEffect(() => {
    if (!ref.current) return;
    plot.current?.destroy();

    const ax = chartAxisTheme();
    const opts: uPlot.Options = {
      width: ref.current.clientWidth,
      height: 360,
      title: label || "—",
      scales: { x: { time: true } },
      series: [
        {},
        {
          label,
          stroke: chartPalette()[0],
          width: 2,
          points: { show: false },
        },
      ],
      axes: [
        { stroke: ax.stroke, grid: { stroke: ax.grid } },
        { stroke: ax.stroke, grid: { stroke: ax.grid } },
      ],
    };

    plot.current = new uPlot(opts, data, ref.current);

    const onResize = () =>
      plot.current?.setSize({ width: ref.current!.clientWidth, height: 360 });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      plot.current?.destroy();
      plot.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, theme]);

  // Mise à jour des données sans recréer le plot.
  useEffect(() => {
    plot.current?.setData(data);
  }, [data]);

  return <div ref={ref} />;
}

import type uPlot from "uplot";

/** Compose un AlignedData uPlot à partir de séries non synchrones (union triée
 *  des timestamps, null là où une série n'a pas de point à cet instant). */
export function alignSeries(
  list: { ts: number[]; val: (number | null)[] }[],
): uPlot.AlignedData {
  const tsSet = new Set<number>();
  for (const r of list) for (const t of r.ts) tsSet.add(t);
  const xs = Array.from(tsSet).sort((a, b) => a - b);
  const pos = new Map<number, number>();
  xs.forEach((t, i) => pos.set(t, i));
  const cols = list.map((r) => {
    const col: (number | null)[] = new Array(xs.length).fill(null);
    r.ts.forEach((t, i) => {
      const p = pos.get(t);
      if (p !== undefined) col[p] = r.val[i];
    });
    return col;
  });
  return [xs, ...cols] as uPlot.AlignedData;
}

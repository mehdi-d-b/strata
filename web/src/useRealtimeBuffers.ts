import { useEffect, useRef } from "react";
import type uPlot from "uplot";
import type { Mesure } from "./api";

/**
 * Flux temps réel haute fréquence, DÉCOUPLÉ du rendu.
 *
 * - Le WebSocket pousse les points dans des buffers par tag, sans re-render.
 * - Une boucle requestAnimationFrame, cadencée (~fps), recompose l'AlignedData
 *   uPlot (union triée des timestamps, null là où une série n'a pas de point —
 *   donc AUCUNE perte de résolution, contrairement à un bucket) et la livre via
 *   `onFrame`. Le débit d'arrivée n'impose donc pas le débit de rendu.
 * - Fenêtre glissante `windowSec` : borne chaque buffer -> mémoire plafonnée
 *   quelle que soit la fréquence (10 Hz comme 0,1 Hz).
 */

type Buffer = { ts: number[]; val: number[] };

export type RealtimeOptions = {
  /** Tags à suivre (dans l'ordre des séries). */
  tags: string[];
  /** Fenêtre affichée, en secondes. */
  windowSec: number;
  /** Cadence de rendu max (images/s). */
  fps?: number;
  /** Appelé à chaque frame avec les données alignées prêtes pour uPlot. */
  onFrame: (data: uPlot.AlignedData) => void;
  /** Appelé quand l'état de connexion WS change. */
  onLive?: (live: boolean) => void;
};

export function useRealtimeBuffers(opts: RealtimeOptions) {
  // Refs pour que le handler WS et la boucle rAF voient toujours l'état courant
  // sans recréer la socket à chaque changement de tags/fenêtre.
  const tagsRef = useRef<string[]>(opts.tags);
  tagsRef.current = opts.tags;
  const windowRef = useRef(opts.windowSec);
  windowRef.current = opts.windowSec;
  const onFrameRef = useRef(opts.onFrame);
  onFrameRef.current = opts.onFrame;

  const buffers = useRef<Map<string, Buffer>>(new Map());
  const fps = opts.fps ?? 30;

  // --- WebSocket : remplit les buffers, ne rend rien ----------------------
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // Same-origin (`location.host`) : le cookie de session part avec le handshake
    // -> la gateway authentifie + filtre par droits. En dev, le proxy Vite route
    // /ws vers la gateway. Override possible via VITE_WS_URL.
    const url =
      import.meta.env.VITE_WS_URL ?? `${proto}://${location.host}/ws`;
    const ws = new WebSocket(url);
    ws.onopen = () => opts.onLive?.(true);
    ws.onclose = () => opts.onLive?.(false);
    ws.onmessage = (ev) => {
      let m: Mesure;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!tagsRef.current.includes(m.tag)) return;
      let buf = buffers.current.get(m.tag);
      if (!buf) {
        buf = { ts: [], val: [] };
        buffers.current.set(m.tag, buf);
      }
      buf.ts.push(new Date(m.ts).getTime() / 1000);
      buf.val.push(m.value);
    };
    return () => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
      else ws.onopen = () => ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Boucle de rendu cadencée (rAF + throttle fps) ----------------------
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const minDelta = 1000 / fps;

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < minDelta) return;
      last = now;

      const cutoff = Date.now() / 1000 - windowRef.current;
      const tags = tagsRef.current;

      // Purge hors fenêtre + collecte l'union triée des timestamps.
      const tsSet = new Set<number>();
      for (const tag of tags) {
        const buf = buffers.current.get(tag);
        if (!buf) continue;
        let drop = 0;
        while (drop < buf.ts.length && buf.ts[drop] < cutoff) drop++;
        if (drop > 0) {
          buf.ts.splice(0, drop);
          buf.val.splice(0, drop);
        }
        for (const t of buf.ts) tsSet.add(t);
      }
      const xs = Array.from(tsSet).sort((a, b) => a - b);

      // Index timestamp -> position, pour aligner chaque série en O(n).
      const pos = new Map<number, number>();
      xs.forEach((t, i) => pos.set(t, i));

      const cols: (number | null)[][] = tags.map((tag) => {
        const col: (number | null)[] = new Array(xs.length).fill(null);
        const buf = buffers.current.get(tag);
        if (buf) {
          for (let i = 0; i < buf.ts.length; i++) {
            const p = pos.get(buf.ts[i]);
            if (p !== undefined) col[p] = buf.val[i];
          }
        }
        return col;
      });

      onFrameRef.current([xs, ...cols] as uPlot.AlignedData);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [fps]);

  /** Vide les buffers d'un tag (ou tous). */
  const clear = (tag?: string) => {
    if (tag) buffers.current.delete(tag);
    else buffers.current.clear();
  };

  /** Amorce un buffer avec un historique (ts en s, valeurs). */
  const seed = (tag: string, ts: number[], val: number[]) => {
    buffers.current.set(tag, { ts: [...ts], val: [...val] });
  };

  return { clear, seed };
}

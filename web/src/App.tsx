import { useEffect, useMemo, useRef, useState } from "react";
import { RealtimeChart } from "./RealtimeChart";

/** Une mesure telle que poussée par la gateway (contrat `tags.raw`). */
export type Mesure = {
  tag: string;
  value: number;
  ts: string;
  quality?: string;
  source?: string;
};

const MAX_POINTS = 600; // ~10 min à 1 pt/s

export function App() {
  const [tags, setTags] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [live, setLive] = useState(false);

  // Buffers de la série affichée : timestamps (s) + valeurs, format uPlot.
  const [data, setData] = useState<[number[], number[]]>([[], []]);
  const xs = useRef<number[]>([]);
  const ys = useRef<number[]>([]);

  // 1) Charger la liste des tags.
  useEffect(() => {
    fetch("/api/tags")
      .then((r) => r.json())
      .then((t: string[]) => {
        setTags(t);
        if (t.length && !selected) setSelected(t[0]);
      })
      .catch(() => setTags([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2) Au changement de tag : charger l'historique récent comme base.
  useEffect(() => {
    if (!selected) return;
    fetch(`/api/history?tag=${encodeURIComponent(selected)}&minutes=10`)
      .then((r) => r.json())
      .then((rows: { ts: string; value: number }[]) => {
        xs.current = rows.map((r) => new Date(r.ts).getTime() / 1000);
        ys.current = rows.map((r) => Number(r.value));
        setData([[...xs.current], [...ys.current]]);
      });
  }, [selected]);

  // 3) WebSocket temps réel : on n'ajoute que les points du tag sélectionné.
  //    On se connecte DIRECTEMENT à la gateway (le proxy WS de Vite est peu
  //    fiable en dev). En prod, surcharger via VITE_WS_URL.
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const wsUrl =
      import.meta.env.VITE_WS_URL ?? `${proto}://${location.hostname}:3001/ws`;
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => setLive(true);
    ws.onclose = () => setLive(false);
    ws.onmessage = (ev) => {
      const m: Mesure = JSON.parse(ev.data);
      if (m.tag !== selectedRef.current) return;
      xs.current.push(new Date(m.ts).getTime() / 1000);
      ys.current.push(m.value);
      if (xs.current.length > MAX_POINTS) {
        xs.current.shift();
        ys.current.shift();
      }
      setData([[...xs.current], [...ys.current]]);
    };
    return () => {
      // Ne fermer que si le handshake est terminé : fermer un socket encore
      // en CONNECTING (cleanup StrictMode) déclenche le warning console bénin.
      if (ws.readyState === WebSocket.OPEN) ws.close();
      else ws.onopen = () => ws.close();
    };
  }, []);

  // selected accessible dans le handler WS sans recréer la socket.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const last = useMemo(
    () => (data[1].length ? data[1][data[1].length - 1] : null),
    [data],
  );

  return (
    <>
      <header>
        <h1>STRATA</h1>
        <div className="sub">Industrial data streaming — temps réel</div>
      </header>
      <main>
        <div className="toolbar">
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <span className={`status ${live ? "live" : "off"}`}>
            {live ? "● live" : "○ déconnecté"}
          </span>
          {last !== null && (
            <span style={{ color: "#8b97a7", fontSize: 14 }}>
              dernière valeur : <strong style={{ color: "#e6edf3" }}>{last}</strong>
            </span>
          )}
        </div>

        <div className="card">
          <RealtimeChart data={data} label={selected} />
        </div>
      </main>
    </>
  );
}

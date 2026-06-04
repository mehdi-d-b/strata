import { useEffect, useMemo, useRef, useState } from "react";
import { RealtimeChart } from "./RealtimeChart";
import { fetchHistory, fetchTags, tagLabel, type Mesure, type Tag } from "./api";

const MAX_POINTS = 600; // ~10 min à 1 pt/s
const RANGES = [5, 15, 60]; // minutes

export function LiveView() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [minutes, setMinutes] = useState(10);
  const [live, setLive] = useState(false);

  const [data, setData] = useState<[number[], number[]]>([[], []]);
  const xs = useRef<number[]>([]);
  const ys = useRef<number[]>([]);

  // Seuls les tags activés sont proposés.
  const enabledTags = useMemo(() => tags.filter((t) => t.enabled), [tags]);
  const current = useMemo(
    () => tags.find((t) => t.name === selected),
    [tags, selected],
  );

  // 1) Charger la config des tags.
  useEffect(() => {
    fetchTags()
      .then((t) => {
        setTags(t);
        const firstEnabled = t.find((x) => x.enabled);
        if (firstEnabled && !selected) setSelected(firstEnabled.name);
      })
      .catch(() => setTags([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 2) (Re)charger l'historique au changement de tag ou de plage.
  useEffect(() => {
    if (!selected) return;
    fetchHistory(selected, minutes).then((rows) => {
      xs.current = rows.map((r) => new Date(r.ts).getTime() / 1000);
      ys.current = rows.map((r) => Number(r.value));
      setData([[...xs.current], [...ys.current]]);
    });
  }, [selected, minutes]);

  // 3) WebSocket temps réel.
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
      if (ws.readyState === WebSocket.OPEN) ws.close();
      else ws.onopen = () => ws.close();
    };
  }, []);

  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const last = useMemo(
    () => (data[1].length ? data[1][data[1].length - 1] : null),
    [data],
  );

  const unit = current?.unit ?? "";
  const chartLabel = current
    ? `${tagLabel(current)}${unit ? ` (${unit})` : ""}`
    : selected;

  return (
    <>
      <div className="toolbar">
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {enabledTags.map((t) => (
            <option key={t.name} value={t.name}>
              {tagLabel(t)}
            </option>
          ))}
        </select>

        <div className="range">
          {RANGES.map((m) => (
            <button
              key={m}
              className={minutes === m ? "active" : ""}
              onClick={() => setMinutes(m)}
            >
              {m}m
            </button>
          ))}
        </div>

        <span className={`status ${live ? "live" : "off"}`}>
          {live ? "● live" : "○ déconnecté"}
        </span>
        {last !== null && (
          <span style={{ color: "#8b97a7", fontSize: 14 }}>
            dernière valeur :{" "}
            <strong style={{ color: "#e6edf3" }}>
              {last.toFixed(2)} {unit}
            </strong>
          </span>
        )}
      </div>

      <div className="card">
        <RealtimeChart data={data} label={chartLabel} />
      </div>
    </>
  );
}

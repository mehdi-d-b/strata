import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { ackAlarm, fetchAlarms, type Alarm, type Severity } from "./api";
import { loadPrefs } from "./prefs";

const POLL_MS = 7000;

// Son optionnel (Phase C) : un bip généré (Web Audio), pas de fichier audio à charger.
// Best-effort : un navigateur peut bloquer l'audio avant toute interaction utilisateur
// (politique autoplay) — dans ce cas on échoue silencieusement, le toast reste visuel.
let audioCtx: AudioContext | null = null;
function beep() {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
  } catch {
    /* AudioContext indisponible/bloqué : dégradation silencieuse. */
  }
}

type Counts = Record<Severity, number>;

type AlarmsState = {
  alarms: Alarm[];
  counts: Counts;
  /** Total non acquitté (toutes sévérités). */
  unacked: number;
  ack: (id: string) => Promise<void>;
  ackAll: () => Promise<void>;
  refresh: () => void;
};

const AlarmsContext = createContext<AlarmsState | null>(null);

const ZERO: Counts = { critical: 0, warning: 0, info: 0 };

export function AlarmsProvider({ children }: { children: ReactNode }) {
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  // Ids déjà vus (pour ne toaster que les nouvelles, pas au premier chargement).
  const seen = useRef<Set<string> | null>(null);
  // Référence vivante des alarmes (pour ackAll sans recréer le callback).
  const alarmsRef = useRef<Alarm[]>([]);
  alarmsRef.current = alarms;

  const refresh = useCallback(() => {
    fetchAlarms()
      .then((list) => {
        if (seen.current === null) {
          seen.current = new Set(list.map((a) => a.id));
        } else if (loadPrefs().alarmToasts) {
          for (const a of list) {
            if (!seen.current.has(a.id) && a.state === "active") notifyAlarm(a);
            seen.current.add(a.id);
          }
        } else {
          for (const a of list) seen.current.add(a.id);
        }
        setAlarms(list);
      })
      .catch(() => {
        /* endpoint indisponible : silencieux (dégradation). */
      });
  }, []);

  // Toast d'alarme avec action « Acquitter » directe (critique = persistant).
  const notifyAlarm = useCallback(
    (a: Alarm) => {
      const opts = {
        description: a.tag,
        action: {
          label: "Acquitter",
          onClick: () => {
            ackAlarm(a.id).then(refresh).catch(() => {});
          },
        },
      };
      if (a.severity === "critical") toast.error(a.message, { ...opts, duration: Infinity });
      else if (a.severity === "warning") toast.warning(a.message, opts);
      else toast.info(a.message, opts);
      if (loadPrefs().alarmSound) beep();
    },
    [refresh],
  );

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, POLL_MS);
    return () => clearInterval(iv);
  }, [refresh]);

  // Push WS instantané (Phase C) : même socket `/ws` que les mesures (filtré côté
  // gateway par droit de lecture sur le tag), messages `type: "alarm"`. Le polling
  // REST ci-dessus reste le filet de rattrapage (1er chargement, reconnexion) — pas
  // de reconnexion automatique ici, cohérent avec le reste du code WS du front
  // (cf. useRealtimeBuffers.ts) : au pire on retombe sur le polling ~7 s.
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = import.meta.env.VITE_WS_URL ?? `${proto}://${location.host}/ws`;
    const ws = new WebSocket(url);
    ws.onmessage = (ev) => {
      let msg: { type?: string; alarm?: Alarm };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type !== "alarm" || !msg.alarm) return;
      const a = msg.alarm;
      // Marqué "vu" tout de suite : évite un double toast quand le prochain
      // polling REST retombera sur cette même alarme.
      seen.current?.add(a.id);
      setAlarms((prev) => {
        const idx = prev.findIndex((x) => x.id === a.id);
        if (idx === -1) return [a, ...prev];
        const next = [...prev];
        next[idx] = a;
        return next;
      });
      if (a.state === "active" && loadPrefs().alarmToasts) notifyAlarm(a);
    };
    return () => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
      else ws.onopen = () => ws.close();
    };
  }, [notifyAlarm]);

  const ack = useCallback(
    async (id: string) => {
      await ackAlarm(id);
      refresh();
    },
    [refresh],
  );

  const ackAll = useCallback(async () => {
    const ids = alarmsRef.current.filter((a) => !a.acked).map((a) => a.id);
    if (ids.length === 0) return;
    await Promise.all(ids.map((id) => ackAlarm(id).catch(() => {})));
    refresh();
  }, [refresh]);

  const counts = alarms.reduce<Counts>(
    (acc, a) => {
      if (!a.acked) acc[a.severity] += 1;
      return acc;
    },
    { ...ZERO },
  );
  const unacked = counts.critical + counts.warning + counts.info;

  return (
    <AlarmsContext.Provider value={{ alarms, counts, unacked, ack, ackAll, refresh }}>
      {children}
    </AlarmsContext.Provider>
  );
}

export function useAlarms(): AlarmsState {
  const ctx = useContext(AlarmsContext);
  if (!ctx) throw new Error("useAlarms doit être utilisé dans <AlarmsProvider>");
  return ctx;
}

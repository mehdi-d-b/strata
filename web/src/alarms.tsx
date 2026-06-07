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
    },
    [refresh],
  );

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, POLL_MS);
    return () => clearInterval(iv);
  }, [refresh]);

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

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

const POLL_MS = 7000;

type Counts = Record<Severity, number>;

type AlarmsState = {
  alarms: Alarm[];
  counts: Counts;
  /** Total non acquitté (toutes sévérités). */
  unacked: number;
  ack: (id: string) => Promise<void>;
  refresh: () => void;
};

const AlarmsContext = createContext<AlarmsState | null>(null);

const ZERO: Counts = { critical: 0, warning: 0, info: 0 };

/** Toast à l'apparition d'une nouvelle alarme (critique = persistant). */
function notify(a: Alarm) {
  const opts = { description: a.tag } as const;
  if (a.severity === "critical") toast.error(a.message, { ...opts, duration: Infinity });
  else if (a.severity === "warning") toast.warning(a.message, opts);
  else toast.info(a.message, opts);
}

export function AlarmsProvider({ children }: { children: ReactNode }) {
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  // Ids déjà vus (pour ne toaster que les nouvelles, pas au premier chargement).
  const seen = useRef<Set<string> | null>(null);

  const refresh = useCallback(() => {
    fetchAlarms()
      .then((list) => {
        if (seen.current === null) {
          // Premier chargement : on amorce sans notifier.
          seen.current = new Set(list.map((a) => a.id));
        } else {
          for (const a of list) {
            if (!seen.current.has(a.id) && a.state === "active") notify(a);
            seen.current.add(a.id);
          }
        }
        setAlarms(list);
      })
      .catch(() => {
        /* endpoint indisponible : on reste silencieux (dégradation). */
      });
  }, []);

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

  const counts = alarms.reduce<Counts>(
    (acc, a) => {
      if (!a.acked) acc[a.severity] += 1;
      return acc;
    },
    { ...ZERO },
  );
  const unacked = counts.critical + counts.warning + counts.info;

  return (
    <AlarmsContext.Provider value={{ alarms, counts, unacked, ack, refresh }}>
      {children}
    </AlarmsContext.Provider>
  );
}

export function useAlarms(): AlarmsState {
  const ctx = useContext(AlarmsContext);
  if (!ctx) throw new Error("useAlarms doit être utilisé dans <AlarmsProvider>");
  return ctx;
}

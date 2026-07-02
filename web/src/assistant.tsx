import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { assistantChat, type AgentEvent } from "./api";

export type ToolCall = { name: string; ms?: number };

export type Msg = {
  role: "user" | "assistant";
  content: string;
  steps?: number;
  total_ms?: number;
  trace?: ToolCall[];
  error?: boolean;
};

const KEY = "strata.assistant.messages";

function load(): Msg[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

type AssistantState = {
  messages: Msg[];
  busy: boolean;
  liveTools: ToolCall[];
  /** Texte de la réponse finale en cours d'arrivée (v4 streaming), token par token. */
  streamingText: string;
  send: (text: string) => void;
  clear: () => void;
};

const AssistantContext = createContext<AssistantState | null>(null);

/**
 * Provider monté dans la coquille (Layout) : l'état du chat survit aux
 * changements d'onglet, et une requête en cours continue même si on quitte la
 * page (sa réponse est capturée à la résolution). Persisté en localStorage.
 */
export function AssistantProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<Msg[]>(load);
  const [busy, setBusy] = useState(false);
  const [liveTools, setLiveTools] = useState<ToolCall[]>([]);
  const [streamingText, setStreamingText] = useState("");

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(messages));
    } catch { /* quota */ }
  }, [messages]);

  const send = useCallback((text: string) => {
    const content = text.trim();
    if (!content || busyRef.current) return;
    const base: Msg[] = [...messagesRef.current, { role: "user", content }];
    setMessages(base);
    setBusy(true);
    setLiveTools([]);
    setStreamingText("");

    const history = base
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, content: m.content }));

    const traceRef: ToolCall[] = [];

    assistantChat(history, (e: AgentEvent) => {
      if (e.type === "tool_call") {
        const tc: ToolCall = { name: e.name };
        traceRef.push(tc);
        setLiveTools([...traceRef]);
        // Un texte streamé avant cet appel d'outil n'était que du "chemin de pensée"
        // transitoire (rare) — pas la réponse finale : on ne le garde pas affiché.
        setStreamingText("");
      } else if (e.type === "tool_result") {
        for (let i = traceRef.length - 1; i >= 0; i--) {
          if (traceRef[i].name === e.name && traceRef[i].ms === undefined) { traceRef[i].ms = e.ms; break; }
        }
        setLiveTools([...traceRef]);
      } else if (e.type === "token") {
        setStreamingText((t) => t + e.content);
      } else if (e.type === "answer") {
        setMessages((m) => [
          ...m,
          { role: "assistant", content: e.answer, steps: e.steps, total_ms: e.total_ms, trace: [...traceRef] },
        ]);
        setBusy(false);
        setLiveTools([]);
        setStreamingText("");
      } else if (e.type === "error") {
        setMessages((m) => [...m, { role: "assistant", error: true, content: e.message }]);
        setBusy(false);
        setLiveTools([]);
        setStreamingText("");
      }
    }).catch(() => {
      setMessages((m) => [...m, { role: "assistant", error: true, content: "Erreur de l'assistant." }]);
      setBusy(false);
      setLiveTools([]);
      setStreamingText("");
    });
  }, []);

  const clear = useCallback(() => setMessages([]), []);

  return (
    <AssistantContext.Provider value={{ messages, busy, liveTools, streamingText, send, clear }}>
      {children}
    </AssistantContext.Provider>
  );
}

export function useAssistant(): AssistantState {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant doit être utilisé dans <AssistantProvider>");
  return ctx;
}

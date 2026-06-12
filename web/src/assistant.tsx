import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, assistantChat } from "./api";

export type Msg = {
  role: "user" | "assistant";
  content: string;
  steps?: number;
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

  // Refs pour que `send` (stable) voie toujours l'état courant.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(messages));
    } catch {
      /* quota / indispo : on garde au moins en mémoire */
    }
  }, [messages]);

  const send = useCallback((text: string) => {
    const content = text.trim();
    if (!content || busyRef.current) return;
    const base: Msg[] = [...messagesRef.current, { role: "user", content }];
    setMessages(base);
    setBusy(true);
    const history = base
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, content: m.content }));
    assistantChat(history)
      .then((out) =>
        setMessages((m) => [...m, { role: "assistant", content: out.answer, steps: out.steps }]),
      )
      .catch((err) =>
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            error: true,
            content:
              err instanceof ApiError && err.status === 502
                ? "Assistant indisponible — le profil IA (Ollama) est-il démarré ? (docker compose --profile ai up -d)"
                : "Erreur de l'assistant.",
          },
        ]),
      )
      .finally(() => setBusy(false));
  }, []);

  const clear = useCallback(() => setMessages([]), []);

  return (
    <AssistantContext.Provider value={{ messages, busy, send, clear }}>
      {children}
    </AssistantContext.Provider>
  );
}

export function useAssistant(): AssistantState {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error("useAssistant doit être utilisé dans <AssistantProvider>");
  return ctx;
}

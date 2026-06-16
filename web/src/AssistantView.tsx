import { useEffect, useRef, useState } from "react";
import { Bot, ChevronDown, ChevronUp, Eraser, Send } from "lucide-react";
import { useAssistant, type Msg, type ToolCall } from "./assistant";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SUGGESTIONS = [
  "Quel est l'OEE de la ligne blonde aujourd'hui ?",
  "Combien d'alarmes critiques sont actives ?",
  "Quelle production au dernier shift ?",
  "Tendance de température IPA sur la dernière heure",
];

function BotAvatar() {
  return (
    <div className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
      <Bot className="size-4" />
    </div>
  );
}

function TracePanel({ trace, total_ms }: { trace: ToolCall[]; total_ms?: number }) {
  const [open, setOpen] = useState(false);
  if (trace.length === 0) return null;
  const label = `⚙ ${trace.length} appel${trace.length > 1 ? "s" : ""}${total_ms != null ? ` · ${(total_ms / 1000).toFixed(1)}s` : ""}`;
  return (
    <div className="mt-2 border-t border-border/40 pt-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-muted-foreground"
      >
        {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        {label}
      </button>
      {open && (
        <div className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
          {trace.map((t, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-primary/60">{t.name}</span>
              {t.ms != null && <span className="opacity-50">{t.ms}ms</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Bubble({ m }: { m: Msg }) {
  const isUser = m.role === "user";
  return (
    <div className={cn("flex gap-2", isUser ? "justify-end" : "justify-start")}>
      {!isUser && <BotAvatar />}
      <div
        className={cn(
          "max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm leading-relaxed",
          isUser
            ? "bg-primary text-primary-foreground"
            : m.error
              ? "border border-bad/40 bg-bad/10 text-bad"
              : "bg-secondary text-foreground",
        )}
      >
        {m.content}
        {!isUser && !m.error && m.trace && (
          <TracePanel trace={m.trace} total_ms={m.total_ms} />
        )}
      </div>
    </div>
  );
}

function Thinking({ tools }: { tools: ToolCall[] }) {
  return (
    <div className="flex justify-start gap-2">
      <BotAvatar />
      <div className="rounded-2xl bg-secondary px-4 py-3 text-sm text-muted-foreground">
        {tools.length === 0 ? (
          <span className="flex items-center gap-2">
            <span className="flex gap-1">
              {[0, 150, 300].map((d) => (
                <span key={d} className="size-1.5 animate-bounce rounded-full bg-muted-foreground" style={{ animationDelay: `${d}ms` }} />
              ))}
            </span>
            Réflexion…
          </span>
        ) : (
          <div>
            <div className="space-y-0.5 font-mono text-[11px]">
              {tools.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className={t.ms != null ? "text-primary/60" : "text-muted-foreground/60"}>{t.name}</span>
                  {t.ms != null ? <span className="opacity-40">{t.ms}ms ✓</span> : <span className="opacity-40 animate-pulse">···</span>}
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              <span className="flex gap-1">
                {[0, 150, 300].map((d) => (
                  <span key={d} className="size-1 animate-bounce rounded-full bg-muted-foreground/50" style={{ animationDelay: `${d}ms` }} />
                ))}
              </span>
              <span className="text-[11px] text-muted-foreground/50">en cours…</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function AssistantView() {
  const { messages, busy, liveTools, send, clear } = useAssistant();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const submit = (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    send(content);
    setInput("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex h-[calc(100vh-6rem)] flex-col">
      <PageHeader
        title="Assistant"
        description="Copilote IA local — interroge tes données en langage naturel (lecture seule, via la gateway)."
        actions={
          messages.length > 0 ? (
            <Button size="sm" variant="outline" onClick={clear}>
              <Eraser />
              Effacer
            </Button>
          ) : undefined
        }
      />

      <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {messages.length === 0 && !busy ? (
            <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
              <div className="grid size-12 place-items-center rounded-2xl bg-primary/15 text-primary">
                <Bot className="size-6" />
              </div>
              <div>
                <div className="font-semibold text-foreground">Assistant Strata</div>
                <div className="mt-1 max-w-md text-sm text-muted-foreground">
                  Pose une question sur l'OEE, la production, les alarmes ou l'historique.
                  L'assistant interroge tes données avec tes droits.
                </div>
              </div>
              <div className="flex max-w-xl flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => submit(s)}
                    className="rounded-full border border-border bg-background px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((m, i) => (
                <Bubble key={i} m={m} />
              ))}
              {busy && <Thinking tools={liveTools} />}
            </>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex items-end gap-2 border-t border-border p-3"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder="Pose ta question… (Entrée pour envoyer, Maj+Entrée pour un saut de ligne)"
            className="min-h-0 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
          />
          <Button type="submit" size="icon" disabled={busy || !input.trim()} title="Envoyer">
            <Send className="size-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}

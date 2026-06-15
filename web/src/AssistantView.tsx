import { useEffect, useRef, useState } from "react";
import { Bot, Eraser, Send } from "lucide-react";
import { useAssistant, type Msg } from "./assistant";
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
        {m.steps != null && m.steps > 0 && (
          <div className="mt-1 text-[11px] opacity-60">
            {m.steps} étape{m.steps > 1 ? "s" : ""} (appel d'outils)
          </div>
        )}
      </div>
    </div>
  );
}

function Thinking() {
  return (
    <div className="flex justify-start gap-2">
      <BotAvatar />
      <div className="flex items-center gap-2 rounded-2xl bg-secondary px-4 py-3 text-sm text-muted-foreground">
        <span className="flex gap-1">
          {[0, 150, 300].map((d) => (
            <span
              key={d}
              className="size-1.5 animate-bounce rounded-full bg-muted-foreground"
              style={{ animationDelay: `${d}ms` }}
            />
          ))}
        </span>
        L'assistant réfléchit…
      </div>
    </div>
  );
}

export function AssistantView() {
  const { messages, busy, send, clear } = useAssistant();
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
              {busy && <Thinking />}
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

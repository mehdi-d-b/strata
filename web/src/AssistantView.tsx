import { useEffect, useState } from "react";
import {
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
  useMessagePartText,
} from "@assistant-ui/react";
import { useLangGraphInterruptState, useLangGraphSendCommand } from "@assistant-ui/react-langgraph";
import { Send } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import { ackAlarm, adjustSetpoint, executeOperation } from "@/api";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";

type PendingAction = { tool: string; args: Record<string, unknown>; summary?: string };

/**
 * Proposition d'écriture (request_operation/ack_alarm) en attente de confirmation —
 * la boucle interrupt()/reprise de graph.py::_write_intercept_node se branche
 * ici. Étape 6 : "Confirmer" exécute réellement l'action AVANT de reprendre le
 * graphe, via les routes gateway déjà RBAC-checkées de l'app (executeOperation/
 * ackAlarm) — ai-service ne fait que proposer/se suspendre, jamais écrire
 * lui-même (il s'authentifie en compte de service, pas comme l'opérateur).
 * sendResumeCommand({ resume: "<json>" }) reprend le graphe au point de
 * suspension avec le résultat réel (encodé en JSON : le type `resume` de ce
 * package est une simple string, pas le vrai protocole LangGraph qui accepte
 * n'importe quelle valeur — graph.py::_parse_write_decision décode ce JSON),
 * pour que la réponse finale du modèle reflète ce qui s'est vraiment passé.
 */
function InterruptCard() {
  const interrupt = useLangGraphInterruptState();
  const sendResumeCommand = useLangGraphSendCommand();
  const [busy, setBusy] = useState(false);
  // InterruptCard n'est jamais démontée (elle rend juste `null` hors
  // interruption) : sans ce reset, `busy` resterait bloqué à `true` pour
  // toute interruption SUIVANTE après le tout premier clic Confirmer/Annuler.
  useEffect(() => {
    setBusy(false);
  }, [interrupt]);
  if (!interrupt) return null;
  const pending = interrupt.value as PendingAction | undefined;
  const summary = pending?.summary ?? "action inconnue";

  const onConfirm = async () => {
    setBusy(true);
    try {
      if (pending?.tool === "request_operation") {
        await executeOperation(String(pending.args.operation_id), String(pending.args.line));
      } else if (pending?.tool === "adjust_setpoint") {
        await adjustSetpoint(String(pending.args.line), String(pending.args.vessel), Number(pending.args.value));
      } else if (pending?.tool === "ack_alarm") {
        await ackAlarm(String(pending.args.alarm_id));
      }
      await sendResumeCommand({ resume: JSON.stringify({ confirmed: true, ok: true }) });
    } catch (e) {
      await sendResumeCommand({
        resume: JSON.stringify({ confirmed: true, ok: false, error: (e as Error).message }),
      });
    }
  };

  const onCancel = () => sendResumeCommand({ resume: JSON.stringify({ confirmed: false }) });

  return (
    <div className="mx-auto my-2 w-full max-w-2xl rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm">
      <div className="text-foreground">
        Action proposée : <strong>{summary}</strong>
      </div>
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={onConfirm} disabled={busy}>
          Confirmer
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
          Annuler
        </Button>
      </div>
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="mx-auto flex w-full max-w-2xl justify-end py-2">
      <div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2 text-sm text-primary-foreground">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

/** Mise en forme des réponses du modèle (gras, listes…), sans dépendre d'un plugin de typographie. */
const MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="mb-0.5">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>,
};

/** Texte en Markdown + indicateur de génération en cours (3 points animés, pas le curseur "●" statique par défaut). */
function AssistantText() {
  const { text } = useMessagePartText();
  return (
    <div>
      <Markdown components={MARKDOWN_COMPONENTS}>{text}</Markdown>
      <MessagePartPrimitive.InProgress>
        <span className="ml-1 inline-flex items-center gap-0.5 align-middle">
          <span className="size-1 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
          <span className="size-1 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
          <span className="size-1 animate-bounce rounded-full bg-current" />
        </span>
      </MessagePartPrimitive.InProgress>
    </div>
  );
}

/**
 * Historique persistant des actions d'écriture (request_operation/ack_alarm) : le
 * résultat de _write_intercept_node est déjà dans l'historique du thread
 * (ToolMessage) — on l'affiche au lieu de le laisser invisible, pour que
 * l'opérateur retrouve ce qui a été confirmé/annulé même après coup ou en
 * revenant sur l'onglet (survit à la navigation, contrairement à un état
 * local React).
 */
function WriteActionResult({ result, isError }: ToolCallMessagePartProps) {
  if (result == null) return null; // en attente : InterruptCard s'en charge
  return (
    <div
      className={`mx-auto my-1 w-full max-w-2xl rounded-md border px-3 py-1.5 text-xs ${
        isError ? "border-bad/40 bg-bad/10 text-bad" : "border-border bg-muted/40 text-muted-foreground"
      }`}
    >
      {String(result)}
    </div>
  );
}

type KnowledgeHit = { source: { id: number; category: string; title: string }; body: string; score: string };

/**
 * Passages retournés par search_knowledge, affichés depuis le résultat de
 * l'outil (pas depuis le texte du modèle) : l'opérateur voit ce qui a été
 * réellement retrouvé, même si le modèle oublie de citer ou cite mal. Ce sont
 * les documents CONSULTÉS, pas forcément ceux utilisés dans la réponse.
 * Titre stocké : "<document> — chunk i/N" (ai-service/ingest.py) ; la 1re
 * ligne du chunk est son titre de section (Docling contextualize).
 */
function KnowledgeSources({ result }: ToolCallMessagePartProps) {
  if (result == null) return null;
  let hits: unknown;
  try {
    hits = typeof result === "string" ? JSON.parse(result) : result;
  } catch {
    return null;
  }
  if (!Array.isArray(hits) || hits.length === 0) return null;
  return (
    <details className="my-1 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none font-medium">Documents consultés ({hits.length})</summary>
      <ul className="mt-2 flex flex-col gap-2">
        {(hits as KnowledgeHit[]).map((h) => {
          const [doc, chunk] = h.source.title.split(" — ");
          const [section, ...rest] = h.body.split("\n");
          return (
            <li key={h.source.id}>
              <div className="text-foreground">
                <span className="font-medium">{section}</span>
                <span> · {doc}{chunk ? ` (${chunk.replace("chunk", "passage")})` : ""}</span>
              </div>
              <p className="line-clamp-3 whitespace-pre-line">{rest.join("\n")}</p>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="mx-auto flex w-full max-w-2xl justify-start py-2">
      <div className="max-w-[80%] rounded-2xl bg-secondary px-4 py-2 text-sm leading-relaxed text-foreground">
        <MessagePrimitive.Parts
          components={{
            Text: AssistantText,
            tools: {
              by_name: {
                request_operation: WriteActionResult,
                adjust_setpoint: WriteActionResult,
                ack_alarm: WriteActionResult,
                search_knowledge: KnowledgeSources,
              },
            },
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

function Composer() {
  return (
    <ComposerPrimitive.Root className="mx-auto flex w-full max-w-2xl items-end gap-2 border-t border-border p-3">
      <ComposerPrimitive.Input
        rows={2}
        placeholder="Posez une question… (Entrée pour envoyer, Maj+Entrée pour un saut de ligne)"
        className="min-h-0 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
      />
      <ComposerPrimitive.Send asChild>
        <Button size="icon" title="Envoyer">
          <Send className="size-4" />
        </Button>
      </ComposerPrimitive.Send>
    </ComposerPrimitive.Root>
  );
}

// Le runtime (useLangGraphRuntime) est monté une seule fois dans Layout.tsx,
// pas ici : cette vue ne fait que consommer le contexte AssistantRuntimeProvider
// ambiant (ThreadPrimitive/MessagePrimitive le lisent automatiquement), pour
// que le fil de conversation survive à la navigation entre pages (cf. commentaire
// dans Layout.tsx pour le pourquoi).
export function AssistantView() {
  return (
    <div className="flex h-[calc(100vh-6rem)] flex-col">
      <PageHeader
        title="Assistant"
        description="Posez une question sur la production, l'OEE, les alarmes ou l'historique."
      />

      <div className="mt-4 min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card">
        <ThreadPrimitive.Root className="flex h-full flex-col">
          <ThreadPrimitive.Viewport className="flex-1 space-y-1 overflow-y-auto p-4">
            <ThreadPrimitive.Empty>
              <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
                Posez une question sur l'OEE, la production, les alarmes ou l'historique.
                <br />
                Toute action sur l'usine attend votre confirmation.
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
            <InterruptCard />
          </ThreadPrimitive.Viewport>
          <Composer />
        </ThreadPrimitive.Root>
      </div>
    </div>
  );
}

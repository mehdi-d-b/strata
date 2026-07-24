import { useMemo, useState } from "react";
import { Outlet, Link } from "react-router-dom";
import { TriangleAlert } from "lucide-react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { type LangChainMessage, unstable_createLangGraphStream, useLangGraphRuntime } from "@assistant-ui/react-langgraph";
import { Sidebar } from "@/components/Sidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { Toaster } from "@/components/ui/sonner";
import { AlarmsProvider, useAlarms } from "./alarms";
import { ASSISTANT_ID, client, createThread, getThreadState } from "@/lib/chatApi";

/** Bandeau réservé aux alarmes critiques non acquittées (sinon rien). */
function CriticalBanner() {
  const { counts } = useAlarms();
  if (counts.critical === 0) return null;
  return (
    <Link
      to="/alarms"
      className="flex items-center gap-2 bg-bad px-4 py-2 text-sm font-medium text-bad-foreground"
    >
      <TriangleAlert className="size-4" />
      {counts.critical} alarme{counts.critical > 1 ? "s" : ""} critique
      {counts.critical > 1 ? "s" : ""} non acquittée{counts.critical > 1 ? "s" : ""} — voir les alarmes
    </Link>
  );
}

/**
 * Monté ici (pas dans AssistantView) pour que le fil de conversation survive
 * à la navigation entre pages : sans backend "cloud" assistant-ui, la liste
 * de threads (useLangGraphRuntime) vit en mémoire React et est perdue dès que
 * le composant qui l'a créée est démonté — exactement comme l'ancien
 * <CopilotKit>, déjà monté à ce même niveau pour cette raison.
 */
function useAssistantRuntime() {
  const stream = useMemo(() => unstable_createLangGraphStream({ client, assistantId: ASSISTANT_ID }), []);
  return useLangGraphRuntime({
    stream,
    create: async () => {
      const { thread_id } = await createThread();
      return { externalId: thread_id };
    },
    load: async (threadId) => {
      const state = await getThreadState(threadId);
      return { messages: (state.values as { messages?: LangChainMessage[] })?.messages ?? [] };
    },
  });
}

/** Coquille de l'application : sidebar de navigation + zone de contenu (Outlet). */
export function Layout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const assistantRuntime = useAssistantRuntime();

  return (
    <AlarmsProvider>
      <AssistantRuntimeProvider runtime={assistantRuntime}>
        <div className="flex min-h-screen bg-background">
          <Sidebar onSearch={() => setPaletteOpen(true)} />
          <div className="flex min-w-0 flex-1 flex-col">
            <CriticalBanner />
            <main>
              <Outlet />
            </main>
          </div>
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
          <Toaster />
        </div>
      </AssistantRuntimeProvider>
    </AlarmsProvider>
  );
}

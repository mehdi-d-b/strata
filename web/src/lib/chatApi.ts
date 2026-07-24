import { Client } from "@langchain/langgraph-sdk";

// Proxy gateway (requireAuth + relais transparent vers ai-service, cf.
// gateway/src/index.ts) — jamais d'appel direct du navigateur à ai-service.
export const ASSISTANT_ID = "strata-assistant";

// Instance unique : unstable_createLangGraphStream (assistant-ui) a besoin
// du même client que createThread/getThreadState pour partager la session.
export const client = new Client({
  // Le SDK fait `new URL(apiUrl + path)` sans base : un chemin relatif fait
  // planter le constructeur URL dans le navigateur (pas de fallback sur
  // window.location comme le ferait fetch). On construit donc une URL
  // absolue same-origin, qui passe par le proxy Vite (dev) ou la gateway
  // elle-même (prod) exactement comme /api/langgraph le ferait en relatif.
  apiUrl: `${window.location.origin}/api/langgraph`,
  // Le proxy est protégé par la session cookie de la gateway (requireAuth) ;
  // fetch n'envoie pas les cookies par défaut en cross-context — on force.
  onRequest: (_url, init) => ({ ...init, credentials: "include" }),
});

export const createThread = () => client.threads.create();

export const getThreadState = (threadId: string) => client.threads.getState(threadId);

/**
 * Embedding local via Ollama — extrait de l'ancien assistant.ts (Chemin B,
 * supprimé). Requêtes (/api/knowledge/search) ET documents (ré-embedding au
 * boot quand le modèle change, cf. reembedStaleKnowledge dans index.ts).
 *
 * embeddinggemma (multilingue, 768 dims comme l'ancien nomic-embed-text) :
 * choisi sur une éval de recherche sur le corpus réel (27 questions opérateur,
 * 39 chunks) — bon chunk dans le top 5 pour 100 % des questions contre 74 %
 * pour nomic-embed-text, entraîné sur de l'anglais.
 */
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://ollama:11434";
export const EMBED_MODEL = process.env.EMBED_MODEL ?? "embeddinggemma";

// Préfixes de tâche attendus par le modèle (fiche modèle) : sans eux, la
// question et le document ne sont pas projetés comme prévu. Mêmes valeurs que
// ai-service/embeddings.py, qui embedde les documents à l'ingestion.
const PREFIXES: Record<string, { query: string; document: string }> = {
  embeddinggemma: { query: "task: search result | query: ", document: "title: none | text: " },
  "nomic-embed-text": { query: "search_query: ", document: "search_document: " },
};

async function embedRaw(text: string): Promise<number[]> {
  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!resp.ok) throw new Error(`embed error ${resp.status}`);
  const data = (await resp.json()) as { embeddings: number[][] };
  return data.embeddings[0];
}

export function embedQuery(text: string): Promise<number[]> {
  return embedRaw((PREFIXES[EMBED_MODEL]?.query ?? "") + text);
}

export function embedDocument(text: string): Promise<number[]> {
  return embedRaw((PREFIXES[EMBED_MODEL]?.document ?? "") + text);
}

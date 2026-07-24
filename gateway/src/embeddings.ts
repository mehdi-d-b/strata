/**
 * Embedding local via Ollama — extrait de l'ancien assistant.ts (Chemin B,
 * supprimé) : seule partie encore utilisée, par /api/knowledge/search (RAG,
 * appelé par ai-service::search_knowledge).
 */
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://ollama:11434";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";

export async function embed(text: string): Promise<number[]> {
  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!resp.ok) throw new Error(`embed error ${resp.status}`);
  const data = (await resp.json()) as { embeddings: number[][] };
  return data.embeddings[0];
}

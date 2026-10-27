"""Embeddings via Ollama — même modèle que gateway/src/embeddings.ts
(embeddinggemma), appelé directement (pas via la gateway : ce n'est pas une
donnée métier, juste un calcul stateless). Ici on n'embedde que des documents
(ingestion) ; les requêtes sont embeddées par la gateway (/api/knowledge/search)."""
import os

import httpx

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "embeddinggemma")

# Préfixe de tâche « document » attendu par le modèle (fiche modèle). Mêmes
# valeurs que PREFIXES dans gateway/src/embeddings.ts.
_DOCUMENT_PREFIXES = {
    "embeddinggemma": "title: none | text: ",
    "nomic-embed-text": "search_document: ",
}


async def embed_document(text: str) -> list[float]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{OLLAMA_URL}/api/embed",
            json={"model": EMBED_MODEL, "input": _DOCUMENT_PREFIXES.get(EMBED_MODEL, "") + text},
        )
        resp.raise_for_status()
        data = resp.json()
        return data["embeddings"][0]

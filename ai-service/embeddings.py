"""Embeddings via Ollama — même modèle que gateway/src/assistant.ts::embed
(nomic-embed-text), appelé directement (pas via la gateway : ce n'est pas une
donnée métier, juste un calcul stateless)."""
import os

import httpx

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "nomic-embed-text")


async def embed(text: str) -> list[float]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{OLLAMA_URL}/api/embed",
            json={"model": EMBED_MODEL, "input": text},
        )
        resp.raise_for_status()
        data = resp.json()
        return data["embeddings"][0]

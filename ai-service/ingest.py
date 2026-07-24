"""Ingestion PDF -> base de connaissances (RAG).

CLI : uv run python ingest.py (relit gateway/knowledge-pdfs/*.pdf).
HTTP : POST /ingest/pdf (main.py), pour l'upload depuis la page Admin
« Base de connaissances » (étape 7) — même fonction `ingest_pdf_bytes`,
juste une source différente (disque vs upload).

Portage Python de gateway/src/seed-knowledge-pdf.ts, étape 3 du plan de
migration : extraction et découpage passent en Python — mêmes paramètres
(chunk_size=1000, overlap=150), mêmes conventions (category='manuel',
title="<fichier> — chunk i/N").

Extraction via `pypdf` directement, PAS `langchain_community.PyPDFLoader`
(qui n'est qu'un fin wrapper autour de pypdf) : `langchain-community` a été
archivé/sunset par LangChain le 19 juin 2026 (annonce du 22 mai 2026,
https://github.com/langchain-ai/langchain-community/issues/674) — découvert
en direct via un DeprecationWarning à l'exécution, PAS anticipé (une recherche
web quelques minutes plus tôt affichait encore PyPDFLoader comme le chemin
recommandé — doc pas à jour vu la fraîcheur de l'annonce). Même choix que côté
JS (`pdfjs-dist` en direct plutôt que `@langchain/community`), pour la même
raison : ne pas dépendre d'un paquet non maintenu pour une simple extraction
de texte. Seul `langchain-text-splitters` (paquet dédié, toujours maintenu)
est utilisé du framework ici.

N'écrit JAMAIS directement dans Postgres : embed ici (Ollama, direct — pas une
donnée métier), puis POST /api/knowledge/ingest sur la gateway (seule porte
d'entrée vers la base, même invariant que tout ai-service).
"""
import asyncio
import io
import pathlib

from langchain_text_splitters import RecursiveCharacterTextSplitter
from pypdf import PdfReader

import gateway
from embeddings import embed

PDF_DIR = pathlib.Path(__file__).parent / "knowledge-pdfs"
_SPLITTER = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=150)


async def ingest_pdf_bytes(filename: str, data: bytes) -> int:
    """Extrait, découpe, embed et upsert un PDF (bytes bruts). Retourne le
    nombre de chunks. `filename` sert de base au titre (sans l'extension)."""
    reader = PdfReader(io.BytesIO(data))
    full_text = "\n".join(page.extract_text() or "" for page in reader.pages)
    chunks = _SPLITTER.split_text(full_text)

    base = pathlib.Path(filename).stem
    for i, chunk in enumerate(chunks):
        title = f"{base} — chunk {i + 1}/{len(chunks)}"
        vec = await embed(chunk)
        resp = await gateway.post("/api/knowledge/ingest", {
            "category": "manuel",
            "title": title,
            "body": chunk,
            "embedding": vec,
        })
        resp.raise_for_status()
    return len(chunks)


async def main() -> None:
    if not PDF_DIR.exists():
        print(f"Aucun PDF trouvé dans {PDF_DIR}.")
        return
    files = sorted(PDF_DIR.glob("*.pdf"))
    if not files:
        print(f"Aucun PDF trouvé dans {PDF_DIR}.")
        return

    total = 0
    for f in files:
        n = await ingest_pdf_bytes(f.name, f.read_bytes())
        print(f"{f.name}: {n} chunk(s)")
        total += n
    print(f"\nTerminé : {total} chunk(s) inséré(s)/mis à jour depuis {len(files)} PDF.")


if __name__ == "__main__":
    asyncio.run(main())

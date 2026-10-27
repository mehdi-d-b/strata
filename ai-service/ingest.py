"""Ingestion PDF -> base de connaissances (RAG).

CLI : uv run python ingest.py (relit knowledge-pdfs/*.pdf).
HTTP : POST /ingest/pdf (main.py), pour l'upload depuis la page Admin
« Base de connaissances » (étape 7) — même fonction `ingest_pdf_bytes`,
juste une source différente (disque vs upload).

Extraction + découpage via Docling (DocumentConverter + HybridChunker), PAS
pypdf + découpage par taille de caractères (approche précédente) : pypdf n'a
aucune notion de mise en page — un titre en gras et son corps de texte ne sont
qu'un flux de caractères identique, donc un découpage par taille recolle
arbitrairement page de garde, titres et contenu (vérifié en direct : la bonne
fiche ne remontait plus dans le top 5 d'une recherche pourtant évidente).
Docling comprend la structure du document (titres, paragraphes) et
`HybridChunker` découpe le long de ces frontières — marche aussi bien pour un
PDF généré ici (generate_manual_pdf.py) qu'un vrai manuel scanné/mis en page
par un automaticien, contrairement à un marqueur de structure fait main qui ne
profiterait qu'à nos propres PDF.
`chunker.contextualize()` (pas `chunk.text` brut) préfixe chaque chunk du
fil de titres parents — un chunk embeddé sait de quelle section il vient.

Coût assumé : Docling embarque un modèle de mise en page (torch), chargé UNE
SEULE FOIS au niveau module (pas par appel — sinon chaque upload paierait le
temps de chargement). OCR et extraction de tableaux désactivés (do_ocr=False,
do_table_structure=False) : nos PDF sont du texte natif, jamais scanné —
inutile de charger les modèles OCR correspondants.

N'écrit JAMAIS directement dans Postgres : embed ici (Ollama, direct — pas une
donnée métier), puis POST /api/knowledge/ingest sur la gateway (seule porte
d'entrée vers la base, même invariant que tout ai-service).
"""
import asyncio
import io
import pathlib

from docling.chunking import HybridChunker
from docling.datamodel.base_models import DocumentStream, InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption

import gateway
from embeddings import EMBED_MODEL, embed_document

PDF_DIR = pathlib.Path(__file__).parent / "knowledge-pdfs"

_PIPELINE_OPTIONS = PdfPipelineOptions()
_PIPELINE_OPTIONS.do_ocr = False
_PIPELINE_OPTIONS.do_table_structure = False
_CONVERTER = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=_PIPELINE_OPTIONS)})
_CHUNKER = HybridChunker()


def _convert_and_chunk(filename: str, data: bytes) -> list[str]:
    """Partie synchrone, CPU-bound (inférence du modèle de mise en page) —
    isolée pour tourner dans un thread (cf. asyncio.to_thread ci-dessous).
    Appelée directement dans la boucle async d'ingest_pdf_bytes, le serveur
    `langgraph dev` (qui sert aussi cette route via main.py) la détecte comme
    appel bloquant et fait échouer la requête HTTP (le CLI, lui, n'a pas ce
    garde-fou — d'où un plantage vu uniquement via l'upload Admin, pas en CLI)."""
    stream = DocumentStream(name=filename, stream=io.BytesIO(data))
    result = _CONVERTER.convert(stream)
    return [_CHUNKER.contextualize(c) for c in _CHUNKER.chunk(result.document)]


async def ingest_pdf_bytes(filename: str, data: bytes) -> int:
    """Extrait, découpe, embed et upsert un PDF (bytes bruts). Retourne le
    nombre de chunks. `filename` sert de base au titre (sans l'extension)."""
    chunks = await asyncio.to_thread(_convert_and_chunk, filename, data)

    base = pathlib.Path(filename).stem
    for i, chunk in enumerate(chunks):
        title = f"{base} — chunk {i + 1}/{len(chunks)}"
        vec = await embed_document(chunk)
        resp = await gateway.post("/api/knowledge/ingest", {
            "category": "manuel",
            "title": title,
            "body": chunk,
            "embedding": vec,
            "embed_model": EMBED_MODEL,
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

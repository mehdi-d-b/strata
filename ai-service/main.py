"""FastAPI minimal, monté à côté du serveur LangGraph via langgraph.json
(http.app) — le chat passe désormais par ce serveur natif (/threads,
/runs/stream), plus par ce fichier. Ne reste ici que ce qui n'est pas une
conversation : sonde de vie, upload PDF pour la base de connaissances."""
import base64

from fastapi import FastAPI
from pydantic import BaseModel

from ingest import ingest_pdf_bytes

app = FastAPI(title="Strata AI Service")


class IngestPdfRequest(BaseModel):
    filename: str
    content_base64: str


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/ingest/pdf")
async def ingest_pdf(req: IngestPdfRequest):
    """Upload PDF -> RAG (étape 7, page Admin « Base de connaissances »).
    Appelé par la gateway (POST /api/knowledge/upload), qui relaie le fichier
    reçu du front en base64 — même pipeline que `ingest.py` (CLI)."""
    data = base64.b64decode(req.content_base64)
    chunks = await ingest_pdf_bytes(req.filename, data)
    return {"filename": req.filename, "chunks": chunks}

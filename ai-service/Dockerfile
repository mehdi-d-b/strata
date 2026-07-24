FROM python:3.12-slim
WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvbin/uv
ENV PATH="/uvbin:$PATH"

# Dépendances d'abord (cache Docker), comme gateway/Dockerfile.
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-install-project

COPY . .
RUN uv sync --locked

EXPOSE 8000
# Serveur LangGraph natif (protocole /threads+/runs/stream, consommé par
# assistant-ui via @langchain/langgraph-sdk) — monte aussi main.py (FastAPI,
# /health + /ingest/pdf) via langgraph.json (http.app). `dev` reste le nom de
# la commande CLI, mais c'est le process qui tourne en continu ici (choix
# assumé pour l'échelle de ce projet — pas de Redis/Postgres supplémentaire
# requis par `langgraph up`, qui vise une vraie mise à l'échelle).
CMD ["uv", "run", "langgraph", "dev", "--host", "0.0.0.0", "--port", "8000", "--no-reload", "--no-browser"]

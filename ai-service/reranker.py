"""Reranker cross-encoder pour search_knowledge.

La recherche hybride de la gateway (dense + plein texte, RRF) compare la
question et chaque chunk SÉPARÉMENT (deux vecteurs). Un cross-encoder lit la
paire (question, chunk) ENSEMBLE : plus précis, mais trop lent pour tout le
corpus — d'où le schéma classique : la gateway renvoie 10 candidats, on les
reclasse ici, on en garde 5.

bge-reranker-v2-m3 (multilingue) : sur l'éval de recherche du corpus réel
(27 questions opérateur), bon chunk en 1re position 93 % des cas contre 85 %
sans reranker (embeddinggemma seul). Coût par recherche (10 candidats) :
~1 s en natif sur le Mac, ~4 s dans Docker (CPU de la VM, pas de GPU Metal).

Le modèle (~2,3 Go) est téléchargé depuis Hugging Face au premier appel, comme
le modèle de mise en page de Docling. S'il est indisponible (pas de réseau en
usine…), on garde l'ordre de la gateway : dégradé, pas en panne.
"""
import logging
import os
import threading

RERANK_MODEL = os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")

_log = logging.getLogger(__name__)
_lock = threading.Lock()
_loaded = None  # (tokenizer, model) une fois chargé


def _load():
    global _loaded
    with _lock:
        if _loaded is None:
            from transformers import AutoModelForSequenceClassification, AutoTokenizer

            # Cache local d'abord, sans aucun appel réseau : par défaut,
            # transformers interroge Hugging Face à chaque chargement pour
            # vérifier la version (vu dans les logs). Téléchargement seulement
            # si le modèle n'est pas encore en cache (premier démarrage).
            try:
                tokenizer = AutoTokenizer.from_pretrained(RERANK_MODEL, local_files_only=True)
                model = AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, local_files_only=True)
            except OSError:
                tokenizer = AutoTokenizer.from_pretrained(RERANK_MODEL)
                model = AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL)
            _loaded = (tokenizer, model.eval())
    return _loaded


def rerank(query: str, texts: list[str]) -> list[float] | None:
    """Scores de pertinence (plus haut = plus pertinent), dans l'ordre de
    `texts`. None si le reranker est désactivé (RERANK_MODEL vide) ou
    indisponible. Synchrone et CPU-bound : à appeler via asyncio.to_thread."""
    if not RERANK_MODEL or not texts:
        return None
    try:
        import torch

        tokenizer, model = _load()
        with torch.no_grad():
            enc = tokenizer([[query, t] for t in texts], padding=True, truncation=True,
                            max_length=512, return_tensors="pt")
            return model(**enc).logits.view(-1).tolist()
    except Exception as err:  # réseau, mémoire… : on retombe sur l'ordre RRF
        _log.warning("reranker indisponible, ordre de la gateway conservé : %s", err)
        return None

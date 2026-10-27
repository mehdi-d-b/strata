"""Éval de recherche RAG : le bon passage remonte-t-il, et quel seuil de score
du reranker garder ? Même chaîne que la prod (embeddinggemma avec préfixes,
10 candidats, reranker.py, 5 gardés) sur les 39 passages réels figés dans
fixtures/knowledge_chunks.json. Recherche dense seule : la prod y ajoute le
plein texte (RRF), donc les chiffres ici sont plutôt un plancher.

Usage (depuis ai-service/, Ollama lancé) :
  uv run python -m evals.retrieval
Biais connu : questions écrites après lecture des passages, et seuls les
passages listés comptent comme pertinents (un voisin utile compte comme bruit).
"""
import asyncio
import json
from pathlib import Path

import httpx
import numpy as np

from embeddings import EMBED_MODEL, OLLAMA_URL, embed_document
from reranker import rerank
from tools import _KNOWLEDGE_RESULTS, _RERANK_CANDIDATES

# Préfixe requête d'embeddinggemma — même valeur que gateway/src/embeddings.ts.
QUERY_PREFIX = "task: search result | query: "

B = "manuel-exploitation-brasserie#"
QUESTIONS = [
    ("La remplisseuse est bloquée en attente, qu'est-ce que je vérifie ?", [B + "2"]),
    ("Quelles sont les étapes du nettoyage en place et à quelles températures ?", [B + "3"]),
    ("La cuve de fermentation de l'IPA chauffe trop, que faire ?", [B + "4", B + "25"]),
    ("On a sorti moins de bière que prévu sur le dernier brassin, pourquoi ?", [B + "5"]),
    ("Une machine affiche state à zéro, est-ce grave ?", [B + "6"]),
    ("Comment relancer une ligne qui était complètement arrêtée ?", [B + "7", B + "8", B + "9"]),
    ("Je dois couper la ligne IPA ce soir, comment faire proprement ?", [B + "10", B + "11"]),
    ("Que faut-il transmettre à l'équipe suivante en fin de poste ?", [B + "12", B + "13"]),
    ("Le labo a trouvé des bactéries dans le lot, quelle cause probable ?", [B + "14"]),
    ("Pourquoi un batch est-il classé fermentation hors spécification ?", [B + "15"]),
    ("L'embouteillage a produit trop peu de bouteilles sur ce lot", [B + "16"]),
    ("À quelle température fermente la lager ?", [B + "17"]),
    ("Combien de temps fait-on bouillir le moût de l'IPA ?", [B + "18"]),
    ("Quand ajoute-t-on les piments dans la bière épicée ?", [B + "19"]),
    ("La résistance de la cuve d'empâtage met longtemps à chauffer", [B + "20"]),
    ("Comment vérifier la sonde de température du fermenteur ?", [B + "21"]),
    ("Quels contrôles quotidiens sur la machine de remplissage ?", [B + "22"]),
    ("Le TRS est à 40 %, par où commencer ?", [B + "23", B + "24"]),
    ("La fermentation de la blonde est descendue à 8 degrés, c'est un problème ?", [B + "26", B + "27"]),
    ("La capsuleuse est en bourrage", [B + "28"]),
    ("Un lot ne passe pas le contrôle qualité, que fait-on des bouteilles ?", [B + "29", B + "30", B + "31"]),
    ("La température du glycol monte à 7 °C toutes les quinze minutes, c'est normal ?", ["manuel-groupe-froid#2"]),
    ("Que contrôler chaque mois sur le circuit frigorifique ?", ["manuel-groupe-froid#3"]),
    ("La bouteille de gaz de la tireuse est presque vide, comment la remplacer ?",
     ["procedure-cO2-embouteilleuse#3", "procedure-cO2-embouteilleuse#1"]),
    ("Le manomètre du CO2 descend sous 45 bar", ["procedure-cO2-embouteilleuse#2"]),
    ("Quels risques en cas de fuite de gaz carbonique dans le local ?", ["procedure-cO2-embouteilleuse#4"]),
    ("Le froid ne suit plus, la sortie glycol reste haute depuis 10 minutes",
     ["manuel-groupe-froid#4", "manuel-groupe-froid#1"]),
]
THRESHOLDS = [None, -6.0, -5.0, -4.0, -3.0, -2.0]


def _unit(vecs: list[list[float]]) -> np.ndarray:
    a = np.array(vecs, dtype=np.float32)
    return a / np.linalg.norm(a, axis=1, keepdims=True)


async def main() -> None:
    chunks = json.loads((Path(__file__).parent / "fixtures" / "knowledge_chunks.json").read_text())
    docs = _unit([await embed_document(c["text"]) for c in chunks])
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(f"{OLLAMA_URL}/api/embed",
                                 json={"model": EMBED_MODEL, "input": [QUERY_PREFIX + q for q, _ in QUESTIONS]})
    queries = _unit(resp.json()["embeddings"])

    ranked: list[list[tuple[float, bool]]] = []  # par question : (score reranker, pertinent ?) trié
    hit1 = hit5 = mrr = 0.0
    for (question, relevant), qv in zip(QUESTIONS, queries):
        cands = [chunks[i] for i in np.argsort(-(docs @ qv))[:_RERANK_CANDIDATES]]
        scores = await asyncio.to_thread(rerank, question, [c["text"] for c in cands])
        order = sorted(zip(scores, (c["id"] in relevant for c in cands)), reverse=True)
        ranked.append(order)
        first = next((i for i, (_, rel) in enumerate(order) if rel), None)
        if first is not None:
            hit1 += first < 1
            hit5 += first < _KNOWLEDGE_RESULTS
            mrr += 1 / (first + 1)
    n = len(QUESTIONS)
    print(f"{EMBED_MODEL} + reranker, {_RERANK_CANDIDATES} candidats, {n} questions")
    print(f"hit@1 {hit1 / n:.2f}   hit@{_KNOWLEDGE_RESULTS} {hit5 / n:.2f}   MRR {mrr / n:.2f}\n")

    # Seuil : on garde les passages au score >= seuil (au moins 1, au plus 5).
    print(f"{'seuil':>8}{'pertinent gardé':>18}{'bruit / question':>19}{'passages / question':>22}")
    for t in THRESHOLDS:
        kept_rel = noise = total = 0
        for order in ranked:
            top = order[:_KNOWLEDGE_RESULTS]
            kept = top if t is None else [p for i, p in enumerate(top) if i == 0 or p[0] >= t]
            kept_rel += any(rel for _, rel in kept) or not any(rel for _, rel in top)
            noise += sum(not rel for _, rel in kept)
            total += len(kept)
        label = "aucun" if t is None else f"{t:.1f}"
        print(f"{label:>8}{kept_rel / n:>18.2f}{noise / n:>19.2f}{total / n:>22.2f}")

    rel_scores = sorted(s for order in ranked for s, rel in order[:_KNOWLEDGE_RESULTS] if rel)
    print(f"\nscore du passage pertinent le plus bas (top {_KNOWLEDGE_RESULTS}) : {rel_scores[0]:.2f}")


if __name__ == "__main__":
    asyncio.run(main())

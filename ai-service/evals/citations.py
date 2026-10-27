"""Éval des citations : après un search_knowledge, le modèle termine-t-il par
une ligne « Sources : » qui ne cite que des passages réellement fournis ?
Correcteur en code (pas de LLM juge). Ne mesure PAS la fidélité de la réponse
aux passages (citer n'est pas être fidèle) : seulement que les citations
existent et pointent vers un passage pertinent.

Le résultat de l'outil est rejoué (passages pertinents + 2 passages hors sujet,
tirés de fixtures/knowledge_chunks.json, au format de la prod), avec le même
system prompt et les mêmes réglages que graph.py.

Usage (depuis ai-service/, Ollama lancé) :
  uv run python -m evals.citations qwen3.5:9b -k 3
"""
import argparse
import asyncio
import json
import re
from pathlib import Path

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_ollama import ChatOllama

from evals.retrieval import QUESTIONS
from evals.tool_selection import _system_prompt
from graph import AI_SERVICE_THINK, OLLAMA_URL
from tools import ALL_TOOLS

# Questions procédurales (indices dans evals.retrieval.QUESTIONS) et 2 passages
# hors sujet ajoutés à chaque résultat, comme le bruit observé en direct.
CASES = [0, 1, 6, 8, 16, 19, 20, 23]
NOISE = ["manuel-exploitation-brasserie#17", "manuel-groupe-froid#3"]


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def _grade(answer: str, hits: list[dict], relevant: list[str]) -> dict:
    lines = [l for l in answer.splitlines() if _norm(l).lstrip("*_ ").startswith("sources")]
    if not lines:
        return {"has_sources": False, "all_valid": False, "cites_relevant": False}
    cited = _norm(lines[-1].split(":", 1)[-1])
    matched = [h for h in hits if _norm(h["body"].split("\n")[0]) in cited]
    leftover = cited
    for h in matched:
        leftover = leftover.replace(_norm(h["body"].split("\n")[0]), "")
    return {
        "has_sources": True,
        # Rien d'autre que des titres reconnus et des séparateurs : pas de source inventée.
        "all_valid": bool(matched) and not re.search(r"[a-zà-ÿ0-9]{4,}", leftover),
        "cites_relevant": any(h["chunk_id"] in relevant for h in matched),
    }


async def evaluate(model: str, k: int) -> dict:
    chunks = {c["id"]: c["text"] for c in json.loads(
        (Path(__file__).parent / "fixtures" / "knowledge_chunks.json").read_text())}
    llm = ChatOllama(model=model, base_url=OLLAMA_URL, num_ctx=8192, temperature=0.2,
                     reasoning=AI_SERVICE_THINK).bind_tools(ALL_TOOLS)
    system = await _system_prompt()
    runs = []
    for idx in CASES:
        question, relevant = QUESTIONS[idx]
        hits = [{"chunk_id": cid, "source": {"id": n, "category": "manuel", "title": cid}, "body": chunks[cid]}
                for n, cid in enumerate(relevant + NOISE)]
        tool_result = json.dumps([{k: v for k, v in h.items() if k != "chunk_id"} for h in hits], ensure_ascii=False)
        messages = [
            SystemMessage(system), HumanMessage(question),
            AIMessage(content="", tool_calls=[{"name": "search_knowledge", "args": {"query": question}, "id": "c1"}]),
            ToolMessage(content=tool_result, tool_call_id="c1", name="search_knowledge"),
        ]
        for _ in range(k):
            msg = await llm.ainvoke(messages)
            grade = _grade(str(msg.content), hits, relevant)
            runs.append({"question": question, **grade, "answer_tail": str(msg.content)[-200:]})
            print(f"  {'✓' if grade['all_valid'] and grade['cites_relevant'] else '✗'} {question}")
    n = len(runs)
    summary = {
        "model": model, "k": k, "n_runs": n,
        "has_sources": round(sum(r["has_sources"] for r in runs) / n, 3),
        "all_valid": round(sum(r["all_valid"] for r in runs) / n, 3),
        "cites_relevant": round(sum(r["cites_relevant"] for r in runs) / n, 3),
    }
    return {"summary": summary, "runs": runs}


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("models", nargs="+")
    parser.add_argument("-k", type=int, default=3)
    opts = parser.parse_args()
    out_dir = Path(__file__).parent / "results"
    out_dir.mkdir(exist_ok=True)
    for model in opts.models:
        print(f"== {model}")
        result = await evaluate(model, opts.k)
        (out_dir / f"citations_{model.replace(':', '_')}.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2))
        print(json.dumps(result["summary"], ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())

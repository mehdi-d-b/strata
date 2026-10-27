"""Éval de sélection d'outil : le modèle choisit-il le bon tool avec les bons
arguments ? Correcteur 100 % déterministe (pas de LLM juge) : on compare le
premier tool call produit à celui attendu.

N'exécute AUCUN tool et ne contacte pas la gateway : seul le modèle est testé
(bind_tools + un seul appel), avec le même system prompt (contexte usine
rejoué depuis une fixture) et les mêmes réglages que graph.py. Isole donc le
modèle des données du simulateur, qui changent en permanence.

Usage (depuis ai-service/, Ollama lancé) :
  uv run python -m evals.tool_selection qwen2.5:7b qwen3.5:9b -k 3
Écrit evals/results/<modèle>.json — à comparer d'une version à l'autre
(régression = un cas qui passe de vert à rouge, pas seulement la moyenne).
"""
import argparse
import asyncio
import json
import time
from pathlib import Path

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_ollama import ChatOllama

import context
from graph import OLLAMA_URL, SYSTEM_PROMPT_STATIC
from tools import ALL_TOOLS

# Réponse figée de GET /api/factory-context (seed de infra/timescale/init/09-oee.sql),
# rejouée à la place de la gateway : le system prompt est alors le même qu'en
# prod (statique + contexte usine) sans dépendre d'un stack démarré.
FACTORY_CONTEXT_FIXTURE = {
    "lines": [
        {"line": f"brasserie.{name}", "label": label, "ideal_rate": rate,
         "machines": ["empateur", "ebullition", "fermenteur", "embouteilleuse"]}
        for name, label, rate in (("blonde", "Ligne Blonde", 50), ("ipa", "Ligne IPA", 40),
                                  ("jalapeno", "Ligne Jalapeño", 35))
    ],
    "recipes": ["blonde", "ipa", "jalapeno"],
}


class _FixtureResponse:
    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return FACTORY_CONTEXT_FIXTURE


async def _system_prompt() -> str:
    async def fake_get(path, params=None):
        return _FixtureResponse()

    context.gateway.get = fake_get
    factory_context, _ = await context.build_factory_context()
    return f"{SYSTEM_PROMPT_STATIC}\n\n{factory_context}"

# (question, outil(s) acceptable(s), arguments attendus — sous-ensemble).
# Une valeur str attendue est comparée en "contient", insensible à la casse.
CASES: list[tuple[str, list[str], dict]] = [
    ("Quel est l'OEE de la ligne blonde sur les 7 derniers jours ?", ["get_oee"], {"line": "brasserie.blonde"}),
    ("Résume l'OEE de la blonde", ["get_oee"], {"line": "brasserie.blonde"}),
    ("Donne-moi l'OEE de la ligne IPA", ["get_oee"], {"line": "brasserie.ipa"}),
    ("Combien de bonnes pièces et de rebut cette semaine ?", ["get_production"], {}),
    ("Quelles sont les alarmes actives ?", ["list_alarms"], {}),
    ("Combien y a-t-il de batches en cours ?", ["get_active_batches"], {}),
    ("Liste les batches en cours", ["get_active_batches"], {}),
    ("Montre-moi la température du fermenteur IPA sur la dernière heure", ["get_history"],
     {"tag": "brasserie.ipa.fermenteur.temperature"}),
    ("Où en est la ligne jalapeno en ce moment ?", ["get_line_status"], {"line": "brasserie.jalapeno"}),
    ("Résume-moi le shift en cours", ["get_shift_summary"], {}),
    ("Quelles sont les principales pertes d'OEE aujourd'hui ?", ["get_oee_breakdown"], {}),
    ("Comment changer un fût de CO2 ?", ["search_knowledge"], {}),
    ("Que faire si la pompe de l'empâteur fait un bruit anormal ?", ["search_knowledge"], {}),
    ("Quelle est la procédure de nettoyage CIP ?", ["search_knowledge"], {}),
    ("Arrête la ligne blonde", ["search_knowledge"], {}),
    ("Démarre la ligne IPA", ["search_knowledge"], {}),
    ("Monte la consigne du fermenteur de la blonde à 12 °C", ["adjust_setpoint"],
     {"line": "brasserie.blonde", "vessel": "fermenteur", "value": 12}),
    ("Acquitte l'alarme 42", ["ack_alarm"], {"alarm_id": "42"}),
    ("Pourquoi le dernier batch IPA est-il hors spec ?", ["get_batch_context"], {"batch_ref": "ipa"}),
    ("Quelles tables de données sont disponibles ?", ["describe_schema"], {}),
    ("Combien de batches IPA ont été produits depuis le début du mois ?",
     ["describe_schema", "query_readonly"], {}),
]


def _args_match(expected: dict, got: dict) -> bool:
    for key, want in expected.items():
        have = got.get(key)
        if isinstance(want, str):
            if not isinstance(have, str) or want.lower() not in have.lower():
                return False
        elif isinstance(want, (int, float)):
            try:
                if float(have) != float(want):
                    return False
            except (TypeError, ValueError):
                return False
        elif have != want:
            return False
    return True


async def _run_case(llm, system: str, question: str, tools: list[str], args: dict) -> dict:
    start = time.perf_counter()
    msg = await llm.ainvoke([SystemMessage(system), HumanMessage(question)])
    latency = time.perf_counter() - start
    calls = msg.tool_calls or []
    first = calls[0] if calls else None
    tool_ok = bool(first) and first["name"] in tools
    return {
        "tool": first["name"] if first else None,
        "args": first["args"] if first else None,
        "tool_ok": tool_ok,
        "args_ok": tool_ok and _args_match(args, first["args"]),
        # Fuite déjà vue en direct : l'appel d'outil sort en texte au lieu d'un tool call.
        "leak": "<tool_call>" in str(msg.content) or '"name":' in str(msg.content),
        "latency_s": round(latency, 2),
    }


async def evaluate(model: str, k: int, think: bool | None) -> dict:
    llm = ChatOllama(
        model=model, base_url=OLLAMA_URL, num_ctx=8192, temperature=0.2, reasoning=think,
    ).bind_tools(ALL_TOOLS)
    # Premier appel hors mesure : chargement du modèle en mémoire.
    await llm.ainvoke([HumanMessage("bonjour")])
    system = await _system_prompt()
    cases = []
    for question, tools, args in CASES:
        runs = [await _run_case(llm, system, question, tools, args) for _ in range(k)]
        cases.append({"question": question, "expected": tools, "runs": runs,
                      "pass_all": all(r["args_ok"] for r in runs)})
        print(f"  {'✓' if cases[-1]['pass_all'] else '✗'} {question} -> {[r['tool'] for r in runs]}")
    runs = [r for c in cases for r in c["runs"]]
    summary = {
        "model": model, "k": k, "think": think, "n_cases": len(cases),
        "tool_accuracy": round(sum(r["tool_ok"] for r in runs) / len(runs), 3),
        "args_accuracy": round(sum(r["args_ok"] for r in runs) / len(runs), 3),
        "pass_hat_k": round(sum(c["pass_all"] for c in cases) / len(cases), 3),
        "leak_rate": round(sum(r["leak"] for r in runs) / len(runs), 3),
        "median_latency_s": sorted(r["latency_s"] for r in runs)[len(runs) // 2],
    }
    return {"summary": summary, "cases": cases}


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("models", nargs="+")
    parser.add_argument("-k", type=int, default=3, help="répétitions par cas (pass^k)")
    parser.add_argument("--think", choices=["on", "off", "default"], default="off",
                        help="mode réflexion (modèles qui le supportent) ; default = laisser le modèle décider")
    opts = parser.parse_args()
    think = {"on": True, "off": False, "default": None}[opts.think]
    out_dir = Path(__file__).parent / "results"
    out_dir.mkdir(exist_ok=True)
    for model in opts.models:
        print(f"== {model}")
        result = await evaluate(model, opts.k, think)
        (out_dir / f"{model.replace(':', '_')}.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2))
        print(json.dumps(result["summary"], ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())

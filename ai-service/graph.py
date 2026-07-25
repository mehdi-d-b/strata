"""Graphe de l'agent — portage de gateway/src/assistant.ts::runAssistant.

Structure (miroir de la boucle TS) :
  init (calcule factory_context/recipes) -> entrée conditionnelle
    -> forced_batch (si diagnostic de batch détecté) -> agent
    -> agent (sinon, directement)
  agent -> write_intercept (si un/des tool(s) d'écriture sont demandés : jamais
           exécutés ici — un interrupt() par action suspend le graphe, chaque
           resume() le reprend) -> agent (boucle, comme les tools de lecture)
  agent -> tools (si un/des tool(s) de lecture sont demandés) -> agent (boucle)
  agent -> END (réponse finale)

Servi par le serveur LangGraph natif (`langgraph dev`, cf. langgraph.json et
Dockerfile) — protocole standard (/threads, /runs/stream), consommé par
assistant-ui (web/) via @langchain/langgraph-sdk. Le serveur gère lui-même la
persistance (checkpointer) ; `build_graph()` accepte un `checkpointer` optionnel
uniquement pour l'usage local hors serveur (tests, scripts).

Exécution réelle des actions d'écriture (étape 6) : ai-service ne l'exécute
JAMAIS lui-même — il s'authentifie contre la gateway comme un compte de
service (cf. gateway.py), pas comme l'opérateur qui discute, et ne peut donc
pas re-vérifier le RBAC avec la VRAIE identité. C'est le NAVIGATEUR (qui a la
vraie session) qui exécute réellement, via les routes gateway déjà
RBAC-checkées (`POST /api/operations/execute`, `POST /api/alarms/:id/ack`,
cf. web/src/AssistantView.tsx::InterruptCard), puis reprend le graphe
(`sendCommand({resume: {confirmed, ok, error?}})`) avec le résultat réel.
"""
import json
import os
import operator
from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, AnyMessage, SystemMessage, ToolMessage
from langchain_ollama import ChatOllama
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from langgraph.types import interrupt

import gateway
from context import build_factory_context
from routing import build_knowledge_query, detect_batch_diagnostic, detect_line_blocked
from tools import ALL_TOOLS, WRITE_TOOLS, get_batch_context, get_line_status, search_knowledge

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
# AI_SERVICE_MODEL, pas ASSISTANT_MODEL (réservée à gateway/src/assistant.ts) :
# qwen2.5:7b, choisi après tests de tool-calling via LangGraph (cf. docker-compose.yml).
AI_SERVICE_MODEL = os.environ.get("AI_SERVICE_MODEL", "qwen2.5:7b")
MAX_STEPS = 10

READ_TOOLS = [t for t in ALL_TOOLS if t.name not in WRITE_TOOLS]

SYSTEM_PROMPT_STATIC = (
    "Tu es l'assistant de Strata, une plateforme de supervision de données industrielles. "
    "Réponds en français, de façon concise et PRÉCISE : réponds exactement à la question posée, sans analyse, résumé ni "
    "recommandations non demandés. Si on demande une seule chose (la dernière alarme, un chiffre…), "
    "donne juste ça. Pour toute donnée chiffrée (OEE, production, alarmes, mesures), utilise TOUJOURS les "
    "tools — n'invente jamais de valeurs. Si une donnée n'est pas disponible via un tool, dis-le. "
    "Pour DIAGNOSTIQUER un batch (pourquoi un brassage est raté / hors spec, qu'est-ce qui a dévié), le "
    "dossier vient de get_batch_context (déjà appelé pour toi si la question porte sur ce batch — sinon "
    "appelle-le toi-même). Ne réutilise JAMAIS des données de batch mentionnées plus haut dans la "
    "conversation : elles concernent un AUTRE batch. COMMENCE par le champ `conforme` : s'il est vrai (verdict 'ok'), le "
    "batch est CONFORME — dis-le clairement et N'INVENTE PAS de défaut, même si la question suppose un "
    "problème. Si non conforme, le DÉFAUT est donné par `defaut_type` (c'est LE résultat QC) : énonce-le, "
    "puis EXPLIQUE-le avec `cip_ok` (faux => contamination/sanitation) et `cuves_hors_bande` (cuves en "
    "déviation thermique). Une cuve n'est hors bande QUE si elle figure dans `cuves_hors_bande` (liste vide "
    "= aucune déviation thermique, n'accuse alors AUCUNE cuve) ; ne déduis jamais une déviation toi-même en "
    "comparant des nombres. "
    "Pour toute question commençant par 'comment', 'que faire', 'quoi faire', 'comment réagir', 'comment débloquer', "
    "'quelle procédure', ou demandant une recommandation / un plan d'action : appelle search_knowledge EN PREMIER "
    "avec la description du problème. Ne commence PAS par investiguer les tags ou les alarmes — la connaissance "
    "procédurale est dans search_knowledge. Tu peux ensuite compléter avec les données en temps réel si nécessaire. "
    "Pour investiguer l'état d'une machine ou diagnostiquer un problème opérationnel, enchaîne librement "
    "les tools : list_alarms (alarmes actives/non acquittées), get_history (tendance d'un tag), "
    "describe_schema + query_readonly (SQL libre en lecture seule). "
    "Pour AGIR (démarrer/arrêter normalement une ligne, ajuster une consigne de température, acquitter une "
    "alarme), utilise request_operation / adjust_setpoint / ack_alarm UNIQUEMENT si l'opérateur demande "
    "explicitement d'effectuer une action — jamais pour répondre à une question sur la procédure à suivre. "
    "Ces actions sont des PROPOSITIONS soumises à confirmation humaine. "
    "Ne DEVINE JAMAIS un tag, une valeur limite ou une séquence PLC. Pour piloter une ligne, utilise seulement "
    "request_operation avec l'identifiant d'opération métier et le préfixe de ligne. Pour ajuster une consigne, "
    "utilise adjust_setpoint avec la cuve (empateur/ebullition/fermenteur) et la nouvelle valeur — propose un "
    "ajustement raisonnable proche de la valeur actuelle, jamais un changement de recette : la gateway refuse "
    "un écart trop important. Pour une demande d'arrêt ou de démarrage, appelle search_knowledge AVANT de "
    "proposer l'action (ex. 'arrêter la ligne blonde') : les SOP expliquent les précautions ; la gateway "
    "vérifiera elle-même les préconditions, dont un batch en cours. "
    "Si le dossier d'une ligne bloquée est déjà présent dans les messages, commence par ses FAITS : "
    "une machine en `attente` n'est pas une panne et ne doit pas être redémarrée. Une alarme ou une machine "
    "arrêtée justifie une procédure terrain, mais ne dis jamais à l'opérateur de contourner un interlock ou une "
    "sécurité. Indique les vérifications physiques de la SOP, puis ne propose une opération qu'à sa demande explicite. "
    "Si l'opérateur demande PLUSIEURS actions similaires en une phrase (ex. 'acquitte ces deux alarmes'), "
    "propose TOUS les appels d'outils d'écriture nécessaires en UNE SEULE réponse (plusieurs tool calls), "
    "pas un seul à la fois — chacun sera confirmé séparément par l'opérateur."
)


class AgentState(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]
    recipes: list[str]
    factory_context: str
    steps: Annotated[int, operator.add]
    pending_action: dict | None


def _llm():
    # num_ctx/temperature alignés sur gateway/src/assistant.ts : num_ctx=8192 car
    # l'API /v1 (OpenAI-compat) ignore num_ctx et retombe à ~2048 (troncatures
    # déjà rencontrées côté gateway) ; temperature=0.2 car une valeur plus haute
    # rend l'appel d'outil moins fiable (observé en local sur ce projet).
    return ChatOllama(model=AI_SERVICE_MODEL, base_url=OLLAMA_URL, num_ctx=8192, temperature=0.2)


async def _summarize_write(tool: str, args: dict) -> str:
    """Résumé humain d'une action d'écriture proposée — portage de
    assistant.ts::summarize."""
    if tool == "request_operation":
        labels = {"start_line": "démarrer normalement", "stop_line": "arrêter normalement"}
        operation = str(args.get("operation_id", ""))
        line = str(args.get("line", ""))
        return f"{labels.get(operation, operation or 'opération inconnue')} la ligne « {line} »"
    if tool == "adjust_setpoint":
        line = str(args.get("line", ""))
        vessel = str(args.get("vessel", ""))
        value = args.get("value")
        return f"ajuster la consigne « {vessel} » de la ligne « {line} » à {value}°C"
    if tool == "ack_alarm":
        alarm_id = str(args.get("alarm_id", ""))
        try:
            resp = await gateway.get("/api/alarms")
            resp.raise_for_status()
            match = next((a for a in resp.json() if str(a.get("id")) == alarm_id), None)
        except Exception:
            match = None
        if match:
            return f"acquitter l'alarme « {match['tag']} »"
        return f"acquitter l'alarme {alarm_id}"
    return f"{tool}({args})"


async def _init_node(state: AgentState) -> dict:
    """Étape inconditionnelle en tête de graphe : calcule factory_context/
    recipes ici (pas fourni par l'appelant — le protocole LangGraph standard
    parlé par assistant-ui ne connaît pas ces champs custom, contrairement à
    l'ancien /chat fait main qui les injectait dans l'état initial)."""
    factory_context, recipes = await build_factory_context()
    return {"factory_context": factory_context, "recipes": recipes}


def _route_entry(state: AgentState) -> str:
    last_user = next((m for m in reversed(state["messages"]) if m.type == "human"), None)
    text = last_user.content if last_user else ""
    recipes = state.get("recipes", [])
    if detect_batch_diagnostic(text, recipes):
        return "forced_batch"
    return "forced_line_blocked" if detect_line_blocked(text, recipes) else "agent"


async def _forced_batch_node(state: AgentState) -> dict:
    last_user = next((m for m in reversed(state["messages"]) if m.type == "human"), None)
    text = last_user.content if last_user else ""
    batch_ref = detect_batch_diagnostic(text, state.get("recipes", []))

    new_messages: list[AnyMessage] = []

    call_id = "forced_batch_context"
    result = await get_batch_context.ainvoke({"batch_ref": batch_ref})
    new_messages.append(AIMessage(content="", tool_calls=[
        {"name": "get_batch_context", "args": {"batch_ref": batch_ref}, "id": call_id},
    ]))
    new_messages.append(ToolMessage(content=result, tool_call_id=call_id, name="get_batch_context"))

    ctx = json.loads(result)
    query = build_knowledge_query(ctx)
    if query:
        call_id2 = "forced_search_knowledge"
        result2 = await search_knowledge.ainvoke({"query": query})
        new_messages.append(AIMessage(content="", tool_calls=[
            {"name": "search_knowledge", "args": {"query": query}, "id": call_id2},
        ]))
        new_messages.append(ToolMessage(content=result2, tool_call_id=call_id2, name="search_knowledge"))

    return {"messages": new_messages, "steps": len(new_messages) // 2}


async def _forced_line_blocked_node(state: AgentState) -> dict:
    """Playbook « ligne bloquée » : les faits et la SOP sont toujours récupérés
    avant la réponse. Le modèle conserve le rôle d'explication, pas d'enquêteur
    qui choisirait arbitrairement quels tags consulter."""
    last_user = next((m for m in reversed(state["messages"]) if m.type == "human"), None)
    text = last_user.content if last_user else ""
    line = detect_line_blocked(text, state.get("recipes", []))
    if not line:
        return {}

    status_id = "forced_line_status"
    status = await get_line_status.ainvoke({"line": line})
    knowledge_id = "forced_line_procedure"
    knowledge = await search_knowledge.ainvoke({"query": f"ligne bloquée {line} panne attente embouteilleuse"})
    return {
        "messages": [
            AIMessage(content="", tool_calls=[{"name": "get_line_status", "args": {"line": line}, "id": status_id}]),
            ToolMessage(content=status, tool_call_id=status_id, name="get_line_status"),
            AIMessage(content="", tool_calls=[{"name": "search_knowledge", "args": {"query": f"ligne bloquée {line} panne attente embouteilleuse"}, "id": knowledge_id}]),
            ToolMessage(content=knowledge, tool_call_id=knowledge_id, name="search_knowledge"),
        ],
        "steps": 2,
    }


async def _agent_node(state: AgentState) -> dict:
    llm = _llm().bind_tools(ALL_TOOLS)
    factory_context = state.get("factory_context", "")
    system_prompt = f"{SYSTEM_PROMPT_STATIC}\n\n{factory_context}" if factory_context else SYSTEM_PROMPT_STATIC
    response = await llm.ainvoke([SystemMessage(content=system_prompt), *state["messages"]])
    return {"messages": [response], "steps": 1}


def _route_after_agent(state: AgentState) -> str:
    if state["steps"] >= MAX_STEPS:
        return "max_steps"
    last = state["messages"][-1]
    tool_calls = getattr(last, "tool_calls", None) or []
    if not tool_calls:
        return "end"
    if any(tc["name"] in WRITE_TOOLS for tc in tool_calls):
        return "write_intercept"
    return "tools"


def _parse_write_decision(decision) -> tuple[bool, bool | None, str | None]:
    """Tolérant au format : une string JSON ({"confirmed":bool,"ok":bool,"error":str}
    — le type `resume` du SDK assistant-ui est une simple string, pas le vrai
    protocole LangGraph qui accepte n'importe quelle valeur, donc le front encode
    en JSON, cf. web/src/AssistantView.tsx::InterruptCard), un dict direct (scripts/
    tests), ou une string brute "yes"/"no" (tests directs, aucun retour d'exécution)."""
    if isinstance(decision, str):
        try:
            decision = json.loads(decision)
        except (json.JSONDecodeError, TypeError):
            pass
    if isinstance(decision, dict):
        return bool(decision.get("confirmed")), decision.get("ok"), decision.get("error")
    return str(decision).lower() in ("true", "confirmed", "yes"), None, None


async def _write_intercept_node(state: AgentState) -> dict:
    last = state["messages"][-1]
    write_calls = [tc for tc in last.tool_calls if tc["name"] in WRITE_TOOLS]

    tool_messages: list[ToolMessage] = []
    for call in write_calls:
        summary = await _summarize_write(call["name"], call["args"])
        pending_action = {"tool": call["name"], "args": call["args"], "summary": summary}

        # Suspend le graphe ici, un interrupt() par action d'écriture proposée
        # dans ce tour — le serveur LangGraph expose l'état courant comme un
        # interrupt standard ; assistant-ui (web/) le reprend via
        # useLangGraphSendCommand -> sendCommand({ resume: {...} }), une
        # confirmation à la fois (chaque resume avance à l'interrupt suivant).
        decision = interrupt(pending_action)
        confirmed, executed_ok, error_msg = _parse_write_decision(decision)

        if not confirmed:
            answer = "Action annulée."
        elif executed_ok is True:
            # Exécuté réellement côté navigateur (vraie session, vraie RBAC) —
            # ai-service n'exécute jamais rien lui-même, cf. docstring du module.
            answer = f"D'accord — {summary}, c'est fait."
        elif executed_ok is False:
            answer = f"Échec : {summary} n'a pas pu être exécuté ({error_msg or 'raison inconnue'})."
        else:
            # decision brute (string/bool, pas de retour d'exécution) : cas des
            # tests directs uniquement, l'UI réelle envoie toujours ok/error.
            answer = f"D'accord — {summary} (confirmé)."
        status = "error" if executed_ok is False else "success"
        tool_messages.append(ToolMessage(content=answer, tool_call_id=call["id"], name=call["name"], status=status))

    return {"messages": tool_messages, "pending_action": None}


def _max_steps_node(state: AgentState) -> dict:
    return {"messages": [AIMessage(content="(j'ai atteint la limite d'étapes ; reformulez peut-être la question)")]}


def build_graph(checkpointer=None):
    g = StateGraph(AgentState)
    g.add_node("init", _init_node)
    g.add_node("forced_batch", _forced_batch_node)
    g.add_node("forced_line_blocked", _forced_line_blocked_node)
    g.add_node("agent", _agent_node)
    g.add_node("tools", ToolNode(READ_TOOLS))
    g.add_node("write_intercept", _write_intercept_node)
    g.add_node("max_steps", _max_steps_node)

    g.set_entry_point("init")
    g.add_conditional_edges("init", _route_entry, {
        "forced_batch": "forced_batch", "forced_line_blocked": "forced_line_blocked", "agent": "agent",
    })
    g.add_edge("forced_batch", "agent")
    g.add_edge("forced_line_blocked", "agent")
    g.add_conditional_edges("agent", _route_after_agent, {
        "tools": "tools", "write_intercept": "write_intercept", "max_steps": "max_steps", "end": END,
    })
    g.add_edge("tools", "agent")
    # Boucle vers agent (pas END) : symétrique à "tools" -> "agent" pour les
    # outils de lecture — le modèle voit les résultats des actions d'écriture
    # (ToolMessage par appel) et peut conclure ou enchaîner d'autres actions.
    # MAX_STEPS/_route_after_agent bornent déjà les boucles, rien à ajouter.
    g.add_edge("write_intercept", "agent")
    g.add_edge("max_steps", END)
    return g.compile(checkpointer=checkpointer)


# Instance module-level pour LangGraph Studio (langgraph.json pointe dessus) —
# SANS checkpointer explicite : `langgraph dev` gère lui-même la persistance
# (--in-mem) et refuse un checkpointer custom à la compilation. FastAPI, lui,
# compile avec son propre InMemorySaver (cf. main.py) — même code, deux usages.
graph = build_graph()

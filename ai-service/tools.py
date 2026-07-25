"""Tools de l'agent — chacun appelle la gateway en HTTP (jamais Postgres/Kafka
directement, cf. gateway.py). Portage 1:1 de gateway/src/assistant.ts::TOOLS —
mêmes noms, mêmes descriptions (y compris par paramètre, qui guident le modèle
sur le format attendu, ex. "brasserie.blonde" et pas juste "blonde"), même
comportement, pour rester interchangeable avec l'agent fait main tant que les
deux coexistent.

request_operation/adjust_setpoint/ack_alarm (écriture) sont déclarés ici pour
leur schéma (le modèle doit savoir qu'ils existent), mais ne sont JAMAIS
exécutés par un ToolNode — graph.py les intercepte avant dispatch et renvoie
une proposition à confirmer. Ne pas les appeler depuis ce module changerait
cette garantie de sécurité.
"""
import json
from typing import Annotated, Literal
from urllib.parse import quote

from langchain_core.tools import tool
from pydantic import Field

import gateway

# Tools d'écriture : jamais exécutés automatiquement (cf. graph.py). Même
# invariant que WRITE_TOOLS dans assistant.ts.
WRITE_TOOLS = {"request_operation", "adjust_setpoint", "ack_alarm"}

# Les 3 seules cuves qui existent réellement dans le simulateur (brain.py,
# Recipe.vessels) — enum fermé pour qu'un modèle ne puisse jamais inventer un
# nom de machine, même invariant que operation_id sur request_operation.
VESSELS = Literal["empateur", "ebullition", "fermenteur"]

_MAX_ROWS = 30


def _trim(rows: list[dict], keep: tuple[str, ...], max_rows: int = _MAX_ROWS) -> list[dict]:
    return [{k: r.get(k) for k in keep} for r in rows[:max_rows]]


@tool
async def get_oee(
    days: Annotated[int, Field(description="fenêtre en jours (défaut 7)")] = 7,
    line: Annotated[str | None, Field(description="préfixe de ligne, ex 'brasserie.blonde' (optionnel)")] = None,
) -> str:
    """OEE (Disponibilité x Performance x Qualité) par ligne et shift sur N jours.
    Renvoie aussi produced/ok, l'objectif de pièces et la projection."""
    resp = await gateway.get("/api/oee", {"days": days})
    resp.raise_for_status()
    rows = resp.json()
    if line:
        rows = [r for r in rows if r.get("line") == line]
    keep = (
        "line", "day", "shift_no", "produced", "ok", "oee", "availability",
        "performance", "quality", "target_pieces", "projected_pieces",
    )
    return json.dumps(_trim(rows, keep))


@tool
async def get_production(days: Annotated[int, Field(description="fenêtre en jours (défaut 7)")] = 7) -> str:
    """Production par shift sur N jours : bonnes pièces (ok), rebut (scrap), total (produced)."""
    resp = await gateway.get("/api/production", {"days": days})
    resp.raise_for_status()
    rows = resp.json()
    keep = ("day", "shift_no", "shift_label", "ok", "scrap", "produced")
    return json.dumps(_trim(rows, keep, max_rows=40))


@tool
async def list_alarms() -> str:
    """Alarmes actives OU retombées mais non encore acquittées (tag, sévérité,
    message, état, depuis quand)."""
    resp = await gateway.get("/api/alarms")
    resp.raise_for_status()
    rows = resp.json()
    keep = ("id", "tag", "severity", "message", "state", "acked", "raised_at", "cleared_at")
    # Plafonné plus bas que les autres (20, pas 50) : une alarme mal acquittée
    # côté démo peut en accumuler des centaines, ce qui a fait déborder le
    # contexte du modèle en pratique (réponse vide observée avec 601 alarmes).
    return json.dumps(_trim(rows, keep, max_rows=20))


@tool
async def get_history(
    tag: Annotated[str, Field(description="nom métier du tag, ex 'brasserie.ipa.fermenteur.temperature'")],
    minutes: Annotated[int, Field(description="fenêtre en minutes (défaut 60)")] = 60,
) -> str:
    """Tendance d'un tag sur N minutes : valeur ACTUELLE + points sous-échantillonnés
    (pour décrire l'évolution). Pas de moyenne globale (souvent trompeuse sur un signal physique)."""
    resp = await gateway.get("/api/history", {"tag": tag, "minutes": minutes})
    if resp.status_code == 400:
        return json.dumps({"error": resp.json().get("error", "requête invalide")})
    resp.raise_for_status()
    rows = resp.json()
    # Sous-échantillonne à ~20 points (le point compte, pas la densité brute).
    step = max(1, len(rows) // 20)
    points = [{"t": r["ts"], "v": r["value"]} for r in rows[::step]]
    current = points[-1]["v"] if points else None
    return json.dumps({"tag": tag, "minutes": minutes, "current": current, "points": points})


@tool
async def get_batch_context(
    batch_ref: Annotated[str, Field(description="id de batch, ou recette (= dernier batch de cette recette)")],
) -> str:
    """Dossier d'un batch (brassage) pour enquêter sur sa qualité : verdict QC,
    déviations de chaque cuve VS sa bande nominale, alarmes survenues, changements
    de consigne, sanitation (CIP). Réf = un id de batch (ex 'ipa-1781...') ou une
    recette ('ipa', 'blonde', 'jalapeno', ou 'dernier ipa')."""
    resp = await gateway.get(f"/api/batches/{quote(batch_ref, safe='')}/context")
    if resp.status_code in (400, 403, 404):
        return json.dumps(resp.json())
    resp.raise_for_status()
    return json.dumps(resp.json())


@tool
async def describe_schema() -> str:
    """Liste les tables/vues de données interrogeables et leurs colonnes. À
    appeler AVANT query_readonly pour savoir quoi interroger, quand les autres
    tools ne suffisent pas."""
    resp = await gateway.get("/api/schema")
    resp.raise_for_status()
    return json.dumps(resp.json())


@tool
async def query_readonly(
    sql: Annotated[str, Field(description="une seule requête SELECT (sans point-virgule)")],
) -> str:
    """Exécute UNE requête SQL PostgreSQL en LECTURE SEULE (SELECT uniquement)
    sur les données Strata, pour une question non couverte par les autres tools.
    Utilise d'abord describe_schema pour connaître les tables/colonnes. Résultat
    plafonné à 500 lignes."""
    resp = await gateway.post("/api/query-readonly", {"sql": sql})
    if resp.status_code == 400:
        return json.dumps(resp.json())
    resp.raise_for_status()
    return json.dumps(resp.json())


@tool
async def search_knowledge(
    query: Annotated[str, Field(description="description du problème ou question en langage naturel")],
) -> str:
    """Recherche dans la base de connaissances (SOPs, procédures, causes de
    défauts, historique d'incidents) par similarité sémantique. À utiliser quand
    l'opérateur cherche comment résoudre un problème, débloquer une machine,
    comprendre une cause racine."""
    resp = await gateway.post("/api/knowledge/search", {"query": query})
    if resp.status_code == 400:
        return json.dumps(resp.json())
    resp.raise_for_status()
    return json.dumps(resp.json())


@tool
async def get_line_status(
    line: Annotated[
        str | None,
        Field(description="préfixe de ligne ex 'brasserie.blonde' (optionnel, toutes les lignes si absent)"),
    ] = None,
) -> str:
    """État temps réel d'une ou toutes les lignes : état de chaque machine
    (arrêt/marche/attente), température, alarmes actives, batch en cours. À
    utiliser pour savoir ce qui tourne, ce qui est bloqué, ce qui est en panne."""
    resp = await gateway.get("/api/lines/status", {"line": line} if line else None)
    resp.raise_for_status()
    return json.dumps(resp.json())


@tool
async def get_shift_summary() -> str:
    """Résumé complet du shift en cours : OEE et production par ligne, batches
    actifs, nombre d'alarmes non acquittées. Vue d'ensemble pour savoir comment
    se passe la journée."""
    oee_resp = await gateway.get("/api/oee", {"days": 1})
    batches_resp = await gateway.get("/api/batches", {"limit": 50})
    alarms_resp = await gateway.get("/api/alarms")
    for r in (oee_resp, batches_resp, alarms_resp):
        r.raise_for_status()
    oee_rows = [r for r in oee_resp.json() if r.get("is_current")]
    active_batches = [b for b in batches_resp.json() if b.get("ended_at") is None]
    unacked = len(alarms_resp.json())
    return json.dumps({
        "shift": oee_rows[0]["shift_label"] if oee_rows else "inconnu",
        "lignes": [
            {
                "line": r["line"], "label": r.get("line_label"),
                "oee": r.get("oee"), "disponibilite": r.get("availability"),
                "performance": r.get("performance"), "qualite": r.get("quality"),
                "ok": r.get("ok"), "produit": r.get("produced"),
                "objectif_pieces": r.get("target_pieces"), "objectif_oee": r.get("target_oee"),
            }
            for r in oee_rows
        ],
        "batches_en_cours": [{"id": b["id"], "recipe": b["recipe"], "line": b["line"]} for b in active_batches],
        "alarmes_non_acquittees": unacked,
    })


@tool
async def get_oee_breakdown(
    days: Annotated[int, Field(description="fenêtre en jours (défaut 1 = aujourd'hui)")] = 1,
    line: Annotated[str | None, Field(description="préfixe de ligne (optionnel)")] = None,
) -> str:
    """OEE décomposé en Disponibilité, Performance et Qualité par ligne, avec les
    principales causes de perte. Utile pour diagnostiquer pourquoi l'OEE est bas."""
    oee_resp = await gateway.get("/api/oee", {"days": days})
    downtime_resp = await gateway.get("/api/oee/downtime", {"days": days})
    oee_resp.raise_for_status()
    downtime_resp.raise_for_status()
    oee_rows = oee_resp.json()
    downtime_rows = downtime_resp.json()
    if line:
        oee_rows = [r for r in oee_rows if r.get("line") == line]
        downtime_rows = [r for r in downtime_rows if r.get("line") == line]

    by_line: dict[str, dict] = {}
    for r in oee_rows:
        by_line.setdefault(r["line"], {"shifts": [], "pertes": {}})["shifts"].append(r)
    for r in downtime_rows:
        agg = by_line.setdefault(r["line"], {"shifts": [], "pertes": {}})["pertes"]
        key = (r.get("reason_code"), r.get("reason_label"), r.get("kind"))
        agg[key] = agg.get(key, 0) + (r.get("minutes") or 0)

    summary = []
    for ln, d in by_line.items():
        last = d["shifts"][0] if d["shifts"] else {}
        pertes = sorted(
            ({"raison": k[1] or k[0], "type": k[2], "minutes": v} for k, v in d["pertes"].items()),
            key=lambda p: p["minutes"], reverse=True,
        )[:5]
        summary.append({
            "line": ln, "label": last.get("line_label"),
            "oee": last.get("oee"), "disponibilite": last.get("availability"),
            "performance": last.get("performance"), "qualite": last.get("quality"),
            "objectif_oee": last.get("target_oee"),
            "principales_pertes": pertes,
        })
    return json.dumps(summary)


@tool
async def get_active_batches() -> str:
    """Liste tous les batches actuellement en cours (non terminés) avec leur
    recette, ligne, durée écoulée et phase estimée."""
    resp = await gateway.get("/api/batches", {"limit": 50})
    resp.raise_for_status()
    rows = [b for b in resp.json() if b.get("ended_at") is None]
    if not rows:
        return json.dumps({"message": "Aucun batch en cours."})
    return json.dumps([
        {
            "id": b["id"], "recipe": b["recipe"], "line": b["line"],
            "defaut_type": b.get("defaut_type"),
            "conforme": b.get("qc_verdict") == "ok" if b.get("qc_verdict") else None,
        }
        for b in rows
    ])


@tool
async def request_operation(
    operation_id: Annotated[
        Literal["start_line", "stop_line"],
        Field(description="opération métier exacte : 'start_line' ou 'stop_line'"),
    ],
    line: Annotated[
        str,
        Field(description="préfixe de ligne réel, ex 'brasserie.blonde'"),
    ],
) -> str:
    """PROPOSE une opération métier cataloguée sur une ligne. Opérations disponibles :
    start_line (démarrage normal) et stop_line (arrêt normal). Ne propose jamais
    de tag, valeur, séquence PLC ou arrêt d'urgence : la gateway résout et valide
    l'opération après confirmation humaine."""
    # Jamais exécuté ici : graph.py intercepte request_operation avant tout dispatch.
    return json.dumps({"error": "request_operation ne doit jamais être exécuté directement"})


@tool
async def adjust_setpoint(
    line: Annotated[str, Field(description="préfixe de ligne réel, ex 'brasserie.blonde'")],
    vessel: Annotated[VESSELS, Field(description="cuve concernée : empateur, ebullition ou fermenteur")],
    value: Annotated[float, Field(description="nouvelle température cible, en °C")],
) -> str:
    """PROPOSE d'ajuster la consigne de température (temp_cible) d'une cuve.
    UN AJUSTEMENT, pas un changement de recette : la gateway refuse tout écart
    trop important par rapport à la consigne actuelle. Ne propose jamais de tag
    brut ni ne calcule toi-même un écart limite — la gateway le fait après
    confirmation humaine."""
    # Jamais exécuté ici : graph.py intercepte adjust_setpoint avant tout dispatch.
    return json.dumps({"error": "adjust_setpoint ne doit jamais être exécuté directement"})


@tool
async def ack_alarm(alarm_id: str) -> str:
    """PROPOSE d'acquitter une alarme (par son id). ACTION soumise à CONFIRMATION humaine."""
    # Jamais exécuté ici : graph.py intercepte ack_alarm avant tout dispatch.
    return json.dumps({"error": "ack_alarm ne doit jamais être exécuté directement"})


ALL_TOOLS = [
    get_oee, get_production, list_alarms, get_history, get_batch_context,
    describe_schema, query_readonly, search_knowledge, get_line_status,
    get_shift_summary, get_oee_breakdown, get_active_batches,
    request_operation, adjust_setpoint, ack_alarm,
]

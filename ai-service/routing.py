"""Détection du routage forcé pour un diagnostic de batch — portage de
gateway/src/assistant.ts::detectBatchDiagnostic/buildKnowledgeQuery. Même
principe : on ne laisse pas le modèle décider seul de récupérer le dossier
batch ni les preuves corrélées — le graphe garantit la séquence."""
import re

BATCH_DIAG_VERBS = re.compile(r"\b(pourquoi|diagnosti\w*|analyse\w*|explique\w*|cause)\b", re.I)
BATCH_WORDS = re.compile(r"\b(batch|brassage|lot)\b", re.I)
BATCH_ID_RE = re.compile(r"\b[a-z]+-[0-9a-f-]{6,}\b", re.I)
# Une recette ("ipa", "blonde"...) est AUSSI un nom de ligne (`brasserie.blonde`) :
# la mention seule ne suffit pas à distinguer un diagnostic de batch d'un état
# machine — on exige donc en plus un mot-clé de verdict qualité.
QC_WORDS = re.compile(r"\b(hors spec|conforme|contamin\w*|d[ée]faut|rebut|qualit[ée]|rat[ée]\w*|nok)\b", re.I)


def detect_batch_diagnostic(text: str, recipes: list[str]) -> str | None:
    if not BATCH_DIAG_VERBS.search(text):
        return None
    id_match = BATCH_ID_RE.search(text)
    has_recipe = any(r.lower() in text.lower() for r in recipes)
    if not id_match and not BATCH_WORDS.search(text) and not (has_recipe and QC_WORDS.search(text)):
        return None
    return id_match.group(0) if id_match else text


def build_knowledge_query(ctx: dict) -> str | None:
    """Requête search_knowledge à partir du défaut RÉEL du dossier batch (jamais
    d'une déviation supposée) : None si le batch est conforme ou en erreur."""
    if ctx.get("error") or ctx.get("conforme"):
        return None
    batch = ctx.get("batch") or {}
    parts = []
    if batch.get("defaut_type"):
        parts.append(str(batch["defaut_type"]))
    if ctx.get("cip_ok") is False:
        parts.append("contamination sanitation CIP")
    cuves = ctx.get("cuves_hors_bande") or []
    if cuves:
        parts.append(f"déviation thermique {', '.join(cuves)}")
    if not parts:
        return None
    return f"{batch.get('recipe', '')} {' '.join(parts)}".strip()

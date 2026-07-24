"""Contexte usine dynamique injecté dans le system prompt — portage de
gateway/src/assistant.ts::buildFactoryContext. Extrait de la base (via
/api/factory-context) plutôt que codé en dur, pour rester vrai si des lignes/
machines/recettes changent."""
import gateway


async def build_factory_context() -> tuple[str, list[str]]:
    try:
        resp = await gateway.get("/api/factory-context")
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return "", []

    lines_text = "\n".join(
        f"  • {l['line']} ({l['label']}, cadence {l['ideal_rate']} pièces/min) — machines : {', '.join(l['machines'])}"
        for l in data.get("lines", [])
    )
    recipes = data.get("recipes", [])
    recipes_text = ", ".join(recipes)

    text = (
        "CONTEXTE USINE (extrait dynamiquement de la base) :\n"
        "Lignes actives :\n" + lines_text + "\n"
        "Recettes connues : " + recipes_text + "\n"
        "Convention tags : <site>.<ligne>.<machine>.<mesure>\n"
        "États machines : <machine>.state → 0=arrêt, 1=marche ; <machine>.en_attente → 1=bloqué amont\n"
        "Pour connaître les tags exacts d'une machine, utilise describe_schema ou query_readonly sur la table `tags`."
    )
    return text, recipes

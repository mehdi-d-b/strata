"""Génère knowledge-pdfs/manuel-exploitation-brasserie.pdf à partir du contenu
ci-dessous — remplace gateway/src/seed-knowledge.ts (supprimé) : plus aucune
connaissance métier écrite directement dans le code de l'app, tout passe par
le pipeline d'ingestion PDF générique (ingest.py), comme n'importe quel manuel
réel écrit par un automaticien.

Usage : uv run --group dev python generate_manual_pdf.py
Puis : uv run python ingest.py (relit knowledge-pdfs/*.pdf, y compris celui-ci).

fpdf2 est un outil de génération de contenu, jamais utilisé par le service en
marche (cf. pyproject.toml, [dependency-groups] dev) — ne pas confondre avec
docling (ai-service/ingest.py), qui LIT les PDF et est une dépendance runtime.

Aucun marqueur de structure à insérer ici : ingest.py utilise Docling, qui
comprend la mise en page (titres, paragraphes) directement — contrairement à
l'extraction pypdf brute utilisée avant, qui n'avait aucune notion de
paragraphe et nécessitait un pied-de-mouche invisible en pis-aller.
"""
import pathlib

from fpdf import FPDF

# Portage 1:1 du contenu de l'ancien gateway/src/seed-knowledge.ts, organisé en
# sections (au lieu d'un tableau plat catégorisé) — un vrai manuel, pas un
# export de base de données.
SECTIONS: list[tuple[str, list[tuple[str, str]]]] = [
    ("Procédures d'exploitation", [
        (
            "Débloquer une embouteilleuse en attente",
            "Si l'embouteilleuse est en état 'en_attente' (tag .en_attente = 1), cela signifie que le "
            "fermenteur en amont n'a pas encore libéré le moût.\n"
            "Vérifier : (1) l'état du fermenteur de la même ligne (tag fermenteur.state) ; (2) la "
            "température du fermenteur — si hors bande nominale, le process attend la stabilisation ; "
            "(3) les alarmes actives sur la ligne.\n"
            "Action corrective : si la température est stable et correcte, vérifier manuellement la vanne "
            "de transfert. Si une alarme CIP est active, effectuer le cycle de nettoyage avant de relancer.",
        ),
        (
            "Procédure CIP (nettoyage en place)",
            "Le CIP (Clean In Place) doit être effectué entre chaque batch et après tout incident de "
            "contamination.\n"
            "Séquence standard : rinçage eau froide (5 min) → soude caustique 2% à 75°C (20 min) → "
            "rinçage eau chaude (5 min) → acide nitrique 1% à 60°C (10 min) → rinçage eau stérile (5 min).\n"
            "Le tag cip_ok passe à 1 (true) uniquement si la séquence complète s'est déroulée sans "
            "interruption. Un cip_ok=false sur un batch indique que le CIP a été sauté ou interrompu — "
            "cause principale de contamination.",
        ),
        (
            "Réagir à une alarme de fermentation hors température",
            "Si une alarme 'fermentation trop chaude' ou 'fermentation trop froide' se déclenche :\n"
            "1. Vérifier le tag fermenteur.temperature en temps réel (get_history).\n"
            "2. Comparer à la bande nominale de la recette : blonde [10-14°C], ipa [18-22°C], "
            "jalapeño [17-21°C].\n"
            "3. Si déviation > 5°C depuis plus de 30 min : risquer un défaut fermentation_hors_spec sur "
            "le batch en cours.\n"
            "4. Action : ajuster la consigne de température du fermenteur (opération assistant "
            "adjust_setpoint, cuve fermenteur — un ajustement proche de la valeur actuelle, pas un "
            "changement de recette). Si le régulateur ne répond pas, vérifier le groupe froid de la cuve.\n"
            "5. Si le batch a déjà été impacté, créer un rapport de non-conformité.",
        ),
        (
            "Réagir à une alarme de rendement faible",
            "Le défaut rendement_faible indique que la quantité de bière produite est inférieure à "
            "l'attendu pour la recette.\n"
            "Causes possibles : (1) déviation thermique à l'empâtage — vérifier empateur.temperature vs "
            "bande nominale ; (2) durée d'ébullition insuffisante ; (3) pertes par fuite sur la ligne de "
            "transfert.\n"
            "Diagnostic : appeler get_batch_context pour le batch concerné. Si cuves_hors_bande contient "
            "l'empateur, la cause est thermique. Vérifier également les logs d'alarme sur la période du "
            "batch.",
        ),
        (
            "Interpréter un arrêt machine (state=0)",
            "Un tag <machine>.state = 0 indique que la machine est à l'arrêt.\n"
            "Distinguer : (1) arrêt planifié (pas de batch en cours, normal) ; (2) arrêt en attente amont "
            "(tag .en_attente=1, normal — attendre la cuve précédente) ; (3) arrêt sur défaut (alarme "
            "active sur la machine, anormal).\n"
            "Pour diagnostiquer : vérifier list_alarms pour des alarmes actives sur la ligne. Si aucune "
            "alarme et pas de batch actif, l'arrêt est intentionnel. Si alarme présente, suivre la "
            "procédure de l'alarme correspondante.",
        ),
        (
            "Démarrer une ligne de production depuis l'arrêt",
            "Séquence de démarrage d'une ligne (blonde, ipa ou jalapeño) depuis l'arrêt complet :\n"
            "1. Vérifier qu'aucune alarme active n'est présente sur la ligne (list_alarms).\n"
            "2. Vérifier que le CIP a bien été effectué (cip_ok = true sur le dernier batch, ou confirmer "
            "manuellement).\n"
            "3. Démarrer l'empateur : mettre en chauffe à la consigne de la recette (empateur.temp_"
            "consigne). Attendre que la température soit stable dans la bande nominale.\n"
            "4. Une fois l'empâtage démarré, l'ébulliteur prend le relais automatiquement après transfert.\n"
            "5. Le fermenteur démarre en refroidissement dès réception du moût. Vérifier la température "
            "de consigne (fermenteur.temp_consigne).\n"
            "6. L'embouteilleuse démarre automatiquement quand le fermenteur libère le moût (en_attente "
            "passe à 0).\n"
            "Un batch est automatiquement créé par le système dès que l'empateur est en marche. Pour "
            "déclencher réellement le démarrage, utiliser l'opération assistant request_operation "
            "(start_line) sur la ligne concernée.",
        ),
        (
            "Arrêter proprement une ligne de production",
            "Séquence d'arrêt propre d'une ligne :\n"
            "1. Ne pas interrompre un batch en cours — attendre la fin de l'embouteillage "
            "(embouteilleuse.state = 0 naturellement).\n"
            "2. Une fois le batch terminé, lancer immédiatement le CIP complet (voir procédure CIP).\n"
            "3. Vérifier que tous les tags .state sont à 0 sur la ligne.\n"
            "4. Acquitter les alarmes éventuelles restantes.\n"
            "5. Consigner l'arrêt dans le registre (heure, raison, état du dernier batch).\n"
            "En cas d'arrêt d'urgence en cours de batch : stopper l'empateur et l'ébulliteur en premier, "
            "maintenir la réfrigération du fermenteur. Le batch sera probablement non conforme — "
            "documenter l'incident. Pour un arrêt normal (hors urgence), utiliser l'opération assistant "
            "request_operation (stop_line) — elle refuse automatiquement si un batch est encore en cours.",
        ),
        (
            "Checklist transfert de poste (passation de shift)",
            "À effectuer 15 minutes avant la fin du poste :\n"
            "1. État des lignes : vérifier le state de chaque machine (empateur, ébulliteur, fermenteur, "
            "embouteilleuse) sur les 3 lignes.\n"
            "2. Batches en cours : noter les batch IDs actifs, leur phase (empâtage / fermentation / "
            "embouteillage) et l'heure estimée de fin.\n"
            "3. Alarmes : lister les alarmes actives et non acquittées (list_alarms). Toute alarme non "
            "résolue doit être signalée verbalement au shift entrant.\n"
            "4. OEE du shift : communiquer les chiffres OEE de la période. Signaler toute anomalie "
            "(OEE < 60%, arrêt > 30 min).\n"
            "5. CIP : préciser si un CIP est en cours ou planifié sur quelle ligne.\n"
            "6. Actions en suspens : consignes modifiées, maintenances programmées, non-conformités "
            "ouvertes.",
        ),
    ]),
    ("Défauts et causes racines", [
        (
            "Cause et remédiation : contamination",
            "Le défaut 'contamination' sur un batch signifie que des micro-organismes indésirables ont "
            "été détectés ou que les critères QC de contamination sont hors norme.\n"
            "Cause principale : CIP non effectué ou incomplet (cip_ok = false). Cause secondaire : "
            "température de fermentation trop haute favorisant les bactéries lactiques.\n"
            "Remédiation immédiate : isoler le batch, déclencher un CIP complet sur toutes les cuves de "
            "la ligne. Vérifier les joints et vannes pour tout point de contamination croisée. Ne pas "
            "redémarrer la production avant que cip_ok soit confirmé sur le prochain batch.",
        ),
        (
            "Cause et remédiation : fermentation_hors_spec",
            "Le défaut 'fermentation_hors_spec' indique que la fermentation s'est déroulée hors des "
            "paramètres nominaux.\n"
            "Cause : la cuve fermenteur a été en dehors de sa bande de température pendant plus de 10% "
            "du temps de fermentation (visible dans cuves_hors_bande du batch context).\n"
            "Conséquences : profil aromatique dégradé, possible sous-atténuation ou sur-atténuation, "
            "risque de production de composés indésirables (diacétyle excessif à haute température).\n"
            "Remédiation : vérifier et recalibrer le régulateur de température du fermenteur. Contrôler "
            "le groupe froid. Pour le batch impacté, faire une analyse sensorielle avant décision de mise "
            "en bouteille.",
        ),
        (
            "Cause et remédiation : volume_insuffisant",
            "Le défaut 'volume_insuffisant' signifie que l'embouteilleuse a produit moins de bouteilles "
            "que le seuil minimum pour la recette.\n"
            "Cause principale : panne de l'embouteilleuse pendant le batch (indicateur de panne dans les "
            "tags). Cause secondaire : volume de moût insuffisant en entrée.\n"
            "Diagnostic : vérifier l'historique du tag embouteilleuse.panne sur la période du batch. Si "
            "panne détectée, analyser la durée et l'impact sur le volume total.\n"
            "Remédiation : maintenance préventive sur les buses d'embouteillage. Vérifier la pression "
            "d'alimentation.",
        ),
    ]),
    ("Paramètres de recettes", [
        (
            "Paramètres nominaux : Blonde (lager)",
            "Recette blonde — bière de fermentation basse (lager).\n"
            "Empâtage : 65°C ± 4°C (bande nominale [61-69°C]), durée 60 min.\n"
            "Ébullition : 100°C ± 2°C, durée 60 min.\n"
            "Fermentation : 12°C ± 2°C (bande nominale [10-14°C]), durée 14 jours.\n"
            "Cadence embouteilleuse : 50 bouteilles/min nominal.\n"
            "CIP obligatoire avant chaque batch. Durée totale du process : environ 16 jours.",
        ),
        (
            "Paramètres nominaux : IPA (ale)",
            "Recette IPA — bière de fermentation haute (ale), amère et aromatique.\n"
            "Empâtage : 66°C ± 4°C (bande nominale [62-70°C]), durée 60 min.\n"
            "Ébullition : 100°C ± 2°C, durée 75 min (houblonnage en fin d'ébullition).\n"
            "Fermentation : 20°C ± 2°C (bande nominale [18-22°C]), durée 7 jours.\n"
            "Cadence embouteilleuse : 40 bouteilles/min nominal.\n"
            "Attention : la fermentation IPA est plus sensible aux écarts de température que la blonde — "
            "un écart de +5°C peut produire des esters indésirables.",
        ),
        (
            "Paramètres nominaux : Jalapeño (ale épicée)",
            "Recette jalapeño — ale épicée avec addition de piments jalapeño en fermentation.\n"
            "Empâtage : 64°C ± 4°C (bande nominale [60-68°C]), durée 60 min.\n"
            "Ébullition : 100°C ± 2°C, durée 60 min.\n"
            "Fermentation : 19°C ± 2°C (bande nominale [17-21°C]), durée 7 jours. Addition jalapeño frais "
            "à J+2.\n"
            "Cadence embouteilleuse : 35 bouteilles/min nominal.\n"
            "Note : le contact avec les jalapeños abaisse légèrement le pH — surveiller l'acidité en "
            "cours de fermentation.",
        ),
    ]),
    ("Maintenance préventive", [
        (
            "Maintenance préventive : empateur",
            "Fréquence : hebdomadaire.\n"
            "Checks : vérifier le bon fonctionnement de la résistance chauffante (montée en température "
            "< 20 min pour atteindre 65°C) ; inspecter les agitateurs ; contrôler l'étanchéité des vannes "
            "de soutirage.\n"
            "Signes d'alerte : montée en température lente (> 30 min), température qui n'atteint pas la "
            "consigne, écart > 5°C entre consigne et mesure en régime établi.\n"
            "Action : si la résistance ne chauffe plus correctement, vérifier l'alimentation électrique "
            "et le relais de puissance. Contacter maintenance si le problème persiste.",
        ),
        (
            "Maintenance préventive : fermenteur",
            "Fréquence : après chaque batch (nettoyage) + mensuelle (inspection physique).\n"
            "Checks mensuels : vérifier le groupe froid (pression du circuit, niveau de frigorigène) ; "
            "inspecter les joints de cuve pour tout signe de fuite ou de corrosion ; tester la sonde de "
            "température (comparer à thermomètre étalon — écart max admis : 0,5°C).\n"
            "Signes d'alerte : impossible de maintenir la consigne de température, oscillations "
            "importantes autour de la consigne, alarmes répétées de fermentation hors température.\n"
            "Action sur groupe froid défaillant : contacter le prestataire de maintenance frigorifique. "
            "Ne pas démarrer de nouveau batch sur la ligne tant que le groupe froid n'est pas "
            "opérationnel.",
        ),
        (
            "Maintenance préventive : embouteilleuse",
            "Fréquence : quotidienne (avant démarrage) + hebdomadaire (complète).\n"
            "Checks quotidiens : vérifier la pression d'alimentation en CO2 ; inspecter les buses de "
            "remplissage (obstructions) ; vérifier le système de capsulage.\n"
            "Checks hebdomadaires : lubrification des parties mécaniques ; vérification de l'alignement "
            "des convoyeurs ; test du système d'évacuation des bouteilles mal remplies.\n"
            "Signes d'alerte : cadence en dessous de 80% du nominal sans explication (tag .cadence), "
            "pannes répétées (tag .panne = 1), taux de rebut > 5% (bouteilles_rebut / bouteilles_ok).\n"
            "Le tag embouteilleuse.panne = 1 déclenche automatiquement une alarme. Vérifier en priorité "
            "le bourrage mécanique et les buses bouchées.",
        ),
    ]),
    ("Diagnostic OEE", [
        (
            "Diagnostic OEE bas (< 50%)",
            "Un OEE inférieur à 50% indique un problème significatif sur la ligne. Décomposer en trois "
            "composantes :\n"
            "Disponibilité basse (< 70%) : la machine est souvent à l'arrêt ou en attente. Vérifier "
            "list_alarms et l'historique des pannes. Causes fréquentes : arrêts non planifiés, attentes "
            "amont (en_attente = 1 prolongé), CIP trop fréquents.\n"
            "Performance basse (< 80%) : la machine tourne mais en-dessous de la cadence nominale. "
            "Vérifier le tag .cadence vs ideal_rate. Causes : usure mécanique, pression d'alimentation "
            "insuffisante, matière première non conforme.\n"
            "Qualité basse (< 80%) : trop de rebuts à l'embouteillage. Vérifier le ratio bouteilles_rebut "
            "/ bouteilles_ok. Causes : contamination, défaut de bouchage, produit hors spec.\n"
            "Action recommandée : identifier la composante dominante, puis investiguer avec get_history "
            "sur les tags correspondants sur la période concernée.",
        ),
    ]),
    ("Alarmes", [
        (
            "Alarme : fermentation trop chaude",
            "Déclenchement : température du fermenteur dépasse la limite haute de la bande nominale "
            "(blonde > 14°C, ipa > 22°C, jalapeño > 21°C) pendant plus de 5 minutes.\n"
            "Risques : production d'esters et de fusel alcohols, sur-atténuation, profil aromatique "
            "dégradé. Pour l'IPA, risque de production de diacétyle excessif.\n"
            "Actions immédiates : (1) vérifier la consigne de température (fermenteur.temp_consigne) — "
            "a-t-elle été modifiée ? ; (2) vérifier le groupe froid (indicateur de fonctionnement) ; "
            "(3) si écart > 3°C depuis > 30 min, le batch est à risque — documenter.\n"
            "Acquittement : acquitter l'alarme APRÈS avoir identifié et résolu la cause. Ne pas acquitter "
            "sans action corrective.",
        ),
        (
            "Alarme : fermentation trop froide",
            "Déclenchement : température du fermenteur passe sous la limite basse de la bande nominale "
            "(blonde < 10°C, ipa < 18°C, jalapeño < 17°C) pendant plus de 5 minutes.\n"
            "Risques : fermentation qui s'arrête (levures en dormance), sous-atténuation, batch non "
            "conforme.\n"
            "Actions immédiates : (1) vérifier la consigne de température — valeur correcte ? ; "
            "(2) vérifier que le groupe froid n'est pas en sur-refroidissement (problème de régulation) ; "
            "(3) augmenter la consigne si nécessaire (opération assistant adjust_setpoint, cuve "
            "fermenteur — un ajustement, pas un changement de recette).\n"
            "Pour la blonde (lager) : une chute à 8°C peut être tolérée brièvement en fin de fermentation "
            "(garde froide), mais pas en début. Pour l'ipa et jalapeño : toute chute sous 15°C en début "
            "de fermentation est critique.",
        ),
        (
            "Alarme : panne embouteilleuse",
            "Déclenchement : tag embouteilleuse.panne = 1 (détection d'un blocage mécanique ou d'une "
            "anomalie de remplissage).\n"
            "Actions immédiates : (1) arrêter l'alimentation en amont (vanne de transfert fermenteur → "
            "embouteilleuse) ; (2) dégager le bourrage mécanique si présent (vérifier le convoyeur et les "
            "buses) ; (3) vérifier la pression CO2 (min 3 bar) ; (4) relancer en mode test (vitesse "
            "réduite) avant de reprendre la cadence nominale.\n"
            "Si la panne dure > 20 min : le moût en attente peut se dégrader. Évaluer si un retour en "
            "cuve tampon est possible.\n"
            "Acquitter l'alarme uniquement après redémarrage réussi.",
        ),
    ]),
    ("Gestion des non-conformités", [
        (
            "Gestion d'un batch non conforme",
            "Quand un batch est marqué non conforme (defaut_type non nul dans la table batches) :\n"
            "1. ISOLER : bloquer physiquement les bouteilles produites (ne pas expédier). Étiqueter le "
            "lot \"EN QUARANTAINE\".\n"
            "2. DOCUMENTER : noter le batch ID, le defaut_type, les cuves concernées "
            "(cuves_hors_bande), le cip_ok.\n"
            "3. ÉVALUER selon le type de défaut :\n"
            "   - contamination : destruction obligatoire du lot. CIP complet avant tout nouveau batch. "
            "Analyse microbiologique recommandée.\n"
            "   - fermentation_hors_spec : analyse sensorielle et chimique (taux d'alcool, pH, amertume). "
            "Selon résultat : déclassement (vente moindre qualité), retraitement si possible, ou "
            "destruction.\n"
            "   - rendement_faible / volume_insuffisant : le produit peut être conforme en qualité mais "
            "en quantité insuffisante. Analyser et décider au cas par cas.\n"
            "4. TRACER : enregistrer la décision dans le système (id batch, décision, responsable, date).\n"
            "5. CORRIGER : identifier la cause racine et mettre en place une action corrective pour "
            "éviter la récurrence.",
        ),
    ]),
]

OUT_PATH = pathlib.Path(__file__).parent / "knowledge-pdfs" / "manuel-exploitation-brasserie.pdf"


def _ascii_safe(text: str) -> str:
    """Les polices core (Helvetica) de fpdf2 sont limitées au Latin-1 : le
    em-dash et la flèche typographiques n'y sont pas — pas besoin d'embarquer
    une police Unicode pour deux caractères, une substitution suffit."""
    return text.replace("—", " - ").replace("→", "->")


def _cell(pdf: FPDF, h: float, text: str, **kwargs) -> None:
    """multi_cell(w=0, align='C') laisse le curseur collé à la marge droite
    dans cette version de fpdf2 (bug de layout observé en direct) — on force
    le retour à la marge gauche avant chaque bloc plutôt que de faire confiance
    au comportement par défaut."""
    pdf.set_x(pdf.l_margin)
    pdf.multi_cell(pdf.epw, h, text, **kwargs)


def build() -> None:
    pdf = FPDF(format="A4")
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 18)
    _cell(pdf, 10, _ascii_safe("Manuel d'exploitation — Brasserie Strata"), align="C")
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(110, 110, 110)
    _cell(pdf, 6, "Procédures, défauts, recettes, maintenance et alarmes des 3 lignes de brassage.", align="C")
    pdf.set_text_color(0, 0, 0)
    pdf.ln(4)

    for section_title, entries in SECTIONS:
        pdf.set_font("Helvetica", "B", 14)
        pdf.ln(4)
        _cell(pdf, 8, _ascii_safe(section_title))
        pdf.set_draw_color(180, 180, 180)
        pdf.line(pdf.l_margin, pdf.get_y(), pdf.w - pdf.r_margin, pdf.get_y())
        pdf.ln(2)
        for title, body in entries:
            pdf.set_font("Helvetica", "B", 11)
            _cell(pdf, 7, _ascii_safe(title))
            pdf.set_font("Helvetica", "", 10)
            _cell(pdf, 5.5, _ascii_safe(body))
            pdf.ln(3)

    OUT_PATH.parent.mkdir(exist_ok=True)
    pdf.output(str(OUT_PATH))
    print(f"Écrit : {OUT_PATH} ({OUT_PATH.stat().st_size} octets)")


if __name__ == "__main__":
    build()

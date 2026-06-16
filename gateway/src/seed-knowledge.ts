/**
 * Seed initial de la base de connaissances (RAG).
 * Usage : npx tsx src/seed-knowledge.ts
 *
 * Chaque document est embeddi via nomic-embed-text et inséré dans la table `knowledge`.
 * Réexécuter le script est idempotent (ON CONFLICT DO NOTHING sur title+category).
 */
import pg from "pg";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";

const PG_DSN =
  process.env.PG_DSN ??
  "postgres://strata:change-me-en-prod@localhost:5432/strata";

// ─── Corpus de connaissances ─────────────────────────────────────────────────

const DOCUMENTS: { category: string; title: string; body: string }[] = [
  // ── SOPs machine ────────────────────────────────────────────────────────────
  {
    category: "sop",
    title: "Débloquer une embouteilleuse en attente",
    body: `Si l'embouteilleuse est en état 'en_attente' (tag .en_attente = 1), cela signifie que le fermenteur en amont n'a pas encore libéré le moût.
Vérifier : (1) l'état du fermenteur de la même ligne (tag fermenteur.state) ; (2) la température du fermenteur — si hors bande nominale, le process attend la stabilisation ; (3) les alarmes actives sur la ligne.
Action corrective : si la température est stable et correcte, vérifier manuellement la vanne de transfert. Si une alarme CIP est active, effectuer le cycle de nettoyage avant de relancer.`,
  },
  {
    category: "sop",
    title: "Procédure CIP (nettoyage en place)",
    body: `Le CIP (Clean In Place) doit être effectué entre chaque batch et après tout incident de contamination.
Séquence standard : rinçage eau froide (5 min) → soude caustique 2% à 75°C (20 min) → rinçage eau chaude (5 min) → acide nitrique 1% à 60°C (10 min) → rinçage eau stérile (5 min).
Le tag cip_ok passe à 1 (true) uniquement si la séquence complète s'est déroulée sans interruption. Un cip_ok=false sur un batch indique que le CIP a été sauté ou interrompu — cause principale de contamination.`,
  },
  {
    category: "sop",
    title: "Réagir à une alarme de fermentation hors température",
    body: `Si une alarme 'fermentation trop chaude' ou 'fermentation trop froide' se déclenche :
1. Vérifier le tag fermenteur.temperature en temps réel (get_history).
2. Comparer à la bande nominale de la recette : blonde [10-14°C], ipa [18-22°C], jalapeño [17-21°C].
3. Si déviation > 5°C depuis plus de 30 min : risquer un défaut fermentation_hors_spec sur le batch en cours.
4. Action : ajuster la consigne de température (set_command sur fermenteur.temp_consigne). Si le régulateur ne répond pas, vérifier le groupe froid de la cuve.
5. Si le batch a déjà été impacté, créer un rapport de non-conformité.`,
  },
  {
    category: "sop",
    title: "Réagir à une alarme de rendement faible",
    body: `Le défaut rendement_faible indique que la quantité de bière produite est inférieure à l'attendu pour la recette.
Causes possibles : (1) déviation thermique à l'empâtage — vérifier empateur.temperature vs bande nominale ; (2) durée d'ébullition insuffisante ; (3) pertes par fuite sur la ligne de transfert.
Diagnostic : appeler get_batch_context pour le batch concerné. Si cuves_hors_bande contient l'empateur, la cause est thermique. Vérifier également les logs d'alarme sur la période du batch.`,
  },
  {
    category: "sop",
    title: "Interpréter un arrêt machine (state=0)",
    body: `Un tag <machine>.state = 0 indique que la machine est à l'arrêt.
Distinguer : (1) arrêt planifié (pas de batch en cours, normal) ; (2) arrêt en attente amont (tag .en_attente=1, normal — attendre la cuve précédente) ; (3) arrêt sur défaut (alarme active sur la machine, anormal).
Pour diagnostiquer : vérifier list_alarms pour des alarmes actives sur la ligne. Si aucune alarme et pas de batch actif, l'arrêt est intentionnel. Si alarme présente, suivre la procédure de l'alarme correspondante.`,
  },
  // ── Défauts et causes racines ────────────────────────────────────────────────
  {
    category: "defaut",
    title: "Cause et remédiation : contamination",
    body: `Le défaut 'contamination' sur un batch signifie que des micro-organismes indésirables ont été détectés ou que les critères QC de contamination sont hors norme.
Cause principale : CIP non effectué ou incomplet (cip_ok = false). Cause secondaire : température de fermentation trop haute favorisant les bactéries lactiques.
Remédiation immédiate : isoler le batch, déclencher un CIP complet sur toutes les cuves de la ligne. Vérifier les joints et vannes pour tout point de contamination croisée. Ne pas redémarrer la production avant que cip_ok soit confirmé sur le prochain batch.`,
  },
  {
    category: "defaut",
    title: "Cause et remédiation : fermentation_hors_spec",
    body: `Le défaut 'fermentation_hors_spec' indique que la fermentation s'est déroulée hors des paramètres nominaux.
Cause : la cuve fermenteur a été en dehors de sa bande de température pendant plus de 10% du temps de fermentation (visible dans cuves_hors_bande du batch context).
Conséquences : profil aromatique dégradé, possible sous-atténuation ou sur-atténuation, risque de production de composés indésirables (diacétyle excessif à haute température).
Remédiation : vérifier et recalibrer le régulateur de température du fermenteur. Contrôler le groupe froid. Pour le batch impacté, faire une analyse sensorielle avant décision de mise en bouteille.`,
  },
  {
    category: "defaut",
    title: "Cause et remédiation : volume_insuffisant",
    body: `Le défaut 'volume_insuffisant' signifie que l'embouteilleuse a produit moins de bouteilles que le seuil minimum pour la recette.
Cause principale : panne de l'embouteilleuse pendant le batch (indicateur de panne dans les tags). Cause secondaire : volume de moût insuffisant en entrée.
Diagnostic : vérifier l'historique du tag embouteilleuse.panne sur la période du batch. Si panne détectée, analyser la durée et l'impact sur le volume total.
Remédiation : maintenance préventive sur les buses d'embouteillage. Vérifier la pression d'alimentation.`,
  },
  // ── Recettes ─────────────────────────────────────────────────────────────────
  {
    category: "recette",
    title: "Paramètres nominaux : Blonde (lager)",
    body: `Recette blonde — bière de fermentation basse (lager).
Empâtage : 65°C ± 4°C (bande nominale [61-69°C]), durée 60 min.
Ébullition : 100°C ± 2°C, durée 60 min.
Fermentation : 12°C ± 2°C (bande nominale [10-14°C]), durée 14 jours.
Cadence embouteilleuse : 50 bouteilles/min nominal.
CIP obligatoire avant chaque batch. Durée totale du process : environ 16 jours.`,
  },
  {
    category: "recette",
    title: "Paramètres nominaux : IPA (ale)",
    body: `Recette IPA — bière de fermentation haute (ale), amère et aromatique.
Empâtage : 66°C ± 4°C (bande nominale [62-70°C]), durée 60 min.
Ébullition : 100°C ± 2°C, durée 75 min (houblonnage en fin d'ébullition).
Fermentation : 20°C ± 2°C (bande nominale [18-22°C]), durée 7 jours.
Cadence embouteilleuse : 40 bouteilles/min nominal.
Attention : la fermentation IPA est plus sensible aux écarts de température que la blonde — un écart de +5°C peut produire des esters indésirables.`,
  },
  {
    category: "recette",
    title: "Paramètres nominaux : Jalapeño (ale épicée)",
    body: `Recette jalapeño — ale épicée avec addition de piments jalapeño en fermentation.
Empâtage : 64°C ± 4°C (bande nominale [60-68°C]), durée 60 min.
Ébullition : 100°C ± 2°C, durée 60 min.
Fermentation : 19°C ± 2°C (bande nominale [17-21°C]), durée 7 jours. Addition jalapeño frais à J+2.
Cadence embouteilleuse : 35 bouteilles/min nominal.
Note : le contact avec les jalapeños abaisse légèrement le pH — surveiller l'acidité en cours de fermentation.`,
  },

  // ── Démarrage / arrêt de ligne ───────────────────────────────────────────────
  {
    category: "sop",
    title: "Démarrer une ligne de production depuis l'arrêt",
    body: `Séquence de démarrage d'une ligne (blonde, ipa ou jalapeño) depuis l'arrêt complet :
1. Vérifier qu'aucune alarme active n'est présente sur la ligne (list_alarms).
2. Vérifier que le CIP a bien été effectué (cip_ok = true sur le dernier batch, ou confirmer manuellement).
3. Démarrer l'empateur : mettre en chauffe à la consigne de la recette (empateur.temp_consigne). Attendre que la température soit stable dans la bande nominale.
4. Une fois l'empâtage démarré, l'ébulliteur prend le relais automatiquement après transfert.
5. Le fermenteur démarre en refroidissement dès réception du moût. Vérifier la température de consigne (fermenteur.temp_consigne).
6. L'embouteilleuse démarre automatiquement quand le fermenteur libère le moût (en_attente passe à 0).
Un batch est automatiquement créé par le système dès que l'empateur est en marche.`,
  },
  {
    category: "sop",
    title: "Arrêter proprement une ligne de production",
    body: `Séquence d'arrêt propre d'une ligne :
1. Ne pas interrompre un batch en cours — attendre la fin de l'embouteillage (embouteilleuse.state = 0 naturellement).
2. Une fois le batch terminé, lancer immédiatement le CIP complet (voir procédure CIP).
3. Vérifier que tous les tags .state sont à 0 sur la ligne.
4. Acquitter les alarmes éventuelles restantes.
5. Consigner l'arrêt dans le registre (heure, raison, état du dernier batch).
En cas d'arrêt d'urgence en cours de batch : stopper l'empateur et l'ébulliteur en premier, maintenir la réfrigération du fermenteur. Le batch sera probablement non conforme — documenter l'incident.`,
  },
  // ── Maintenance préventive ────────────────────────────────────────────────────
  {
    category: "maintenance",
    title: "Maintenance préventive : empateur",
    body: `Fréquence : hebdomadaire.
Checks : vérifier le bon fonctionnement de la résistance chauffante (montée en température < 20 min pour atteindre 65°C) ; inspecter les agitateurs ; contrôler l'étanchéité des vannes de soutirage.
Signes d'alerte : montée en température lente (> 30 min), température qui n'atteint pas la consigne, écart > 5°C entre consigne et mesure en régime établi.
Action : si la résistance ne chauffe plus correctement, vérifier l'alimentation électrique et le relais de puissance. Contacter maintenance si le problème persiste.`,
  },
  {
    category: "maintenance",
    title: "Maintenance préventive : fermenteur",
    body: `Fréquence : après chaque batch (nettoyage) + mensuelle (inspection physique).
Checks mensuels : vérifier le groupe froid (pression du circuit, niveau de frigorigène) ; inspecter les joints de cuve pour tout signe de fuite ou de corrosion ; tester la sonde de température (comparer à thermomètre étalon — écart max admis : 0,5°C).
Signes d'alerte : impossible de maintenir la consigne de température, oscillations importantes autour de la consigne, alarmes répétées de fermentation hors température.
Action sur groupe froid défaillant : contacter le prestataire de maintenance frigorifique. Ne pas démarrer de nouveau batch sur la ligne tant que le groupe froid n'est pas opérationnel.`,
  },
  {
    category: "maintenance",
    title: "Maintenance préventive : embouteilleuse",
    body: `Fréquence : quotidienne (avant démarrage) + hebdomadaire (complète).
Checks quotidiens : vérifier la pression d'alimentation en CO2 ; inspecter les buses de remplissage (obstructions) ; vérifier le système de capsulage.
Checks hebdomadaires : lubrification des parties mécaniques ; vérification de l'alignement des convoyeurs ; test du système d'évacuation des bouteilles mal remplies.
Signes d'alerte : cadence en dessous de 80% du nominal sans explication (tag .cadence), pannes répétées (tag .panne = 1), taux de rebut > 5% (bouteilles_rebut / bouteilles_ok).
Le tag embouteilleuse.panne = 1 déclenche automatiquement une alarme. Vérifier en priorité le bourrage mécanique et les buses bouchées.`,
  },
  // ── OEE bas ──────────────────────────────────────────────────────────────────
  {
    category: "oee",
    title: "Diagnostic OEE bas (< 50%)",
    body: `Un OEE inférieur à 50% indique un problème significatif sur la ligne. Décomposer en trois composantes :
Disponibilité basse (< 70%) : la machine est souvent à l'arrêt ou en attente. Vérifier list_alarms et l'historique des pannes. Causes fréquentes : arrêts non planifiés, attentes amont (en_attente = 1 prolongé), CIP trop fréquents.
Performance basse (< 80%) : la machine tourne mais en-dessous de la cadence nominale. Vérifier le tag .cadence vs ideal_rate. Causes : usure mécanique, pression d'alimentation insuffisante, matière première non conforme.
Qualité basse (< 80%) : trop de rebuts à l'embouteillage. Vérifier le ratio bouteilles_rebut / bouteilles_ok. Causes : contamination, défaut de bouchage, produit hors spec.
Action recommandée : identifier la composante dominante, puis investiguer avec get_history sur les tags correspondants sur la période concernée.`,
  },
  // ── Transfert de poste ────────────────────────────────────────────────────────
  {
    category: "sop",
    title: "Checklist transfert de poste (passation de shift)",
    body: `À effectuer 15 minutes avant la fin du poste :
1. État des lignes : vérifier le state de chaque machine (empateur, ébulliteur, fermenteur, embouteilleuse) sur les 3 lignes.
2. Batches en cours : noter les batch IDs actifs, leur phase (empâtage / fermentation / embouteillage) et l'heure estimée de fin.
3. Alarmes : lister les alarmes actives et non acquittées (list_alarms). Toute alarme non résolue doit être signalée verbalement au shift entrant.
4. OEE du shift : communiquer les chiffres OEE de la période. Signaler toute anomalie (OEE < 60%, arrêt > 30 min).
5. CIP : préciser si un CIP est en cours ou planifié sur quelle ligne.
6. Actions en suspens : consignes modifiées, maintenances programmées, non-conformités ouvertes.`,
  },
  // ── Alarmes spécifiques ───────────────────────────────────────────────────────
  {
    category: "alarme",
    title: "Alarme : fermentation trop chaude",
    body: `Déclenchement : température du fermenteur dépasse la limite haute de la bande nominale (blonde > 14°C, ipa > 22°C, jalapeño > 21°C) pendant plus de 5 minutes.
Risques : production d'esters et de fusel alcohols, sur-atténuation, profil aromatique dégradé. Pour l'IPA, risque de production de diacétyle excessif.
Actions immédiates : (1) vérifier la consigne de température (fermenteur.temp_consigne) — a-t-elle été modifiée ? ; (2) vérifier le groupe froid (indicateur de fonctionnement) ; (3) si écart > 3°C depuis > 30 min, le batch est à risque — documenter.
Acquittement : acquitter l'alarme APRÈS avoir identifié et résolu la cause. Ne pas acquitter sans action corrective.`,
  },
  {
    category: "alarme",
    title: "Alarme : fermentation trop froide",
    body: `Déclenchement : température du fermenteur passe sous la limite basse de la bande nominale (blonde < 10°C, ipa < 18°C, jalapeño < 17°C) pendant plus de 5 minutes.
Risques : fermentation qui s'arrête (levures en dormance), sous-atténuation, batch non conforme.
Actions immédiates : (1) vérifier la consigne de température — valeur correcte ? ; (2) vérifier que le groupe froid n'est pas en sur-refroidissement (problème de régulation) ; (3) augmenter la consigne si nécessaire (set_command sur fermenteur.temp_consigne).
Pour la blonde (lager) : une chute à 8°C peut être tolérée brièvement en fin de fermentation (garde froide), mais pas en début. Pour l'ipa et jalapeño : toute chute sous 15°C en début de fermentation est critique.`,
  },
  {
    category: "alarme",
    title: "Alarme : panne embouteilleuse",
    body: `Déclenchement : tag embouteilleuse.panne = 1 (détection d'un blocage mécanique ou d'une anomalie de remplissage).
Actions immédiates : (1) arrêter l'alimentation en amont (vanne de transfert fermenteur → embouteilleuse) ; (2) dégager le bourrage mécanique si présent (vérifier le convoyeur et les buses) ; (3) vérifier la pression CO2 (min 3 bar) ; (4) relancer en mode test (vitesse réduite) avant de reprendre la cadence nominale.
Si la panne dure > 20 min : le moût en attente peut se dégrader. Évaluer si un retour en cuve tampon est possible.
Acquitter l'alarme uniquement après redémarrage réussi.`,
  },
  // ── Gestion des non-conformités ───────────────────────────────────────────────
  {
    category: "qualite",
    title: "Gestion d'un batch non conforme",
    body: `Quand un batch est marqué non conforme (defaut_type non nul dans la table batches) :
1. ISOLER : bloquer physiquement les bouteilles produites (ne pas expédier). Étiqueter le lot "EN QUARANTAINE".
2. DOCUMENTER : noter le batch ID, le defaut_type, les cuves concernées (cuves_hors_bande), le cip_ok.
3. ÉVALUER selon le type de défaut :
   - contamination : destruction obligatoire du lot. CIP complet avant tout nouveau batch. Analyse microbiologique recommandée.
   - fermentation_hors_spec : analyse sensorielle et chimique (taux d'alcool, pH, amertume). Selon résultat : déclassement (vente moindre qualité), retraitement si possible, ou destruction.
   - rendement_faible / volume_insuffisant : le produit peut être conforme en qualité mais en quantité insuffisante. Analyser et décider au cas par cas.
4. TRACER : enregistrer la décision dans le système (id batch, décision, responsable, date).
5. CORRIGER : identifier la cause racine et mettre en place une action corrective pour éviter la récurrence.`,
  },
];

// ─── Embedding & insertion ────────────────────────────────────────────────────

async function embedText(text: string): Promise<number[]> {
  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!resp.ok) throw new Error(`embed error ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as { embeddings: number[][] };
  return data.embeddings[0];
}

async function main() {
  const pool = new pg.Pool({ connectionString: PG_DSN });

  // Idempotence : ajouter contrainte unique si absente
  await pool.query(`
    ALTER TABLE knowledge
    ADD CONSTRAINT IF NOT EXISTS knowledge_category_title_key UNIQUE (category, title)
  `).catch(() => {});

  let inserted = 0;
  let skipped = 0;

  for (const doc of DOCUMENTS) {
    const text = `${doc.title}\n\n${doc.body}`;
    process.stdout.write(`Embedding "${doc.title}"... `);
    const vec = await embedText(text);
    const res = await pool.query(
      `INSERT INTO knowledge (category, title, body, embedding)
       VALUES ($1, $2, $3, $4::vector)
       ON CONFLICT (category, title) DO UPDATE
         SET body = EXCLUDED.body, embedding = EXCLUDED.embedding, updated_at = now()
       RETURNING id`,
      [doc.category, doc.title, doc.body, `[${vec.join(",")}]`],
    );
    console.log(res.rows[0]?.id ? `OK (id=${res.rows[0].id})` : "skipped");
    res.rows[0]?.id ? inserted++ : skipped++;
  }

  console.log(`\nTerminé : ${inserted} insérés/mis à jour, ${skipped} ignorés.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

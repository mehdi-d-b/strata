/**
 * Suivi des batchs : assemble les tags `<ligne>.batch.{id,phase,qc_verdict,rebut_pct}`
 * émis par le simulateur et persiste une ligne dans `batches` à l'OUVERTURE puis à la
 * CLÔTURE (phase=5). C'est la généalogie de batch que lira get_batch_context (assistant).
 *
 * Pattern calqué sur AlarmEngine : état en mémoire, écriture en base seulement aux
 * transitions (ouverture / clôture), jamais à chaque mesure.
 */
import type pg from "pg";

// Code numérique de verdict (porté par le tag) -> nom métier. Doit rester aligné
// avec les constantes VERDICT_* de simulator/factory/brain.py.
const VERDICT: Record<number, string> = {
  0: "ok",
  1: "fermentation_hors_spec",
  2: "rendement_faible",
  3: "contamination",
  4: "volume_insuffisant",
  5: "derive_non_rattrapee",
};

type LineState = {
  id: number; // epoch (s) du début du batch courant (0 = aucun)
  phase: number; // 0 aucun · 1 en cours · 5 clôturé
  verdict: number; // code verdict (cf. VERDICT)
  rebut: number; // % rebut
  insertedId: number; // dernier id pour lequel on a inséré une ligne (anti-doublon)
  closedId: number; // dernier id qu'on a clôturé
};

export class BatchTracker {
  private lines = new Map<string, LineState>();

  constructor(
    private pool: pg.Pool,
    private audit: (user: string | null, action: string, target?: string | null, detail?: unknown) => Promise<void>,
  ) {}

  /** Traite une mesure `*.batch.*` (valeur brute : ce sont des codes/compteurs exacts). */
  async onMeasure(tag: string, value: number): Promise<void> {
    const i = tag.indexOf(".batch.");
    if (i < 0) return;
    const line = tag.slice(0, i); // ex "brasserie.ipa"
    const field = tag.slice(i + ".batch.".length); // id | phase | qc_verdict | rebut_pct

    const st =
      this.lines.get(line) ??
      { id: 0, phase: 0, verdict: 0, rebut: 0, insertedId: 0, closedId: 0 };
    switch (field) {
      case "id":
        st.id = Math.round(value);
        break;
      case "phase":
        st.phase = Math.round(value);
        break;
      case "qc_verdict":
        st.verdict = Math.round(value);
        break;
      case "rebut_pct":
        st.rebut = value;
        break;
      default:
        return; // champ batch inconnu : on ignore
    }
    this.lines.set(line, st);

    // On réconcilie sur rebut_pct, publié EN DERNIER par le simulateur (ordre des
    // tags batch). À cet instant id/phase/verdict du snapshot sont à jour → on évite
    // de clôturer avec le verdict "provisoire" (0) lu avant le verdict réel.
    if (field === "rebut_pct") await this.reconcile(line, st);
  }

  private async reconcile(line: string, st: LineState): Promise<void> {
    if (!st.id) return;
    const recipe = line.split(".").pop() ?? line;
    const batchId = `${recipe}-${st.id}`;

    // Ouverture : 1ʳᵉ fois qu'on voit cet id -> ligne 'running'. started_at vient de
    // l'epoch encodé dans l'id (début réel du batch). Idempotent (ON CONFLICT).
    if (st.insertedId !== st.id) {
      const res = await this.pool.query(
        `INSERT INTO batches (id, recipe, line, started_at, status)
         VALUES ($1, $2, $3, to_timestamp($4), 'running')
         ON CONFLICT (id) DO NOTHING`,
        [batchId, recipe, line, st.id],
      );
      st.insertedId = st.id;
      if (res.rowCount && res.rowCount > 0) {
        await this.audit(null, "batch.open", batchId, { recipe, line });
      }
    }

    // Clôture : phase=5 -> renseigne verdict + rebut (une seule fois).
    if (st.phase === 5 && st.closedId !== st.id) {
      const name = VERDICT[st.verdict] ?? `verdict_${st.verdict}`;
      const defaut = st.verdict === 0 ? null : name;
      const res = await this.pool.query(
        `UPDATE batches
            SET ended_at = now(), status = 'done',
                qc_verdict = $2, defaut_type = $3, rebut_pct = $4
          WHERE id = $1 AND status = 'running'`,
        [batchId, name, defaut, st.rebut],
      );
      st.closedId = st.id;
      if (res.rowCount && res.rowCount > 0) {
        await this.audit(null, "batch.close", batchId, { verdict: name, rebut_pct: st.rebut });
      }
    }
    this.lines.set(line, st);
  }
}

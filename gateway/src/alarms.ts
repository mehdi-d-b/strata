/**
 * Détection d'alarmes par seuils (Phase A), dans la gateway, sur le flux `tags.raw`.
 *
 * Le modèle d'alarme persisté (`alarms`) est indépendant du détecteur : ici on
 * produit des alarmes `source='rule'`, mais RisingWave ou des tags PLC pourront
 * alimenter le même journal plus tard.
 *
 * Conçu pour ne PAS requêter la base à chaque mesure : les règles sont en cache
 * mémoire (rafraîchi périodiquement), et l'état d'évaluation (anti-rebond,
 * alarmes actives) est tenu en mémoire. La persistance n'a lieu qu'aux transitions
 * (raise / clear), qui sont rares comparées au débit de mesures.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";

export type Severity = "critical" | "warning" | "info";
export type Operator = ">" | ">=" | "<" | "<=" | "==" | "!=";

export type AlarmRule = {
  id: string;
  tag: string;
  operator: Operator;
  threshold: number;
  severity: Severity;
  message: string | null;
  for_ms: number;
  hysteresis: number;
  enabled: boolean;
  // Mode bande (si renseigné) : compare `tag` à la valeur COURANTE de `ref_tag`
  // ± tolerance, au lieu du seuil fixe operator/threshold (ignorés dans ce cas).
  ref_tag: string | null;
  tolerance: number | null;
};

/** État d'évaluation en mémoire d'une règle. */
type RuleState = {
  active: boolean; // une alarme est-elle actuellement levée pour cette règle ?
  condSince: number | null; // depuis quand la condition est vraie (anti-rebond), ms epoch
};

export class AlarmEngine {
  private rules: AlarmRule[] = [];
  private byTag = new Map<string, AlarmRule[]>();
  private state = new Map<string, RuleState>();
  // Dernière valeur connue par tag, TOUS tags confondus (pas que ceux avec règle) :
  // sert de référence live pour les règles en mode bande (ref_tag).
  private lastValue = new Map<string, number>();

  constructor(
    private pool: pg.Pool,
    private audit: (user: string | null, action: string, target?: string | null, detail?: unknown) => Promise<void>,
  ) {}

  /** Recharge les règles depuis la base (appelé périodiquement). */
  async refresh(): Promise<void> {
    const { rows } = await this.pool.query(
      `SELECT id, tag, operator, threshold, severity, message, for_ms, hysteresis, enabled,
              ref_tag, tolerance
       FROM alarm_rules WHERE enabled`,
    );
    this.rules = rows as AlarmRule[];
    this.byTag.clear();
    for (const r of this.rules) {
      const arr = this.byTag.get(r.tag) ?? [];
      arr.push(r);
      this.byTag.set(r.tag, arr);
    }
    // Nettoie l'état des règles disparues.
    const ids = new Set(this.rules.map((r) => r.id));
    for (const id of [...this.state.keys()]) if (!ids.has(id)) this.state.delete(id);
  }

  /** Au démarrage : resynchronise l'état "active" depuis la table alarms. */
  async hydrate(): Promise<void> {
    const { rows } = await this.pool.query(
      "SELECT rule_id FROM alarms WHERE state = 'active' AND rule_id IS NOT NULL",
    );
    for (const r of rows) {
      this.state.set(r.rule_id, { active: true, condSince: null });
    }
  }

  /** Évalue la condition brute d'une règle pour une valeur. */
  private conditionMet(rule: AlarmRule, value: number): boolean {
    if (rule.ref_tag) {
      const refVal = this.lastValue.get(rule.ref_tag);
      if (refVal == null) return false; // référence pas encore connue -> pas de faux positif
      return Math.abs(value - refVal) > (rule.tolerance ?? 0);
    }
    switch (rule.operator) {
      case ">": return value > rule.threshold;
      case ">=": return value >= rule.threshold;
      case "<": return value < rule.threshold;
      case "<=": return value <= rule.threshold;
      case "==": return value === rule.threshold;
      case "!=": return value !== rule.threshold;
    }
  }

  /**
   * Condition de RETOUR à la normale en tenant compte de l'hystérésis : on ne
   * "clear" que quand la valeur est repassée franchement de l'autre côté du seuil
   * (bande morte). Pour ==/!=, l'hystérésis n'a pas de sens -> simple négation.
   */
  private clearMet(rule: AlarmRule, value: number): boolean {
    const h = rule.hysteresis || 0;
    if (rule.ref_tag) {
      const refVal = this.lastValue.get(rule.ref_tag);
      if (refVal == null) return false; // référence perdue -> on ne clôt pas sur une supposition
      return Math.abs(value - refVal) < Math.max(0, (rule.tolerance ?? 0) - h);
    }
    switch (rule.operator) {
      case ">":
      case ">=":
        return value < rule.threshold - h;
      case "<":
      case "<=":
        return value > rule.threshold + h;
      default:
        return !this.conditionMet(rule, value);
    }
  }

  private defaultMessage(rule: AlarmRule): string {
    if (rule.message?.trim()) return rule.message;
    return rule.ref_tag
      ? `${rule.tag} écart > ${rule.tolerance} vs ${rule.ref_tag}`
      : `${rule.tag} ${rule.operator} ${rule.threshold}`;
  }

  /** Traite une mesure (valeur déjà scalée) : lève/clôt les alarmes concernées. */
  async onMeasure(tag: string, value: number, now = Date.now()): Promise<void> {
    // Mémorisé pour TOUT tag (pas seulement ceux avec règle) : sert de référence
    // live si un autre tag a une règle en mode bande pointant vers celui-ci.
    this.lastValue.set(tag, value);
    const rules = this.byTag.get(tag);
    if (!rules) return;
    for (const rule of rules) {
      const st = this.state.get(rule.id) ?? { active: false, condSince: null };
      const met = this.conditionMet(rule, value);

      if (!st.active) {
        // Pas encore d'alarme : on regarde si la condition tient depuis assez longtemps.
        if (met) {
          if (st.condSince == null) st.condSince = now;
          if (now - st.condSince >= (rule.for_ms || 0)) {
            await this.raise(rule, value, now);
            st.active = true;
            st.condSince = null;
          }
        } else {
          st.condSince = null; // la condition retombe -> on réarme l'anti-rebond
        }
      } else {
        // Alarme active : on clôt quand la valeur repasse (avec hystérésis).
        if (this.clearMet(rule, value)) {
          await this.clear(rule, now);
          st.active = false;
          st.condSince = null;
        }
      }
      this.state.set(rule.id, st);
    }
  }

  private async raise(rule: AlarmRule, value: number, now: number): Promise<void> {
    const id = randomUUID();
    // ON CONFLICT : si une alarme active existe déjà pour cette règle (garde
    // anti-spam via l'index unique partiel), on ne crée pas de doublon.
    const res = await this.pool.query(
      `INSERT INTO alarms (id, rule_id, source, tag, severity, message, value, state, raised_at)
       VALUES ($1, $2, 'rule', $3, $4, $5, $6, 'active', to_timestamp($7 / 1000.0))
       ON CONFLICT DO NOTHING`,
      [id, rule.id, rule.tag, rule.severity, this.defaultMessage(rule), value, now],
    );
    if (res.rowCount && res.rowCount > 0) {
      await this.audit(null, "alarm.raise", rule.tag, {
        rule_id: rule.id,
        severity: rule.severity,
        value,
      });
    }
  }

  private async clear(rule: AlarmRule, now: number): Promise<void> {
    const res = await this.pool.query(
      `UPDATE alarms SET state = 'cleared', cleared_at = to_timestamp($2 / 1000.0)
       WHERE rule_id = $1 AND state = 'active'`,
      [rule.id, now],
    );
    if (res.rowCount && res.rowCount > 0) {
      await this.audit(null, "alarm.clear", rule.tag, { rule_id: rule.id });
    }
  }
}

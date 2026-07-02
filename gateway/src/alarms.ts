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
  // Mode self-baseline (si renseigné, et ref_tag NULL) : compare la tendance COURT terme
  // de `tag` (tag_stats_1m) à sa tendance LONG terme (tag_stats_5m) ± baseline_sigma
  // écarts-types du long terme. Comparer deux moyennes lissées plutôt qu'une valeur
  // instantanée à une moyenne évite le clignotement sur une vraie dérive lente (le
  // long terme ne "rattrape" pas l'anomalie, contrairement à une fenêtre courte seule).
  baseline_sigma: number | null;
};

/** État d'évaluation en mémoire d'une règle. */
type RuleState = {
  active: boolean; // une alarme est-elle actuellement levée pour cette règle ?
  condSince: number | null; // depuis quand la condition est vraie (anti-rebond), ms epoch
};

/** Même forme que le type `Alarm` du front (web/src/api.ts) — poussée sur `/ws`. */
export type AlarmEvent = {
  id: string;
  rule_id: string | null;
  source: "rule";
  tag: string;
  severity: Severity;
  message: string;
  value: number | null;
  state: "active" | "cleared";
  raised_at: string;
  cleared_at: string | null;
  acked: boolean;
  acked_by: null;
  acked_at: null;
};

export class AlarmEngine {
  private rules: AlarmRule[] = [];
  private byTag = new Map<string, AlarmRule[]>();
  private state = new Map<string, RuleState>();
  // Dernière valeur connue par tag, TOUS tags confondus (pas que ceux avec règle) :
  // sert de référence live pour les règles en mode bande (ref_tag).
  private lastValue = new Map<string, number>();
  // Moyenne/écart-type glissants COURT terme (tag_stats_1m) et LONG terme (tag_stats_5m),
  // uniquement pour les tags ayant une règle en mode self-baseline — rafraîchis à la même
  // cadence que refresh(). Le mode self-baseline compare les deux (cf. AlarmRule.baseline_sigma).
  private baselineStats = new Map<string, { mean: number; sd: number }>();
  private longStats = new Map<string, { mean: number; sd: number }>();

  constructor(
    private pool: pg.Pool,
    private audit: (user: string | null, action: string, target?: string | null, detail?: unknown) => Promise<void>,
    // Push WS instantané (Phase C) : appelé à chaque raise/clear, en plus du
    // polling REST ~7s côté front qui reste le filet de rattrapage (reconnexion,
    // 1er chargement). Optionnel : l'engine fonctionne à l'identique sans (tests).
    private onEvent?: (e: AlarmEvent) => void,
  ) {}

  /** Recharge les règles depuis la base (appelé périodiquement). */
  async refresh(): Promise<void> {
    const { rows } = await this.pool.query(
      `SELECT id, tag, operator, threshold, severity, message, for_ms, hysteresis, enabled,
              ref_tag, tolerance, baseline_sigma
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
    await this.refreshBaselines();
  }

  /** Rafraîchit les tendances court/long terme pour les tags en mode self-baseline. */
  private async refreshBaselines(): Promise<void> {
    const tags = [...new Set(this.rules.filter((r) => r.baseline_sigma != null).map((r) => r.tag))];
    if (!tags.length) return;
    const [short, long] = await Promise.all([
      this.pool.query(
        `SELECT DISTINCT ON (tag) tag, mean, sd FROM tag_stats_1m
         WHERE tag = ANY($1) ORDER BY tag, bucket DESC`,
        [tags],
      ),
      this.pool.query(
        `SELECT DISTINCT ON (tag) tag, mean, sd FROM tag_stats_5m
         WHERE tag = ANY($1) ORDER BY tag, bucket DESC`,
        [tags],
      ),
    ]);
    for (const r of short.rows) {
      if (r.sd == null) continue;
      this.baselineStats.set(r.tag, { mean: Number(r.mean), sd: Number(r.sd) });
    }
    for (const r of long.rows) {
      if (r.sd == null) continue;
      this.longStats.set(r.tag, { mean: Number(r.mean), sd: Number(r.sd) });
    }
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
    if (rule.baseline_sigma != null) {
      // Court terme vs long terme (pas la valeur instantanée) : évite le clignotement
      // sur une dérive lente (cf. infra/timescale/init/17-tag-stats-long.sql).
      const short = this.baselineStats.get(rule.tag);
      const long = this.longStats.get(rule.tag);
      if (!short || !long) return false; // pas encore de tendance -> pas de faux positif
      return Math.abs(short.mean - long.mean) > rule.baseline_sigma * long.sd;
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
    if (rule.baseline_sigma != null) {
      const short = this.baselineStats.get(rule.tag);
      const long = this.longStats.get(rule.tag);
      if (!short || !long) return false; // tendance perdue -> on ne clôt pas sur une supposition
      return Math.abs(short.mean - long.mean) < Math.max(0, rule.baseline_sigma * long.sd - h);
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
    if (rule.ref_tag) return `${rule.tag} écart > ${rule.tolerance} vs ${rule.ref_tag}`;
    if (rule.baseline_sigma != null) return `${rule.tag} tendance 1 min écart > ${rule.baseline_sigma}σ vs tendance 5 min`;
    return `${rule.tag} ${rule.operator} ${rule.threshold}`;
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
    const message = this.defaultMessage(rule);
    // ON CONFLICT : si une alarme active existe déjà pour cette règle (garde
    // anti-spam via l'index unique partiel), on ne crée pas de doublon.
    const res = await this.pool.query(
      `INSERT INTO alarms (id, rule_id, source, tag, severity, message, value, state, raised_at)
       VALUES ($1, $2, 'rule', $3, $4, $5, $6, 'active', to_timestamp($7 / 1000.0))
       ON CONFLICT DO NOTHING`,
      [id, rule.id, rule.tag, rule.severity, message, value, now],
    );
    if (res.rowCount && res.rowCount > 0) {
      await this.audit(null, "alarm.raise", rule.tag, {
        rule_id: rule.id,
        severity: rule.severity,
        value,
      });
      this.onEvent?.({
        id,
        rule_id: rule.id,
        source: "rule",
        tag: rule.tag,
        severity: rule.severity,
        message,
        value,
        state: "active",
        raised_at: new Date(now).toISOString(),
        cleared_at: null,
        acked: false,
        acked_by: null,
        acked_at: null,
      });
    }
  }

  private async clear(rule: AlarmRule, now: number): Promise<void> {
    const res = await this.pool.query(
      `UPDATE alarms SET state = 'cleared', cleared_at = to_timestamp($2 / 1000.0)
       WHERE rule_id = $1 AND state = 'active'
       RETURNING id, severity, message, value, raised_at, acked`,
      [rule.id, now],
    );
    if (res.rowCount && res.rowCount > 0) {
      await this.audit(null, "alarm.clear", rule.tag, { rule_id: rule.id });
      const r = res.rows[0];
      this.onEvent?.({
        id: r.id,
        rule_id: rule.id,
        source: "rule",
        tag: rule.tag,
        severity: r.severity,
        message: r.message,
        value: r.value,
        state: "cleared",
        raised_at: new Date(r.raised_at).toISOString(),
        cleared_at: new Date(now).toISOString(),
        acked: r.acked,
        acked_by: null,
        acked_at: null,
      });
    }
  }
}

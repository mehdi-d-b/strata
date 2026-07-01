/**
 * Assistant IA local (Chemin B). Boucle d'agent contre un runtime LLM open-source
 * compatible OpenAI (Ollama, 100 % local). Cf. docs/llm-integration.md.
 *
 * Règle d'or : le LLM ne peut RIEN exécuter — il émet des *demandes* de tool, et
 * c'est CE code qui exécute des tools de LECTURE via la base (jamais d'accès direct
 * pour le modèle). Les tools tournent avec le contexte de l'utilisateur connecté.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { can, type AuthUser } from "./auth.js";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://ollama:11434";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";
const MODEL = process.env.ASSISTANT_MODEL ?? "qwen2.5:3b";
const MAX_STEPS = 10;

async function embed(text: string): Promise<number[]> {
  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!resp.ok) throw new Error(`embed error ${resp.status}`);
  const data = (await resp.json()) as { embeddings: number[][] };
  return data.embeddings[0];
}

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
};

// Menu de tools présenté au modèle (lecture seule, paramétré, sûr).
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_oee",
      description:
        "OEE (Disponibilité × Performance × Qualité) par ligne et shift sur N jours. Renvoie aussi produced/ok, l'objectif de pièces et la projection.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "integer", description: "fenêtre en jours (défaut 7)" },
          line: { type: "string", description: "préfixe de ligne, ex 'brasserie.blonde' (optionnel)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_production",
      description: "Production par shift sur N jours : bonnes pièces (ok), rebut (scrap), total (produced).",
      parameters: { type: "object", properties: { days: { type: "integer" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "list_alarms",
      description: "Alarmes actives OU retombées mais non encore acquittées (tag, sévérité, message, état, depuis quand).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_history",
      description:
        "Tendance d'un tag sur N minutes : valeur ACTUELLE + points sous-échantillonnés (pour décrire l'évolution). Pas de moyenne globale (souvent trompeuse sur un signal physique).",
      parameters: {
        type: "object",
        properties: {
          tag: { type: "string", description: "nom métier du tag, ex 'brasserie.ipa.fermenteur.temperature'" },
          minutes: { type: "integer", description: "fenêtre en minutes (défaut 60)" },
        },
        required: ["tag"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_batch_context",
      description:
        "Dossier d'un batch (brassage) pour enquêter sur sa qualité : verdict QC, déviations de chaque cuve VS sa bande nominale, alarmes survenues, changements de consigne, sanitation (CIP). Réf = un id de batch (ex 'ipa-1781…') ou une recette ('ipa', 'blonde', 'jalapeno', ou 'dernier ipa').",
      parameters: {
        type: "object",
        properties: {
          batch_ref: { type: "string", description: "id de batch, ou recette (= dernier batch de cette recette)" },
        },
        required: ["batch_ref"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "describe_schema",
      description:
        "Liste les tables/vues de données interrogeables et leurs colonnes. À appeler AVANT query_readonly pour savoir quoi interroger, quand les autres tools ne suffisent pas.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "query_readonly",
      description:
        "Exécute UNE requête SQL PostgreSQL en LECTURE SEULE (SELECT uniquement) sur les données Strata, pour une question non couverte par les autres tools. Utilise d'abord describe_schema pour connaître les tables/colonnes. Résultat plafonné à 500 lignes.",
      parameters: {
        type: "object",
        properties: { sql: { type: "string", description: "une seule requête SELECT (sans point-virgule)" } },
        required: ["sql"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description:
        "Recherche dans la base de connaissances (SOPs, procédures, causes de défauts, historique d'incidents) par similarité sémantique. À utiliser quand l'opérateur cherche comment résoudre un problème, débloquer une machine, comprendre une cause racine.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "description du problème ou question en langage naturel" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_command",
      description:
        "PROPOSE d'écrire une consigne (setpoint) sur un tag. ACTION soumise à CONFIRMATION humaine — n'exécute rien directement.",
      parameters: {
        type: "object",
        properties: {
          tag: { type: "string", description: "tag cible (ex 'brasserie.ipa.fermenteur.temp_consigne')" },
          value: { type: "number" },
        },
        required: ["tag", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ack_alarm",
      description: "PROPOSE d'acquitter une alarme (par son id). ACTION soumise à CONFIRMATION humaine.",
      parameters: {
        type: "object",
        properties: { alarm_id: { type: "string" } },
        required: ["alarm_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_line_status",
      description:
        "État temps réel d'une ou toutes les lignes : état de chaque machine (arrêt/marche/attente), température, alarmes actives, batch en cours. À utiliser pour savoir ce qui tourne, ce qui est bloqué, ce qui est en panne.",
      parameters: {
        type: "object",
        properties: {
          line: { type: "string", description: "préfixe de ligne ex 'brasserie.blonde' (optionnel, toutes les lignes si absent)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_shift_summary",
      description:
        "Résumé complet du shift en cours : OEE et production par ligne, batches actifs, nombre d'alarmes non acquittées. Vue d'ensemble pour savoir comment se passe la journée.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_oee_breakdown",
      description:
        "OEE décomposé en Disponibilité, Performance et Qualité par ligne, avec les principales causes de perte. Utile pour diagnostiquer pourquoi l'OEE est bas.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "integer", description: "fenêtre en jours (défaut 1 = aujourd'hui)" },
          line: { type: "string", description: "préfixe de ligne (optionnel)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_active_batches",
      description:
        "Liste tous les batches actuellement en cours (non terminés) avec leur recette, ligne, durée écoulée et phase estimée.",
      parameters: { type: "object", properties: {} },
    },
  },
];

// Tools d'écriture : la boucle ne les EXÉCUTE pas — elle propose une action que
// l'humain confirme (cf. /api/assistant/confirm). Un mauvais choix du modèle est
// donc inoffensif (l'humain annule).
export const WRITE_TOOLS = new Set(["set_command", "ack_alarm"]);

export type PendingAction = { id: string; tool: string; args: Args; summary: string };
export type PendingEntry = { username: string; tool: string; args: Args; createdAt: number };

const PENDING = new Map<string, PendingEntry>();
const PENDING_TTL_MS = 10 * 60 * 1000;

async function summarize(pool: pg.Pool, tool: string, args: Args): Promise<string> {
  switch (tool) {
    case "set_command":
      return `écrire la consigne ${args.value} sur le tag « ${args.tag} »`;
    case "ack_alarm": {
      // Affiche le tag de l'alarme (plus lisible que l'uuid) si on le retrouve.
      const { rows } = await pool.query("SELECT tag FROM alarms WHERE id = $1", [String(args.alarm_id ?? "")]);
      const tag = rows[0]?.tag;
      return tag ? `acquitter l'alarme « ${tag} »` : `acquitter l'alarme ${args.alarm_id}`;
    }
    default:
      return `${tool}(${JSON.stringify(args)})`;
  }
}

async function addPending(pool: pg.Pool, username: string, tool: string, args: Args): Promise<PendingAction> {
  const now = Date.now();
  for (const [k, v] of PENDING) if (now - v.createdAt > PENDING_TTL_MS) PENDING.delete(k);
  const id = randomUUID();
  PENDING.set(id, { username, tool, args, createdAt: now });
  return { id, tool, args, summary: await summarize(pool, tool, args) };
}

/** Récupère une action en attente non expirée (pour /confirm). */
export function getPending(id: string): PendingEntry | undefined {
  const e = PENDING.get(id);
  if (!e) return undefined;
  if (Date.now() - e.createdAt > PENDING_TTL_MS) {
    PENDING.delete(id);
    return undefined;
  }
  return e;
}

export function consumePending(id: string): void {
  PENDING.delete(id);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

/** Args d'un tool-call : objet (API native Ollama) ou string JSON (compat OpenAI). */
function toArgs(raw: unknown): Args {
  if (raw && typeof raw === "object") return raw as Args;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw || "{}");
    } catch {
      return {};
    }
  }
  return {};
}

/** Exécute un tool (LECTURE seule). Renvoie une chaîne (JSON) destinée au modèle. */
async function execTool(pool: pg.Pool, user: AuthUser | null, name: string, args: Args): Promise<string> {
  switch (name) {
    case "get_oee": {
      const days = Math.min(Number(args.days ?? 7) || 7, 60);
      const params: unknown[] = [days];
      let where = "day > (now() - ($1 || ' days')::interval)::date";
      if (args.line) {
        params.push(String(args.line));
        where += ` AND line = $2`;
      }
      const { rows } = await pool.query(
        `SELECT line, day::date AS day, shift_no, produced, ok,
                round(oee::numeric,3) AS oee, round(availability::numeric,3) AS availability,
                round(performance::numeric,3) AS performance, round(quality::numeric,3) AS quality,
                target_pieces, projected_pieces
         FROM oee_by_shift WHERE ${where}
         ORDER BY day DESC, line ASC, shift_no ASC LIMIT 30`,
        params,
      );
      return JSON.stringify(rows);
    }
    case "get_production": {
      const days = Math.min(Number(args.days ?? 7) || 7, 60);
      const { rows } = await pool.query(
        `SELECT day::date AS day, shift_no, shift_label, ok, scrap, produced
         FROM prod_by_shift_role
         WHERE day > (now() - ($1 || ' days')::interval)::date
         ORDER BY day DESC, shift_no ASC LIMIT 40`,
        [days],
      );
      return JSON.stringify(rows);
    }
    case "list_alarms": {
      const { rows } = await pool.query(
        `SELECT id, tag, severity, message, state, acked, raised_at, cleared_at FROM alarms
         WHERE state='active' OR (state='cleared' AND acked=false)
         ORDER BY raised_at DESC LIMIT 50`,
      );
      return JSON.stringify(rows);
    }
    case "get_history": {
      const tag = String(args.tag ?? "");
      if (!tag) return JSON.stringify({ error: "tag requis" });
      if (!can(user, "read", tag)) return JSON.stringify({ error: `pas le droit de lire ${tag}` });
      const minutes = Math.min(Number(args.minutes ?? 60) || 60, 1440);
      const cfg = await pool.query(`SELECT scale, offset_val FROM tags WHERE name = $1`, [tag]);
      const s = Number(cfg.rows[0]?.scale ?? 1);
      const o = Number(cfg.rows[0]?.offset_val ?? 0);
      const bucketMin = Math.max(1, Math.round(minutes / 20)); // ~20 points sur la fenêtre
      const { rows } = await pool.query(
        `SELECT time_bucket(($2 || ' minutes')::interval, ts) AS t, avg(value) AS v
         FROM mesures WHERE tag = $1 AND ts > now() - ($3 || ' minutes')::interval
         GROUP BY t ORDER BY t`,
        [tag, bucketMin, minutes],
      );
      const sc = (v: unknown) => (v == null ? null : Math.round((Number(v) * s + o) * 1000) / 1000);
      const points = rows.map((r) => ({ t: r.t, v: sc(r.v) }));
      const current = points.length ? points[points.length - 1].v : null;
      // Tendance brute : valeur actuelle + points (la courbe parle). PAS de moyenne
      // globale — une métrique qui a du sens est spécifique au signal et doit être
      // définie comme tag dérivé (cf. docs/llm-integration.md), pas calculée naïvement ici.
      return JSON.stringify({ tag, minutes, current, points });
    }
    case "get_batch_context": {
      const ref = String(args.batch_ref ?? "").trim();
      if (!ref) return JSON.stringify({ error: "batch_ref requis" });
      const round1 = (v: unknown) => (v == null ? null : Math.round(Number(v) * 10) / 10);
      const cols =
        "id, recipe, line, started_at, ended_at, status, qc_verdict, defaut_type, rebut_pct";
      // Résolution : id exact, sinon dernier batch d'une recette (gère "dernier ipa").
      let b = (await pool.query(`SELECT ${cols} FROM batches WHERE id = $1`, [ref])).rows[0];
      if (!b) {
        const recs = (await pool.query("SELECT DISTINCT recipe FROM batches")).rows.map(
          (r) => r.recipe as string,
        );
        const hit = recs.find((rc) => ref.toLowerCase().includes(rc.toLowerCase()));
        if (hit)
          b = (
            await pool.query(
              `SELECT ${cols} FROM batches WHERE recipe = $1 ORDER BY started_at DESC LIMIT 1`,
              [hit],
            )
          ).rows[0];
        if (!b) return JSON.stringify({ error: `batch introuvable: ${ref}`, recettes_connues: recs });
      }
      const line = b.line as string;
      // RBAC : on exige le droit de lire les données de procédé de la ligne.
      if (!can(user, "read", `${line}.fermenteur.temperature`))
        return JSON.stringify({ error: `pas le droit de lire la ligne ${line}` });
      const start = b.started_at as Date;
      const end = (b.ended_at as Date) ?? new Date(); // batch en cours -> jusqu'à maintenant

      // Déviations par cuve VS bande nominale [temp_cible ± temp_tol]. Cuves découvertes
      // via les tags *.temperature de la ligne (générique, pas de noms en dur).
      const vessels = (
        await pool.query(
          `SELECT DISTINCT tag FROM mesures WHERE tag LIKE $1 AND ts BETWEEN $2 AND $3`,
          [`${line}.%.temperature`, start, end],
        )
      ).rows;
      const deviations: Record<string, unknown>[] = [];
      for (const vr of vessels) {
        const tTag = vr.tag as string; // ex brasserie.ipa.fermenteur.temperature
        const base = tTag.slice(0, -".temperature".length);
        const vessel = base.slice(line.length + 1);
        const band = (
          await pool.query(
            `SELECT (SELECT avg(value) FROM mesures WHERE tag=$1 AND ts BETWEEN $3 AND $4) AS cible,
                    (SELECT avg(value) FROM mesures WHERE tag=$2 AND ts BETWEEN $3 AND $4) AS tol`,
            [`${base}.temp_cible`, `${base}.temp_tol`, start, end],
          )
        ).rows[0];
        const cible = band?.cible == null ? null : Number(band.cible);
        const tol = band?.tol == null ? null : Number(band.tol);
        if (cible == null || tol == null) {
          // Bande inconnue (ex. ancien batch sans temp_tol) : on rapporte l'observé brut.
          const st = (
            await pool.query(
              `SELECT min(value) AS mn, max(value) AS mx, avg(value) AS av FROM mesures
               WHERE tag=$1 AND ts BETWEEN $2 AND $3`,
              [tTag, start, end],
            )
          ).rows[0];
          deviations.push({
            vessel, nominal: null,
            observed: { min: round1(st.mn), max: round1(st.mx), avg: round1(st.av) },
            max_excess: null, pct_out_of_band: null,
          });
          continue;
        }
        // On EXCLUT le transitoire de chauffe : on ne mesure la déviation qu'à partir
        // du moment où la cuve est STABILISÉE PRÈS de sa cible (dans la demi-bande), pas
        // au simple bord de la bande — sinon le bruit, juste à l'entrée de bande pendant
        // la montée, génère un faux excès résiduel. Même logique que le « settled » du
        // cerveau (cf. simulator/factory/brain.py).
        const reg = (
          await pool.query(
            `SELECT min(ts) AS t0 FROM mesures
             WHERE tag=$1 AND ts BETWEEN $2 AND $3 AND value BETWEEN $4 AND $5`,
            [tTag, start, end, cible - 0.5 * tol, cible + 0.5 * tol],
          )
        ).rows[0];
        const t0 = reg?.t0 as Date | null; // null = cuve jamais entrée dans sa bande
        const st = (
          await pool.query(
            `SELECT min(value) AS mn, max(value) AS mx, avg(value) AS av,
                    count(*) FILTER (WHERE value > $4 OR value < $5) AS nout, count(*) AS n,
                    max(GREATEST(value-$4, $5-value, 0)) AS excess
             FROM mesures WHERE tag=$1 AND ts BETWEEN $2 AND $3`,
            [tTag, t0 ?? start, end, cible + tol, cible - tol],
          )
        ).rows[0];
        const n = Number(st.n) || 1;
        const pctOut = t0 == null ? null : Math.round((100 * Number(st.nout)) / n);
        // Booléen explicite (le modèle n'a pas à comparer des nombres) : hors bande
        // seulement si la déviation est SIGNIFICATIVE (>5% du temps), pas un effleurement
        // du seuil au bruit près.
        const outOfBand = t0 == null ? true : (pctOut ?? 0) >= 5;
        deviations.push({
          vessel,
          out_of_band: outOfBand,
          nominal: [round1(cible - tol), round1(cible + tol)],
          observed: { min: round1(st.mn), max: round1(st.mx), avg: round1(st.av) },
          max_excess: t0 == null ? null : st.excess == null ? 0 : round1(st.excess),
          pct_out_of_band: pctOut,
          never_reached_target: t0 == null ? true : undefined,
        });
      }
      const cuvesHorsBande = deviations.filter((d) => d.out_of_band).map((d) => d.vessel);

      const alarms = (
        await pool.query(
          `SELECT tag, severity, message, raised_at FROM alarms
           WHERE raised_at BETWEEN $2 AND $3 AND tag LIKE $1 ORDER BY raised_at LIMIT 50`,
          [`${line}.%`, start, end],
        )
      ).rows;
      const setpoints = (
        await pool.query(
          `SELECT tag, min(value) AS from_v, max(value) AS to_v FROM mesures
           WHERE tag LIKE $1 AND ts BETWEEN $2 AND $3 GROUP BY tag HAVING min(value) <> max(value)`,
          [`${line}.%.temp_cible`, start, end],
        )
      ).rows.map((r) => ({ tag: r.tag, from: round1(r.from_v), to: round1(r.to_v) }));
      const cipRow = (
        await pool.query(`SELECT min(value) AS m FROM mesures WHERE tag=$1 AND ts BETWEEN $2 AND $3`, [
          `${line}.cip_ok`,
          start,
          end,
        ])
      ).rows[0];
      const cipOk = cipRow?.m == null ? null : Number(cipRow.m) >= 1;

      return JSON.stringify({
        // Conclusion d'abord : le batch est-il conforme ? (qc_verdict='ok' => oui).
        conforme: b.qc_verdict === "ok",
        cuves_hors_bande: cuvesHorsBande, // [] = aucune déviation thermique
        batch: {
          id: b.id, recipe: b.recipe, line, started_at: b.started_at, ended_at: b.ended_at,
          status: b.status, qc_verdict: b.qc_verdict, defaut_type: b.defaut_type, rebut_pct: b.rebut_pct,
        },
        cip_ok: cipOk,
        deviations,
        alarms_during: alarms.map((a) => ({
          tag: a.tag, severity: a.severity, message: a.message, at: a.raised_at,
        })),
        setpoint_changes: setpoints,
      });
    }
    case "describe_schema": {
      // N'expose que ce que strata_ro peut lire (les grants = source de vérité).
      const { rows } = await pool.query(
        `SELECT c.table_name, c.column_name, c.data_type
         FROM information_schema.columns c
         WHERE c.table_schema = 'public'
           AND c.table_name IN (
             SELECT table_name FROM information_schema.role_table_grants
             WHERE grantee = 'strata_ro' AND privilege_type = 'SELECT' AND table_schema = 'public'
           )
         ORDER BY c.table_name, c.ordinal_position`,
      );
      const schema: Record<string, string[]> = {};
      for (const r of rows) (schema[r.table_name] ??= []).push(`${r.column_name}:${r.data_type}`);
      return JSON.stringify(schema);
    }
    case "query_readonly": {
      let sql = String(args.sql ?? "").trim().replace(/;+\s*$/, "");
      if (!sql) return JSON.stringify({ error: "sql requis" });
      if (sql.includes(";")) return JSON.stringify({ error: "une seule requête SELECT (pas de ';')" });
      // Bac à sable : rôle read-only + transaction READ ONLY + timeout + LIMIT.
      // (Un INSERT/UPDATE/DROP échoue de toute façon : rôle sans droit + READ ONLY,
      //  et le wrap en sous-requête n'accepte qu'un SELECT.)
      const client = await pool.connect();
      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        await client.query("SET LOCAL ROLE strata_ro");
        await client.query("SET LOCAL statement_timeout = '5000ms'");
        const { rows } = await client.query(`SELECT * FROM (${sql}) AS _sub LIMIT 500`);
        return JSON.stringify(rows);
      } catch (e) {
        return JSON.stringify({ error: (e as Error).message });
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    }
    case "search_knowledge": {
      const query = String(args.query ?? "").trim();
      if (!query) return JSON.stringify({ error: "query requis" });
      const vec = await embed(query);
      const { rows } = await pool.query(
        `SELECT category, title, body,
                1 - (embedding <=> $1::vector) AS score
         FROM knowledge
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT 5`,
        [`[${vec.join(",")}]`],
      );
      if (rows.length === 0) return JSON.stringify({ message: "Aucun document trouvé dans la base de connaissances." });
      return JSON.stringify(rows.map((r) => ({ category: r.category, title: r.title, body: r.body, score: Number(r.score).toFixed(3) })));
    }
    case "get_line_status": {
      const lineFilter = args.line ? String(args.line) : null;
      const lines = await pool.query(
        `SELECT line, label FROM oee_line WHERE enabled = true ${lineFilter ? "AND line = $1" : ""} ORDER BY line`,
        lineFilter ? [lineFilter] : [],
      );
      const result = await Promise.all(
        lines.rows.map(async (l) => {
          // Dernier état de chaque machine (state, en_attente, temperature)
          const { rows: tagRows } = await pool.query(
            `SELECT DISTINCT ON (tag) tag, value, ts
             FROM mesures
             WHERE tag LIKE $1 AND (tag LIKE '%.state' OR tag LIKE '%.en_attente' OR tag LIKE '%.temperature')
             ORDER BY tag, ts DESC`,
            [`${l.line}.%`],
          );
          // Machines distinctes (celles qui ont un .state)
          const machines: Record<string, Record<string, unknown>> = {};
          for (const r of tagRows) {
            const parts = r.tag.split(".");
            const machine = parts[2];
            const mesure = parts.slice(3).join(".");
            if (!machines[machine]) machines[machine] = {};
            if (mesure === "state") machines[machine].state = r.value === 1 ? "marche" : "arrêt";
            else if (mesure === "en_attente") machines[machine].en_attente = r.value === 1;
            else if (mesure === "temperature") machines[machine].temperature = Number(r.value).toFixed(1);
          }
          // Batch en cours
          const { rows: batchRows } = await pool.query(
            `SELECT id, recipe FROM batches WHERE line = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
            [l.line],
          );
          // Alarmes actives
          const { rows: alarmRows } = await pool.query(
            `SELECT count(*)::int AS n FROM alarms WHERE tag LIKE $1 AND (state='active' OR (state='cleared' AND acked=false))`,
            [`${l.line}.%`],
          );
          // Statut synthétique par machine (marche/attente/arrêt)
          const machineList = Object.entries(machines).map(([name, m]) => ({
            name,
            etat: m.en_attente ? "attente" : m.state,
            temperature: m.temperature ?? null,
          }));
          return {
            line: l.line,
            label: l.label,
            machines: machineList,
            batch_en_cours: batchRows[0]?.id ?? null,
            alarmes_non_acquittees: alarmRows[0]?.n ?? 0,
          };
        }),
      );
      return JSON.stringify(result);
    }
    case "get_shift_summary": {
      const { rows: oeeRows } = await pool.query(
        `SELECT line, line_label, shift_label, ok, produced, oee, availability, performance, quality,
                target_oee, target_pieces, is_current
         FROM oee_by_shift WHERE is_current = true ORDER BY line`,
      );
      const { rows: batchRows } = await pool.query(
        `SELECT id, recipe, line, started_at FROM batches WHERE ended_at IS NULL ORDER BY started_at DESC`,
      );
      const { rows: alarmRows } = await pool.query(
        `SELECT count(*)::int AS n FROM alarms WHERE state='active' OR (state='cleared' AND acked=false)`,
      );
      return JSON.stringify({
        shift: oeeRows[0]?.shift_label ?? "inconnu",
        lignes: oeeRows.map((r) => ({
          line: r.line,
          label: r.line_label,
          oee: r.oee != null ? Number(r.oee).toFixed(3) : null,
          disponibilite: r.availability != null ? Number(r.availability).toFixed(3) : null,
          performance: r.performance != null ? Number(r.performance).toFixed(3) : null,
          qualite: r.quality != null ? Number(r.quality).toFixed(3) : null,
          ok: r.ok,
          produit: r.produced,
          objectif_pieces: r.target_pieces,
          objectif_oee: r.target_oee,
        })),
        batches_en_cours: batchRows.map((r) => ({ id: r.id, recipe: r.recipe, line: r.line })),
        alarmes_non_acquittees: alarmRows[0]?.n ?? 0,
      });
    }
    case "get_oee_breakdown": {
      const days = Math.min(Number(args.days ?? 1) || 1, 30);
      const lineFilter = args.line ? String(args.line) : null;
      const { rows: oeeRows } = await pool.query(
        `SELECT line, line_label, day, shift_label, ok, produced,
                availability, performance, quality, oee,
                target_oee, on_track
         FROM oee_by_shift
         WHERE day > (now() - ($1 || ' days')::interval)::date
           ${lineFilter ? "AND line = $2" : ""}
         ORDER BY line, day DESC, shift_label`,
        lineFilter ? [days, lineFilter] : [days],
      );
      const { rows: lossRows } = await pool.query(
        `SELECT line, reason_code, reason_label, kind, sum(minutes)::int AS minutes_perdues
         FROM oee_downtime_by_shift
         WHERE day > (now() - ($1 || ' days')::interval)::date
           ${lineFilter ? "AND line = $2" : ""}
         GROUP BY line, reason_code, reason_label, kind
         ORDER BY line, minutes_perdues DESC`,
        lineFilter ? [days, lineFilter] : [days],
      );
      const lossByLine: Record<string, typeof lossRows> = {};
      for (const r of lossRows) (lossByLine[r.line] ??= []).push(r);

      // Agrégation par ligne
      const byLine: Record<string, { shifts: typeof oeeRows; pertes: typeof lossRows }> = {};
      for (const r of oeeRows) (byLine[r.line] ??= { shifts: [], pertes: [] }).shifts.push(r);
      for (const [line, pertes] of Object.entries(lossByLine)) {
        if (byLine[line]) byLine[line].pertes = pertes;
      }
      const summary = Object.entries(byLine).map(([line, d]) => {
        const last = d.shifts[0];
        return {
          line,
          label: last?.line_label,
          oee: last?.oee != null ? Number(last.oee).toFixed(3) : null,
          disponibilite: last?.availability != null ? Number(last.availability).toFixed(3) : null,
          performance: last?.performance != null ? Number(last.performance).toFixed(3) : null,
          qualite: last?.quality != null ? Number(last.quality).toFixed(3) : null,
          objectif_oee: last?.target_oee,
          principales_pertes: d.pertes.slice(0, 5).map((p) => ({
            raison: p.reason_label ?? p.reason_code,
            type: p.kind,
            minutes: p.minutes_perdues,
          })),
        };
      });
      return JSON.stringify(summary);
    }
    case "get_active_batches": {
      const { rows } = await pool.query(
        `SELECT id, recipe, line,
                started_at,
                EXTRACT(EPOCH FROM (now() - started_at)) / 3600 AS duree_heures,
                defaut_type, conforme
         FROM batches
         WHERE ended_at IS NULL
         ORDER BY started_at DESC`,
      );
      if (rows.length === 0) return JSON.stringify({ message: "Aucun batch en cours." });
      return JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          recipe: r.recipe,
          line: r.line,
          duree_heures: Number(r.duree_heures).toFixed(1),
          defaut_type: r.defaut_type ?? null,
          conforme: r.conforme,
        })),
      );
    }
    default:
      return JSON.stringify({ error: `tool inconnu: ${name}` });
  }
}

const SYSTEM_PROMPT_STATIC =
  "Tu es l'assistant de Strata, une plateforme de supervision de données industrielles. " +
  "Réponds en français, de façon concise et PRÉCISE : réponds exactement à la question posée, sans analyse, résumé ni " +
  "recommandations non demandés. Si on demande une seule chose (la dernière alarme, un chiffre…), " +
  "donne juste ça. Pour toute donnée chiffrée (OEE, production, alarmes, mesures), utilise TOUJOURS les " +
  "tools — n'invente jamais de valeurs. Si une donnée n'est pas disponible via un tool, dis-le. " +
  "Pour DIAGNOSTIQUER un batch (pourquoi un brassage est raté / hors spec, qu'est-ce qui a dévié), le " +
  "dossier vient de get_batch_context (déjà appelé pour toi si la question porte sur ce batch — sinon " +
  "appelle-le toi-même). Ne réutilise JAMAIS des données de batch mentionnées plus haut dans la " +
  "conversation : elles concernent un AUTRE batch. COMMENCE par le champ `conforme` : s'il est vrai (verdict 'ok'), le " +
  "batch est CONFORME — dis-le clairement et N'INVENTE PAS de défaut, même si la question suppose un " +
  "problème. Si non conforme, le DÉFAUT est donné par `defaut_type` (c'est LE résultat QC) : énonce-le, " +
  "puis EXPLIQUE-le avec `cip_ok` (faux => contamination/sanitation) et `cuves_hors_bande` (cuves en " +
  "déviation thermique). Une cuve n'est hors bande QUE si elle figure dans `cuves_hors_bande` (liste vide " +
  "= aucune déviation thermique, n'accuse alors AUCUNE cuve) ; ne déduis jamais une déviation toi-même en " +
  "comparant des nombres. " +
  "Pour toute question commençant par 'comment', 'que faire', 'quoi faire', 'comment réagir', 'comment débloquer', " +
  "'quelle procédure', ou demandant une recommandation / un plan d'action : appelle search_knowledge EN PREMIER " +
  "avec la description du problème. Ne commence PAS par investiguer les tags ou les alarmes — la connaissance " +
  "procédurale est dans search_knowledge. Tu peux ensuite compléter avec les données en temps réel si nécessaire. " +
  "Pour investiguer l'état d'une machine ou diagnostiquer un problème opérationnel, enchaîne librement " +
  "les tools : list_alarms (alarmes actives/non acquittées), get_history (tendance d'un tag), " +
  "describe_schema + query_readonly (SQL libre en lecture seule). " +
  "Pour AGIR (écrire une consigne, acquitter une alarme), utilise set_command / ack_alarm UNIQUEMENT " +
  "si l'opérateur demande explicitement d'effectuer une action — jamais pour répondre à une question " +
  "sur la procédure à suivre. Ces actions sont des PROPOSITIONS soumises à confirmation humaine.";

async function buildFactoryContext(pool: pg.Pool): Promise<{ text: string; recipes: string[] }> {
  const [lines, machines, recipes] = await Promise.all([
    pool.query("SELECT line, label, ideal_rate FROM oee_line WHERE enabled = true ORDER BY line"),
    pool.query(`
      SELECT split_part(name,'.', 1)||'.'||split_part(name,'.', 2) AS line,
             split_part(name, '.', 3) AS machine
      FROM tags
      WHERE enabled = true
        AND array_length(string_to_array(name, '.'), 1) = 4
        AND split_part(name, '.', 4) = 'state'
      ORDER BY 1, 2`),
    pool.query("SELECT DISTINCT recipe FROM batches ORDER BY recipe"),
  ]);

  const machinesByLine = new Map<string, string[]>();
  for (const r of machines.rows) {
    if (!machinesByLine.has(r.line)) machinesByLine.set(r.line, []);
    machinesByLine.get(r.line)!.push(r.machine);
  }

  const linesText = lines.rows
    .map((r) => {
      const machs = (machinesByLine.get(r.line) ?? []).join(", ");
      return `  • ${r.line} (${r.label}, cadence ${r.ideal_rate} pièces/min) — machines : ${machs}`;
    })
    .join("\n");

  const recipeNames = recipes.rows.map((r) => r.recipe as string);
  const recipesText = recipeNames.join(", ");

  const text =
    "CONTEXTE USINE (extrait dynamiquement de la base) :\n" +
    "Lignes actives :\n" + linesText + "\n" +
    "Recettes connues : " + recipesText + "\n" +
    "Convention tags : <site>.<ligne>.<machine>.<mesure>\n" +
    "États machines : <machine>.state → 0=arrêt, 1=marche ; <machine>.en_attente → 1=bloqué amont\n" +
    "Pour connaître les tags exacts d'une machine, utilise describe_schema ou query_readonly sur la table `tags`.";

  return { text, recipes: recipeNames };
}

const BATCH_DIAG_VERBS = /\b(pourquoi|diagnosti\w*|analyse\w*|explique\w*|cause)\b/i;
const BATCH_WORDS = /\b(batch|brassage|lot)\b/i;
const BATCH_ID_RE = /\b[a-z]+-[0-9a-f-]{6,}\b/i;
// Une recette ("ipa", "blonde"...) est AUSSI un nom de ligne (`brasserie.blonde`) : la
// mention seule ne suffit pas à distinguer « pourquoi la ligne blonde est arrêtée » (état
// machine, pas un batch) de « pourquoi le dernier ipa est hors spec » (batch). On exige donc
// en plus un mot-clé de verdict qualité.
const QC_WORDS = /\b(hors spec|conforme|contamin\w*|d[ée]faut|rebut|qualit[ée]|rat[ée]\w*|nok)\b/i;

/**
 * Détecte un diagnostic de batch et renvoie le batch_ref à transmettre à
 * get_batch_context : l'id extrait s'il y en a un, sinon le message brut (dont la
 * résolution par sous-chaîne de recette, cf. get_batch_context, s'occupe déjà —
 * pas besoin d'un extracteur d'entité séparé).
 */
function detectBatchDiagnostic(text: string, recipes: string[]): string | null {
  if (!BATCH_DIAG_VERBS.test(text)) return null;
  const idMatch = text.match(BATCH_ID_RE);
  const hasRecipe = recipes.some((r) => text.toLowerCase().includes(r.toLowerCase()));
  if (!idMatch && !BATCH_WORDS.test(text) && !(hasRecipe && QC_WORDS.test(text))) return null;
  return idMatch ? idMatch[0] : text;
}

/**
 * Construit la requête search_knowledge à partir du défaut RÉEL du dossier batch
 * (jamais d'une déviation supposée) : null si le batch est conforme ou en erreur.
 */
function buildKnowledgeQuery(ctx: Record<string, unknown>): string | null {
  if (ctx.error || ctx.conforme) return null;
  const batch = (ctx.batch as Record<string, unknown>) ?? {};
  const parts: string[] = [];
  if (batch.defaut_type) parts.push(String(batch.defaut_type));
  if (ctx.cip_ok === false) parts.push("contamination sanitation CIP");
  const cuves = (ctx.cuves_hors_bande as string[] | undefined) ?? [];
  if (cuves.length) parts.push(`déviation thermique ${cuves.join(", ")}`);
  if (!parts.length) return null;
  return `${batch.recipe ?? ""} ${parts.join(" ")}`.trim();
}

/** Boucle d'agent : appelle le LLM, exécute les tools demandés, jusqu'à la réponse. */
function agentLog(runId: string, event: Record<string, unknown>) {
  console.log(JSON.stringify({ agent: true, run: runId, ...event }));
}

export type AgentEvent =
  | { type: "tool_call"; step: number; name: string }
  | { type: "tool_result"; step: number; name: string; ms: number; result_bytes: number }
  | { type: "answer"; answer: string; steps: number; total_ms: number };

export async function runAssistant(
  pool: pg.Pool,
  user: AuthUser | null,
  history: ChatMessage[],
  onEvent?: (e: AgentEvent) => void,
): Promise<{ answer?: string; pendingAction?: PendingAction; steps: number }> {
  const username = user?.username ?? "anonymous";
  const runId = randomUUID().slice(0, 8);
  const t0 = Date.now();

  const userMsg = history.filter((m) => m.role === "user").at(-1)?.content ?? "";
  agentLog(runId, { event: "start", user: username, history_turns: history.length, question: userMsg.slice(0, 120) });

  const { text: factoryContext, recipes: knownRecipes } = await buildFactoryContext(pool).catch(
    () => ({ text: "", recipes: [] as string[] }),
  );
  const systemPrompt = factoryContext
    ? `${SYSTEM_PROMPT_STATIC}\n\n${factoryContext}`
    : SYSTEM_PROMPT_STATIC;

  // Nettoie l'historique reçu du front (persistance) : on ne garde que des tours
  // user/assistant à contenu non vide, on borne la longueur. Évite qu'un message
  // mal formé (ex. contenu vide d'une ancienne proposition) ne fasse planter Ollama.
  const clean = history
    .filter(
      (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim() !== "",
    )
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [{ role: "system", content: systemPrompt }, ...clean];

  // Phases forcées (hypothèses → preuves) pour un diagnostic de batch : on ne
  // laisse pas le modèle décider seul de récupérer le dossier ni les preuves
  // corrélées — c'est le harness qui garantit la séquence, pas le prompt.
  // cf. docs/assistant-roadmap.md §2 (routing + boucle RCA orchestrée).
  let preSteps = 0;
  const batchRef = detectBatchDiagnostic(userMsg, knownRecipes);
  if (batchRef) {
    const forced = async (name: string, args: Args): Promise<string> => {
      onEvent?.({ type: "tool_call", step: preSteps, name });
      const t = Date.now();
      const result = await execTool(pool, user, name, args);
      const ms = Date.now() - t;
      agentLog(runId, { event: "tool", step: preSteps, name, args, result_bytes: result.length, ms, forced: true });
      onEvent?.({ type: "tool_result", step: preSteps, name, ms, result_bytes: result.length });
      messages.push({
        role: "assistant",
        content: "",
        // Ollama /api/chat attend `arguments` comme un OBJET (pas une string JSON) —
        // c'est le format qu'il renvoie lui-même pour les tool_calls du modèle.
        tool_calls: [{ function: { name, arguments: args } }],
      });
      messages.push({ role: "tool", content: result });
      preSteps++;
      return result;
    };
    const ctxRaw = await forced("get_batch_context", { batch_ref: batchRef });
    const ctx = JSON.parse(ctxRaw) as Record<string, unknown>;
    const query = buildKnowledgeQuery(ctx);
    if (query) await forced("search_knowledge", { query });
  }

  for (let step = preSteps; step < MAX_STEPS; step++) {
    // API NATIVE Ollama (/api/chat) : elle honore `num_ctx` (l'endpoint /v1 compatible
    // OpenAI l'ignore → contexte resté à ~2048, d'où les troncatures). qwen2.5 va
    // jusqu'à 32k ; 8192 suffit largement pour prompt + tools + résultats.
    const tLlm = Date.now();
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools: TOOLS,
        stream: false,
        options: { num_ctx: 8192, temperature: 0.2 },
      }),
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const data = (await resp.json()) as { message?: ChatMessage };
    const msg = data.message;
    if (!msg) throw new Error("réponse LLM vide");
    agentLog(runId, { event: "llm", step, ms: Date.now() - tLlm, tools_requested: msg.tool_calls?.map((tc: { function?: { name?: string } }) => tc.function?.name) ?? null });

    if (msg.tool_calls?.length) {
      // Action d'écriture demandée ? On INTERCEPTE la 1ère : aucune exécution, on
      // renvoie une proposition à CONFIRMER par l'humain (cf. /api/assistant/confirm).
      const writeCall = msg.tool_calls.find((tc: { function?: { name?: string } }) =>
        WRITE_TOOLS.has(tc.function?.name ?? ""),
      );
      if (writeCall) {
        const wargs = toArgs(writeCall.function?.arguments);
        const pendingAction = await addPending(pool, username, writeCall.function?.name ?? "", wargs);
        agentLog(runId, { event: "done", steps: step + 1, ms: Date.now() - t0, outcome: "write_intercepted", tool: writeCall.function?.name });
        return {
          answer: `Je propose d'${pendingAction.summary} — à confirmer pour exécuter.`,
          pendingAction,
          steps: step,
        };
      }
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        const name = tc.function?.name ?? "";
        const args = toArgs(tc.function?.arguments);
        onEvent?.({ type: "tool_call", step, name });
        const tTool = Date.now();
        let result: string;
        try {
          result = await execTool(pool, user, name, args);
        } catch (e) {
          result = JSON.stringify({ error: (e as Error).message });
        }
        const toolMs = Date.now() - tTool;
        agentLog(runId, { event: "tool", step, name, args, result_bytes: result.length, ms: toolMs });
        onEvent?.({ type: "tool_result", step, name, ms: toolMs, result_bytes: result.length });
        messages.push({ role: "tool", content: result });
      }
      continue;
    }
    const answer = msg.content?.trim() || "(je n'ai pas su formuler de réponse — peux-tu reformuler ?)";
    const total_ms = Date.now() - t0;
    agentLog(runId, { event: "done", steps: step + 1, ms: total_ms, outcome: "answer", answer_chars: answer.length });
    onEvent?.({ type: "answer", answer, steps: step + 1, total_ms });
    return { answer, steps: step };
  }
  const answer = "(j'ai atteint la limite d'étapes ; reformule peut-être ta question)";
  const total_ms = Date.now() - t0;
  agentLog(runId, { event: "done", steps: MAX_STEPS, ms: total_ms, outcome: "max_steps" });
  onEvent?.({ type: "answer", answer, steps: MAX_STEPS, total_ms });
  return { answer, steps: MAX_STEPS };
}

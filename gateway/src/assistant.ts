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
const MODEL = process.env.ASSISTANT_MODEL ?? "qwen2.5:3b";
const MAX_STEPS = 6;

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
      description: "Alarmes actuellement actives (tag, sévérité, message, depuis quand).",
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
        `SELECT id, tag, severity, message, acked, raised_at FROM alarms
         WHERE state='active' ORDER BY raised_at DESC LIMIT 50`,
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
    default:
      return JSON.stringify({ error: `tool inconnu: ${name}` });
  }
}

const SYSTEM_PROMPT =
  "Tu es l'assistant de Strata, une plateforme de supervision de données industrielles " +
  "(démo : une micro-brasserie avec 2 lignes, blonde et ipa). Réponds en français, de façon " +
  "concise et PRÉCISE : réponds exactement à la question posée, sans analyse, résumé ni " +
  "recommandations non demandés. Si on demande une seule chose (la dernière alarme, un chiffre…), " +
  "donne juste ça. Pour toute donnée chiffrée (OEE, production, alarmes, mesures), utilise TOUJOURS les " +
  "tools — n'invente jamais de valeurs. Si une donnée n'est pas disponible via un tool, dis-le. " +
  "Pour une question non couverte par get_oee/get_production/list_alarms/get_history, utilise " +
  "describe_schema (pour voir les tables/colonnes) puis query_readonly avec un SELECT PostgreSQL " +
  "en lecture seule (un seul SELECT, sans point-virgule). " +
  "Pour AGIR (écrire une consigne, acquitter une alarme), utilise set_command / ack_alarm : " +
  "ce sont des PROPOSITIONS soumises à confirmation humaine — tu n'exécutes jamais directement.";

/** Boucle d'agent : appelle le LLM, exécute les tools demandés, jusqu'à la réponse. */
export async function runAssistant(
  pool: pg.Pool,
  user: AuthUser | null,
  history: ChatMessage[],
): Promise<{ answer?: string; pendingAction?: PendingAction; steps: number }> {
  const username = user?.username ?? "anonymous";
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
  const messages: any[] = [{ role: "system", content: SYSTEM_PROMPT }, ...clean];

  for (let step = 0; step < MAX_STEPS; step++) {
    // API NATIVE Ollama (/api/chat) : elle honore `num_ctx` (l'endpoint /v1 compatible
    // OpenAI l'ignore → contexte resté à ~2048, d'où les troncatures). qwen2.5 va
    // jusqu'à 32k ; 8192 suffit largement pour prompt + tools + résultats.
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

    if (msg.tool_calls?.length) {
      // Action d'écriture demandée ? On INTERCEPTE la 1ère : aucune exécution, on
      // renvoie une proposition à CONFIRMER par l'humain (cf. /api/assistant/confirm).
      const writeCall = msg.tool_calls.find((tc: { function?: { name?: string } }) =>
        WRITE_TOOLS.has(tc.function?.name ?? ""),
      );
      if (writeCall) {
        const wargs = toArgs(writeCall.function?.arguments);
        const pendingAction = await addPending(pool, username, writeCall.function?.name ?? "", wargs);
        // On renvoie AUSSI un texte : un front qui ne gère pas encore pendingAction
        // affiche au moins la proposition (au lieu d'un message vide).
        return {
          answer: `Je propose d'${pendingAction.summary} — à confirmer pour exécuter.`,
          pendingAction,
          steps: step,
        };
      }
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        const args = toArgs(tc.function?.arguments);
        let result: string;
        try {
          result = await execTool(pool, user, tc.function?.name, args);
        } catch (e) {
          result = JSON.stringify({ error: (e as Error).message });
        }
        // API native Ollama : message tool = { role, content } (pas de tool_call_id).
        messages.push({ role: "tool", content: result });
      }
      continue;
    }
    return { answer: msg.content?.trim() || "(je n'ai pas su formuler de réponse — peux-tu reformuler ?)", steps: step };
  }
  return { answer: "(j'ai atteint la limite d'étapes ; reformule peut-être ta question)", steps: MAX_STEPS };
}

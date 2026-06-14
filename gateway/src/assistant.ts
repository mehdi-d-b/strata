/**
 * Assistant IA local (Chemin B). Boucle d'agent contre un runtime LLM open-source
 * compatible OpenAI (Ollama, 100 % local). Cf. docs/llm-integration.md.
 *
 * Règle d'or : le LLM ne peut RIEN exécuter — il émet des *demandes* de tool, et
 * c'est CE code qui exécute des tools de LECTURE via la base (jamais d'accès direct
 * pour le modèle). Les tools tournent avec le contexte de l'utilisateur connecté.
 */
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
      description: "Résumé de l'historique d'un tag sur les N dernières minutes : dernière valeur, min, max, moyenne (valeurs scalées).",
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
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

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
        `SELECT tag, severity, message, raised_at FROM alarms
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
      const { rows } = await pool.query(
        `SELECT min(value) AS mn, max(value) AS mx, avg(value) AS av, count(*) AS n,
                (SELECT value FROM mesures WHERE tag=$1 ORDER BY ts DESC LIMIT 1) AS last_raw
         FROM mesures WHERE tag=$1 AND ts > now() - ($2 || ' minutes')::interval`,
        [tag, minutes],
      );
      const r = rows[0];
      const scale = (v: unknown) => (v == null ? null : Number(v) * s + o);
      return JSON.stringify({
        tag, minutes, samples: Number(r.n),
        last: scale(r.last_raw), min: scale(r.mn), max: scale(r.mx), avg: scale(r.av),
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
    default:
      return JSON.stringify({ error: `tool inconnu: ${name}` });
  }
}

const SYSTEM_PROMPT =
  "Tu es l'assistant de Strata, une plateforme de supervision de données industrielles " +
  "(démo : une micro-brasserie avec 2 lignes, blonde et ipa). Réponds en français, de façon " +
  "concise. Pour toute donnée chiffrée (OEE, production, alarmes, mesures), utilise TOUJOURS les " +
  "tools — n'invente jamais de valeurs. Si une donnée n'est pas disponible via un tool, dis-le. " +
  "Pour une question non couverte par get_oee/get_production/list_alarms/get_history, utilise " +
  "describe_schema (pour voir les tables/colonnes) puis query_readonly avec un SELECT PostgreSQL " +
  "en lecture seule (un seul SELECT, sans point-virgule).";

/** Boucle d'agent : appelle le LLM, exécute les tools demandés, jusqu'à la réponse. */
export async function runAssistant(
  pool: pg.Pool,
  user: AuthUser | null,
  history: ChatMessage[],
): Promise<{ answer: string; steps: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history];

  for (let step = 0; step < MAX_STEPS; step++) {
    const resp = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        stream: false,
        temperature: 0.2,
        // Contexte par défaut d'Ollama = 2048 tokens : trop court dès qu'un tool
        // renvoie un gros résultat (ex. describe_schema) → on l'agrandit.
        options: { num_ctx: 8192 },
      }),
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const data = (await resp.json()) as {
      choices?: { message?: ChatMessage }[];
    };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("réponse LLM vide");

    if (msg.tool_calls?.length) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        let args: Args = {};
        try {
          args = JSON.parse(tc.function?.arguments || "{}");
        } catch {
          /* arguments non-JSON : on passe un objet vide */
        }
        let result: string;
        try {
          result = await execTool(pool, user, tc.function?.name, args);
        } catch (e) {
          result = JSON.stringify({ error: (e as Error).message });
        }
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function?.name, content: result });
      }
      continue;
    }
    return { answer: msg.content ?? "", steps: step };
  }
  return { answer: "(j'ai atteint la limite d'étapes ; reformule peut-être ta question)", steps: MAX_STEPS };
}

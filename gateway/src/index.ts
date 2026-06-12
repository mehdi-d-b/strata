/**
 * Gateway temps réel Strata.
 *
 *  - WS  /ws              : pousse en direct chaque mesure de `tags.raw` (scaling appliqué).
 *  - GET  /api/history    : historique d'un tag depuis TimescaleDB (scaling appliqué).
 *  - GET  /api/tags       : liste des tags configurés (métadonnées).
 *  - POST /api/tags       : crée/met à jour un tag (upsert).
 *  - DELETE /api/tags/:name : supprime la config d'un tag.
 *  - GET  /health         : sonde de vie.
 *
 * Principe : la valeur stockée dans `mesures` est TOUJOURS brute. Le scaling
 * (value * scale + offset) est appliqué À LA LECTURE, ici, à partir de la
 * table `tags`. Corriger une échelle répare donc tout l'historique d'un coup.
 */
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { Kafka, logLevel } from "kafkajs";
import pg from "pg";
import {
  can,
  clearSessionCookie,
  createSession,
  destroySession,
  hashPassword,
  isAdmin,
  loadUserFromSession,
  readSessionCookie,
  setSessionCookie,
  verifyPassword,
  type AuthUser,
} from "./auth.js";
import { deployDevice, undeployDevice } from "./plc4x.js";
import { AlarmEngine } from "./alarms.js";
import { runAssistant, type ChatMessage } from "./assistant.js";

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "redpanda:9092").split(",");
const PG_DSN =
  process.env.PG_DSN ?? "postgres://strata:strata@timescaledb:5432/strata";
const PORT = Number(process.env.PORT ?? 3001);

// --- Postgres --------------------------------------------------------------
const pool = new pg.Pool({ connectionString: PG_DSN });

// --- Kafka/Redpanda : un client partagé (consumer fan-out + producer commandes) ---
const kafka = new Kafka({
  clientId: "strata-gateway",
  brokers: KAFKA_BROKERS,
  logLevel: logLevel.WARN,
});

// Producer pour publier les consignes d'écriture sur le topic `tags.cmd`.
// Connecté paresseusement à la première commande.
const producer = kafka.producer();
let producerReady = false;
async function publishCommand(tag: string, value: number, source: string) {
  if (!producerReady) {
    await producer.connect();
    producerReady = true;
  }
  await producer.send({
    topic: "tags.cmd",
    messages: [
      {
        key: tag,
        value: JSON.stringify({ tag, value, ts: new Date().toISOString(), source }),
      },
    ],
  });
}

type TagConfig = {
  name: string;
  label: string | null;
  unit: string | null;
  scale: number;
  offset: number;
  enabled: boolean;
  description: string | null;
};

// Cache en mémoire de la config des tags, pour appliquer le scaling au fil de
// l'eau (temps réel) sans requête SQL par message. Rafraîchi périodiquement et
// après chaque écriture.
const tagCache = new Map<string, TagConfig>();

async function refreshTagCache() {
  const { rows } = await pool.query(
    `SELECT name, label, unit, scale, offset_val AS offset, enabled, description
     FROM tags`,
  );
  tagCache.clear();
  for (const r of rows) {
    tagCache.set(r.name, {
      ...r,
      scale: Number(r.scale),
      offset: Number(r.offset),
    });
  }
}

/** Applique scale/offset si le tag est configuré, sinon renvoie la valeur brute. */
function scaled(name: string, raw: number): number {
  const cfg = tagCache.get(name);
  if (!cfg) return raw;
  return raw * cfg.scale + cfg.offset;
}

/**
 * Démo : assigne un rôle de production aux compteurs connus de la brasserie, à la
 * découverte du tag. Sans ça, Production ET OEE n'ont aucun rôle tant qu'on ne les
 * pose pas à la main — et l'init SQL ne peut pas (FK vers des tags pas encore créés).
 * Non destructif : ne touche pas un tag qui a déjà un rôle (respecte la config manuelle).
 */
async function seedDemoRole(name: string) {
  let role: string | null = null;
  if (name.endsWith(".bouteilles_ok")) role = "ok";
  else if (name.endsWith(".bouteilles_rebut")) role = "scrap";
  if (!role) return;
  await pool.query(
    `INSERT INTO tag_role (tag_name, role)
     SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM tag_role WHERE tag_name = $1)`,
    [name, role],
  );
}

/**
 * Backfill démo : pose les rôles ok/scrap sur les compteurs brasserie DÉJÀ
 * découverts (l'auto-seed à la découverte ne couvre que les tags nouveaux ; sur un
 * volume existant les tags sont déjà connus). Non destructif. Désactivable via
 * SEED_DEMO_ROLES=0.
 */
async function seedDemoRoles() {
  if (process.env.SEED_DEMO_ROLES === "0") return;
  await pool.query(
    `INSERT INTO tag_role (tag_name, role)
     SELECT t.name,
            CASE WHEN t.name LIKE '%.bouteilles_ok' THEN 'ok' ELSE 'scrap' END
     FROM tags t
     WHERE (t.name LIKE '%.bouteilles_ok' OR t.name LIKE '%.bouteilles_rebut')
       AND NOT EXISTS (SELECT 1 FROM tag_role r WHERE r.tag_name = t.name)`,
  );
}

/** Crée une ligne `tags` par défaut pour un tag jamais vu (auto-découverte). */
async function ensureTagExists(name: string) {
  if (tagCache.has(name)) return;
  await pool.query(
    `INSERT INTO tags (name, label) VALUES ($1, $1)
     ON CONFLICT (name) DO NOTHING`,
    [name],
  );
  await seedDemoRole(name);
  await refreshTagCache();
}

// --- Fastify ---------------------------------------------------------------
const app = Fastify({ logger: true });
await app.register(websocket);

/** Connexions WS actives, chacune liée à son utilisateur (pour le filtrage RBAC). */
const clients = new Map<import("ws").WebSocket, AuthUser>();

app.get("/health", async () => ({ status: "ok" }));

// ─── Authentification (Phase 7) ───────────────────────────────────────────

/** Trace une action sensible dans l'audit. */
async function audit(
  username: string | null,
  action: string,
  target: string | null = null,
  detail: unknown = null,
): Promise<void> {
  await pool.query(
    "INSERT INTO audit_log (username, action, target, detail) VALUES ($1,$2,$3,$4)",
    [username, action, target, detail ? JSON.stringify(detail) : null],
  );
}

// Moteur d'alarmes (détection de seuils sur tags.raw). Démarré dans main().
const alarmEngine = new AlarmEngine(pool, audit);

// Sur chaque requête : résout l'utilisateur courant depuis le cookie de session.
app.addHook("preHandler", async (req) => {
  req.user = null;
  const sid = readSessionCookie(req);
  if (sid) {
    try {
      req.user = await loadUserFromSession(pool, sid);
    } catch {
      req.user = null;
    }
  }
});

/** preHandler : exige un utilisateur connecté. */
async function requireAuth(req: { user: AuthUser | null }, reply: import("fastify").FastifyReply) {
  if (!req.user) return reply.code(401).send({ error: "non authentifié" });
}

/** preHandler : exige un administrateur. */
async function requireAdmin(req: { user: AuthUser | null }, reply: import("fastify").FastifyReply) {
  if (!req.user) return reply.code(401).send({ error: "non authentifié" });
  if (!isAdmin(req.user)) return reply.code(403).send({ error: "réservé aux admins" });
}

app.post("/api/auth/login", async (req, reply) => {
  const b = req.body as { username?: string; password?: string };
  if (!b.username || !b.password)
    return reply.code(400).send({ error: "username et password requis" });
  const { rows } = await pool.query(
    "SELECT id, password_hash FROM users WHERE username = $1 AND enabled",
    [b.username],
  );
  const ok = rows.length > 0 && (await verifyPassword(b.password, rows[0].password_hash));
  if (!ok) {
    await audit(b.username, "login.fail");
    return reply.code(401).send({ error: "identifiants invalides" });
  }
  const sid = await createSession(pool, rows[0].id);
  setSessionCookie(reply, sid);
  await audit(b.username, "login.ok");
  return loadUserFromSession(pool, sid);
});

app.post("/api/auth/logout", async (req, reply) => {
  const sid = readSessionCookie(req);
  if (sid) await destroySession(pool, sid);
  clearSessionCookie(reply);
  return { ok: true };
});

// Qui suis-je ? (le front l'appelle au chargement pour connaître l'état de session)
app.get("/api/auth/me", async (req) => {
  return req.user ?? null;
});

// Changer SON PROPRE mot de passe (tout utilisateur connecté).
app.post("/api/auth/password", { preHandler: requireAuth }, async (req, reply) => {
  const b = req.body as { current?: string; next?: string };
  if (!b.current || !b.next || b.next.length < 4)
    return reply.code(400).send({ error: "mot de passe actuel et nouveau (≥4) requis" });
  const { rows } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [
    req.user!.id,
  ]);
  if (rows.length === 0 || !(await verifyPassword(b.current, rows[0].password_hash)))
    return reply.code(403).send({ error: "mot de passe actuel incorrect" });
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [
    await hashPassword(b.next),
    req.user!.id,
  ]);
  await audit(req.user!.username, "self.password");
  return { ok: true };
});

// ─── Paramètres : Stockage (Timescale) — admin only ───────────────────────
// Garde-fou : aucun SQL arbitraire. On lit l'état et on (re)pose des policies
// bornées via les fonctions Timescale.

// État du stockage : taille de l'hypertable, compression, policies actives.
app.get("/api/storage", { preHandler: requireAdmin }, async () => {
  const size = await pool.query(
    `SELECT
       pg_size_pretty(hypertable_size('mesures')) AS total,
       (SELECT count(*) FROM mesures)::bigint AS rows`,
  );
  // Détail compression (avant/après) si disponible.
  const comp = await pool.query(
    `SELECT
       pg_size_pretty(sum(before_compression_total_bytes))  AS before,
       pg_size_pretty(sum(after_compression_total_bytes))   AS after,
       sum(before_compression_total_bytes)::bigint          AS before_b,
       sum(after_compression_total_bytes)::bigint           AS after_b
     FROM chunk_compression_stats('mesures')`,
  );
  const policies = await pool.query(
    `SELECT proc_name, config FROM timescaledb_information.jobs
     WHERE hypertable_name = 'mesures' AND proc_name LIKE 'policy_%'`,
  );
  const pol: Record<string, unknown> = {};
  for (const r of policies.rows) {
    if (r.proc_name === "policy_retention") pol.retention = r.config?.drop_after;
    if (r.proc_name === "policy_compression") pol.compression = r.config?.compress_after;
  }
  return {
    size: size.rows[0],
    compression: comp.rows[0],
    retention_after: pol.retention ?? null,
    compress_after: pol.compression ?? null,
  };
});

// Met à jour la rétention (jours). 0 = désactive la purge.
app.post("/api/storage/retention", { preHandler: requireAdmin }, async (req, reply) => {
  const b = req.body as { days?: number };
  const days = Number(b.days);
  if (!Number.isFinite(days) || days < 0 || days > 3650)
    return reply.code(400).send({ error: "days doit être entre 0 et 3650" });
  await pool.query("SELECT remove_retention_policy('mesures', if_exists => true)");
  if (days > 0) {
    await pool.query("SELECT add_retention_policy('mesures', ($1 || ' days')::interval)", [
      days,
    ]);
  }
  await audit(req.user!.username, "storage.retention", null, { days });
  return { ok: true, days };
});

// Met à jour la compression (jours avant compression). 0 = désactive.
app.post("/api/storage/compression", { preHandler: requireAdmin }, async (req, reply) => {
  const b = req.body as { days?: number };
  const days = Number(b.days);
  if (!Number.isFinite(days) || days < 0 || days > 3650)
    return reply.code(400).send({ error: "days doit être entre 0 et 3650" });
  await pool.query("SELECT remove_compression_policy('mesures', if_exists => true)");
  if (days > 0) {
    await pool.query("SELECT add_compression_policy('mesures', ($1 || ' days')::interval)", [
      days,
    ]);
  }
  await audit(req.user!.username, "storage.compression", null, { days });
  return { ok: true, days };
});

// ─── Paramètres : Infos système (admin only) ──────────────────────────────
app.get("/api/system", { preHandler: requireAdmin }, async () => {
  const counts = await pool.query(
    `SELECT
       (SELECT count(*) FROM tags)::int     AS tags,
       (SELECT count(*) FROM devices)::int   AS devices,
       (SELECT count(*) FROM users)::int     AS users,
       (SELECT count(*) FROM mesures)::bigint AS mesures`,
  );
  const ver = await pool.query("SELECT extversion FROM pg_extension WHERE extname='timescaledb'");
  // État des connecteurs Kafka Connect (si le profil plc4x tourne).
  let connectors: { name: string; state: string }[] = [];
  try {
    const r = await fetch(`${process.env.KAFKA_CONNECT_URL ?? "http://kafka-connect:8083"}/connectors?expand=status`);
    if (r.ok) {
      const data = (await r.json()) as Record<string, { status?: { connector?: { state?: string } } }>;
      connectors = Object.entries(data).map(([name, v]) => ({
        name,
        state: v.status?.connector?.state ?? "?",
      }));
    }
  } catch {
    /* Kafka Connect non démarré : pas de connecteurs à lister */
  }
  return {
    counts: counts.rows[0],
    timescaledb_version: ver.rows[0]?.extversion ?? "?",
    node_version: process.version,
    connectors,
  };
});

// ─── Dashboards (pages multi-plots sauvegardées, privées par utilisateur) ──
// `spec` est opaque (jsonb non validé) : le front en est seul maître.
// Isolation stricte par propriétaire ; accès au dashboard d'autrui -> 404.

app.get("/api/dashboards", { preHandler: requireAuth }, async (req) => {
  const { rows } = await pool.query(
    `SELECT id, name, updated_at FROM dashboards
     WHERE owner_id = $1 ORDER BY updated_at DESC`,
    [req.user!.id],
  );
  return rows;
});

app.get("/api/dashboards/:id", { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const { rows } = await pool.query(
    "SELECT id, name, spec, updated_at FROM dashboards WHERE id = $1 AND owner_id = $2",
    [id, req.user!.id],
  );
  if (rows.length === 0) return reply.code(404).send({ error: "introuvable" });
  return rows[0];
});

app.post("/api/dashboards", { preHandler: requireAuth }, async (req, reply) => {
  const b = req.body as { name?: string; spec?: unknown };
  if (!b.name?.trim()) return reply.code(400).send({ error: "name requis" });
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO dashboards (id, owner_id, name, spec)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id, name, spec, updated_at`,
    [id, req.user!.id, b.name.trim(), JSON.stringify(b.spec ?? {})],
  );
  await audit(req.user!.username, "dashboard.create", id, { name: b.name });
  return rows[0];
});

app.put("/api/dashboards/:id", { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const b = req.body as { name?: string; spec?: unknown };
  if (!b.name?.trim()) return reply.code(400).send({ error: "name requis" });
  const { rows } = await pool.query(
    `UPDATE dashboards SET name = $3, spec = $4::jsonb, updated_at = now()
     WHERE id = $1 AND owner_id = $2
     RETURNING id, name, spec, updated_at`,
    [id, req.user!.id, b.name.trim(), JSON.stringify(b.spec ?? {})],
  );
  if (rows.length === 0) return reply.code(404).send({ error: "introuvable" });
  await audit(req.user!.username, "dashboard.update", id);
  return rows[0];
});

app.delete("/api/dashboards/:id", { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const r = await pool.query(
    "DELETE FROM dashboards WHERE id = $1 AND owner_id = $2",
    [id, req.user!.id],
  );
  if (r.rowCount === 0) return reply.code(404).send({ error: "introuvable" });
  await audit(req.user!.username, "dashboard.delete", id);
  return reply.code(204).send();
});

// ─── Alarmes — règles de seuils (config, admin) ───────────────────────────

const ALARM_OPERATORS = [">", ">=", "<", "<=", "==", "!="];
const ALARM_SEVERITIES = ["critical", "warning", "info"];

/** Valide et normalise le corps d'une règle d'alarme. Renvoie une erreur (string) ou null. */
function validateRule(b: Record<string, unknown>): string | null {
  if (!b.tag || typeof b.tag !== "string") return "tag requis";
  if (!ALARM_OPERATORS.includes(b.operator as string)) return "operator invalide";
  if (typeof b.threshold !== "number") return "threshold doit être un nombre";
  if (!ALARM_SEVERITIES.includes(b.severity as string)) return "severity invalide";
  return null;
}

app.get("/api/alarm-rules", { preHandler: requireAdmin }, async () => {
  const { rows } = await pool.query(
    `SELECT id, tag, operator, threshold, severity, message, for_ms, hysteresis, enabled
     FROM alarm_rules ORDER BY tag, threshold`,
  );
  return rows;
});

app.post("/api/alarm-rules", { preHandler: requireAdmin }, async (req, reply) => {
  const b = req.body as Record<string, unknown>;
  const err = validateRule(b);
  if (err) return reply.code(400).send({ error: err });
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO alarm_rules (id, tag, operator, threshold, severity, message, for_ms, hysteresis, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,0),COALESCE($8,0),COALESCE($9,true))
     RETURNING id, tag, operator, threshold, severity, message, for_ms, hysteresis, enabled`,
    [id, b.tag, b.operator, b.threshold, b.severity, b.message ?? null, b.for_ms, b.hysteresis, b.enabled],
  );
  await alarmEngine.refresh();
  await audit(req.user!.username, "alarm-rule.create", b.tag as string);
  return rows[0];
});

app.put("/api/alarm-rules/:id", { preHandler: requireAdmin }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const b = req.body as Record<string, unknown>;
  const err = validateRule(b);
  if (err) return reply.code(400).send({ error: err });
  const { rows } = await pool.query(
    `UPDATE alarm_rules SET tag=$2, operator=$3, threshold=$4, severity=$5,
       message=$6, for_ms=COALESCE($7,0), hysteresis=COALESCE($8,0), enabled=COALESCE($9,true)
     WHERE id=$1
     RETURNING id, tag, operator, threshold, severity, message, for_ms, hysteresis, enabled`,
    [id, b.tag, b.operator, b.threshold, b.severity, b.message ?? null, b.for_ms, b.hysteresis, b.enabled],
  );
  if (rows.length === 0) return reply.code(404).send({ error: "introuvable" });
  await alarmEngine.refresh();
  await audit(req.user!.username, "alarm-rule.update", id);
  return rows[0];
});

app.delete("/api/alarm-rules/:id", { preHandler: requireAdmin }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const r = await pool.query("DELETE FROM alarm_rules WHERE id = $1", [id]);
  if (r.rowCount === 0) return reply.code(404).send({ error: "introuvable" });
  await alarmEngine.refresh();
  await audit(req.user!.username, "alarm-rule.delete", id);
  return reply.code(204).send();
});

// ─── Alarmes — consultation & acquittement (requireAuth) ──────────────────

// Set "courant" : actives OU (clôturées non acquittées). Trié raised_at desc.
app.get("/api/alarms", { preHandler: requireAuth }, async () => {
  const { rows } = await pool.query(
    `SELECT id, rule_id, source, tag, severity, message, value, state,
            raised_at, cleared_at, acked, acked_by, acked_at
     FROM alarms
     WHERE state = 'active' OR (state = 'cleared' AND acked = false)
     ORDER BY raised_at DESC`,
  );
  return rows;
});

app.post("/api/alarms/:id/ack", { preHandler: requireAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const { rows } = await pool.query(
    `UPDATE alarms SET acked = true, acked_by = $2, acked_at = now()
     WHERE id = $1
     RETURNING id, rule_id, source, tag, severity, message, value, state,
               raised_at, cleared_at, acked, acked_by, acked_at`,
    [id, req.user!.username],
  );
  if (rows.length === 0) return reply.code(404).send({ error: "introuvable" });
  await audit(req.user!.username, "alarm.ack", rows[0].tag);
  return rows[0];
});

// Historique des alarmes (pour plus tard).
app.get("/api/alarms/history", { preHandler: requireAuth }, async (req) => {
  const q = req.query as { from?: string; to?: string; limit?: string };
  const limit = Math.min(1000, Number(q.limit) || 200);
  const from = q.from ? new Date(q.from) : new Date(Date.now() - 7 * 86400_000);
  const to = q.to ? new Date(q.to) : new Date();
  const { rows } = await pool.query(
    `SELECT id, rule_id, source, tag, severity, message, value, state,
            raised_at, cleared_at, acked, acked_by, acked_at
     FROM alarms
     WHERE raised_at >= $1 AND raised_at <= $2
     ORDER BY raised_at DESC LIMIT $3`,
    [from.toISOString(), to.toISOString(), limit],
  );
  return rows;
});

// ─── Écriture de consigne (Phase 8) ───────────────────────────────────────
// Publie une commande sur `tags.cmd`, après vérif du droit d'écriture + audit.
app.post("/api/command", { preHandler: requireAuth }, async (req, reply) => {
  const b = req.body as { tag?: string; value?: number };
  if (!b.tag || typeof b.value !== "number")
    return reply.code(400).send({ error: "tag (string) et value (number) requis" });
  if (!can(req.user, "write", b.tag))
    return reply.code(403).send({ error: `pas le droit d'écrire sur ${b.tag}` });
  try {
    await publishCommand(b.tag, b.value, `user:${req.user!.username}`);
  } catch (err) {
    app.log.error(`publication commande échouée: ${(err as Error).message}`);
    return reply.code(502).send({ error: "broker indisponible" });
  }
  await audit(req.user!.username, "tag.command", b.tag, { value: b.value });
  return { ok: true, tag: b.tag, value: b.value };
});

// Liste des tags configurés (avec métadonnées).
app.get("/api/tags", async () => {
  const { rows } = await pool.query(
    `SELECT name, label, unit, scale, offset_val AS offset, enabled, description
     FROM tags ORDER BY name`,
  );
  return rows;
});

// Upsert d'un tag. Exige le droit d'écriture sur le tag concerné.
app.post("/api/tags", { preHandler: requireAuth }, async (req, reply) => {
  const b = req.body as Partial<TagConfig> & { name?: string };
  if (!b.name) return reply.code(400).send({ error: "champ 'name' requis" });
  if (!can(req.user, "write", b.name))
    return reply.code(403).send({ error: `pas le droit d'écrire sur ${b.name}` });
  await pool.query(
    `INSERT INTO tags (name, label, unit, scale, offset_val, enabled, description, updated_at)
     VALUES ($1, $2, $3, COALESCE($4,1), COALESCE($5,0), COALESCE($6,true), $7, now())
     ON CONFLICT (name) DO UPDATE SET
       label = EXCLUDED.label,
       unit = EXCLUDED.unit,
       scale = EXCLUDED.scale,
       offset_val = EXCLUDED.offset_val,
       enabled = EXCLUDED.enabled,
       description = EXCLUDED.description,
       updated_at = now()`,
    [b.name, b.label ?? null, b.unit ?? null, b.scale, b.offset, b.enabled, b.description ?? null],
  );
  await refreshTagCache();
  return tagCache.get(b.name);
});

// Suppression de la config d'un tag (l'historique dans `mesures` est conservé).
app.delete("/api/tags/:name", { preHandler: requireAuth }, async (req, reply) => {
  const { name } = req.params as { name: string };
  if (!can(req.user, "write", name))
    return reply.code(403).send({ error: `pas le droit d'écrire sur ${name}` });
  await pool.query("DELETE FROM tags WHERE name = $1", [name]);
  await refreshTagCache();
  await audit(req.user!.username, "tag.delete", name);
  return { deleted: name };
});

// Historique d'un tag, scaling appliqué côté SQL.
app.get("/api/history", async (req, reply) => {
  const q = req.query as {
    tag?: string;
    minutes?: string;
    from?: string;
    to?: string;
    maxPoints?: string;
  };
  const tag = q.tag;
  if (!tag) return reply.code(400).send({ error: "param 'tag' requis" });

  const cfg = tagCache.get(tag);
  const scale = cfg?.scale ?? 1;
  const offset = cfg?.offset ?? 0;

  // Plafond de points renvoyés (down-sampling au-delà). Borné pour éviter d'écrouler
  // le navigateur ET de surcharger la base.
  const maxPoints = Math.min(20000, Math.max(100, Number(q.maxPoints) || 4000));

  // Détermine la fenêtre : plage absolue from/to (prioritaire) sinon `minutes`.
  let fromTs: Date;
  let toTs: Date;
  if (q.from || q.to) {
    fromTs = new Date(q.from ?? "");
    toTs = new Date(q.to ?? "");
    if (isNaN(fromTs.getTime()) || isNaN(toTs.getTime()))
      return reply.code(400).send({ error: "from/to doivent être des dates ISO 8601 valides" });
    if (fromTs >= toTs)
      return reply.code(400).send({ error: "from doit être strictement avant to" });
  } else {
    const minutes = Number(q.minutes ?? 15);
    if (!Number.isFinite(minutes) || minutes <= 0)
      return reply.code(400).send({ error: "minutes doit être un nombre positif" });
    toTs = new Date();
    fromTs = new Date(toTs.getTime() - minutes * 60_000);
  }

  // Combien de points bruts dans la fenêtre ? Si ça dépasse maxPoints, on
  // agrège par buckets temporels (moyenne) pour borner le volume tout en gardant
  // la forme de la courbe ; sinon on renvoie le brut (aucune perte).
  const countRes = await pool.query(
    "SELECT count(*)::bigint AS n FROM mesures WHERE tag = $1 AND ts >= $2 AND ts <= $3",
    [tag, fromTs.toISOString(), toTs.toISOString()],
  );
  const n = Number(countRes.rows[0].n);

  if (n <= maxPoints) {
    const { rows } = await pool.query(
      `SELECT ts, value * $2 + $3 AS value FROM mesures
       WHERE tag = $1 AND ts >= $4 AND ts <= $5
       ORDER BY ts ASC`,
      [tag, scale, offset, fromTs.toISOString(), toTs.toISOString()],
    );
    return rows;
  }

  // Down-sampling : 1 point par bucket = durée_fenêtre / maxPoints (>= 1 ms).
  const spanMs = toTs.getTime() - fromTs.getTime();
  const bucketMs = Math.max(1, Math.ceil(spanMs / maxPoints));
  const { rows } = await pool.query(
    `SELECT time_bucket(($4 || ' milliseconds')::interval, ts) AS ts,
            avg(value) * $2 + $3 AS value
     FROM mesures
     WHERE tag = $1 AND ts >= $5 AND ts <= $6
     GROUP BY 1
     ORDER BY 1 ASC`,
    [tag, scale, offset, bucketMs, fromTs.toISOString(), toTs.toISOString()],
  );
  return rows;
});

// ─── Production / shifts / rôles (Phase 3) ────────────────────────────────

// Production par shift et par rôle. Optionnel ?days=N pour limiter l'historique.
app.get("/api/production", async (req) => {
  const q = req.query as { days?: string };
  const days = Number(q.days ?? 7);
  const { rows } = await pool.query(
    `SELECT day, shift_no, shift_label, ok, scrap, produced, available
     FROM prod_by_shift_role
     WHERE day > (now() - ($1 || ' days')::interval)::date
     ORDER BY day DESC, shift_no ASC`,
    [days],
  );
  return rows;
});

// ─── OEE (Disponibilité × Performance × Qualité) — cf. docs/oee-design.md ──
// Lecture du résultat pré-calculé (vue oee_by_shift). Ouvert comme /api/production.
app.get("/api/oee", async (req) => {
  const q = req.query as { days?: string };
  const days = Number(q.days ?? 7);
  const { rows } = await pool.query(
    `SELECT * FROM oee_by_shift
     WHERE day > (now() - ($1 || ' days')::interval)::date
     ORDER BY day DESC, line ASC, shift_no ASC`,
    [days],
  );
  return rows;
});

// Motifs d'arrêt : minutes de perte par motif × ligne × shift (Pareto). Ouvert.
app.get("/api/oee/downtime", async (req) => {
  const q = req.query as { days?: string };
  const days = Number(q.days ?? 7);
  const { rows } = await pool.query(
    `SELECT line, day, shift_no, reason_code, reason_label, kind, color, minutes
     FROM oee_downtime_by_shift
     WHERE day > (now() - ($1 || ' days')::interval)::date
     ORDER BY day DESC, line ASC, minutes DESC`,
    [days],
  );
  return rows;
});

// Catalogue de motifs d'arrêt (label/type/couleur). Édition -> admin.
app.get("/api/stop-reasons", async () => {
  const { rows } = await pool.query(
    "SELECT code, label, kind, planned, color FROM stop_reason ORDER BY kind, code",
  );
  return rows;
});

app.post("/api/stop-reasons", { preHandler: requireAdmin }, async (req, reply) => {
  const b = req.body as {
    code?: string;
    label?: string;
    kind?: string;
    planned?: boolean;
    color?: string;
  };
  if (!b.code || !b.label || !b.kind)
    return reply.code(400).send({ error: "code, label, kind requis" });
  await pool.query(
    `INSERT INTO stop_reason (code, label, kind, planned, color)
     VALUES ($1,$2,$3,COALESCE($4,false),$5)
     ON CONFLICT (code) DO UPDATE SET
       label=EXCLUDED.label, kind=EXCLUDED.kind,
       planned=EXCLUDED.planned, color=EXCLUDED.color`,
    [b.code, b.label, b.kind, b.planned, b.color ?? null],
  );
  await audit(req.user!.username, "stop_reason.upsert", b.code);
  return { ok: true };
});

// Arrêts détectés (intervalles) + motif effectif (label opérateur sinon dérivé).
// Détection par change-points sur le running_tag, fenêtre bornée par `days`.
app.get("/api/oee/stops", { preHandler: requireAuth }, async (req) => {
  const q = req.query as { days?: string; line?: string; min_minutes?: string };
  const days = Number(q.days ?? 2);
  const minMinutes = Number(q.min_minutes ?? 1);
  // Un arrêt = un TROU entre deux échantillons « en marche » (value=1) du running_tag
  // — qu'il s'agisse d'un état 0/2 OU d'une absence de données (ligne éteinte). C'est
  // ce qui donne des arrêts substantiels et classables (vs des micro-dips < 1 s).
  const { rows } = await pool.query(
    `WITH rt AS (
        SELECT line, running_tag FROM oee_line
        WHERE enabled AND running_tag IS NOT NULL AND ($2 = '' OR line = $2)
     ),
     runs AS (
        SELECT rt.line, m.ts,
               lag(m.ts) OVER (PARTITION BY m.tag ORDER BY m.ts) AS prev_ts
        FROM mesures m JOIN rt ON rt.running_tag = m.tag
        WHERE m.value = 1 AND m.ts > now() - ($1 || ' days')::interval
     )
     SELECT r.line,
            date_trunc('second', r.prev_ts) AS start_ts,
            r.ts      AS end_ts,
            (EXTRACT(EPOCH FROM (r.ts - r.prev_ts))/60.0)::float8 AS minutes,
            'stopped'::text AS derived_reason,
            lbl.reason_code AS operator_reason, lbl.note, lbl.labeled_by,
            COALESCE(lbl.reason_code, 'stopped') AS reason_code
     FROM runs r
     LEFT JOIN stop_event_label lbl
            ON lbl.line = r.line AND lbl.start_ts = date_trunc('second', r.prev_ts)
     WHERE r.prev_ts IS NOT NULL
       AND EXTRACT(EPOCH FROM (r.ts - r.prev_ts))/60.0 >= $3
     ORDER BY r.ts DESC
     LIMIT 500`,
    [days, q.line ?? "", minMinutes],
  );
  return rows;
});

// L'opérateur étiquette un arrêt (motif réel). Droit write sur la ligne.
app.post("/api/oee/stops/label", { preHandler: requireAuth }, async (req, reply) => {
  const b = req.body as { line?: string; start_ts?: string; reason_code?: string; note?: string };
  if (!b.line || !b.start_ts || !b.reason_code)
    return reply.code(400).send({ error: "line, start_ts, reason_code requis" });
  if (!can(req.user, "write", b.line))
    return reply.code(403).send({ error: `pas le droit de classer un arrêt sur ${b.line}` });
  await pool.query(
    `INSERT INTO stop_event_label (line, start_ts, reason_code, note, labeled_by)
     VALUES ($1, date_trunc('second', $2::timestamptz), $3, $4, $5)
     ON CONFLICT (line, start_ts) DO UPDATE SET
       reason_code=EXCLUDED.reason_code, note=EXCLUDED.note,
       labeled_by=EXCLUDED.labeled_by, labeled_at=now()`,
    [b.line, b.start_ts, b.reason_code, b.note ?? null, req.user!.username],
  );
  await audit(req.user!.username, "stop.label", b.line, { start_ts: b.start_ts, reason: b.reason_code });
  return { ok: true };
});

// Pareto des pertes basé sur les ARRÊTS ÉTIQUETÉS (motif effectif = label sinon
// dérivé) : précis et opérateur-aware (vs /api/oee/downtime, bucket 15 min). Par
// ligne × motif sur la fenêtre. Même détection d'arrêt que /api/oee/stops.
app.get("/api/oee/downtime/events", async (req) => {
  const q = req.query as { days?: string; line?: string; min_minutes?: string };
  const days = Number(q.days ?? 7);
  const minMinutes = Number(q.min_minutes ?? 1);
  const { rows } = await pool.query(
    `WITH rt AS (
        SELECT line, running_tag FROM oee_line
        WHERE enabled AND running_tag IS NOT NULL AND ($2 = '' OR line = $2)
     ),
     runs AS (
        SELECT rt.line, m.ts, lag(m.ts) OVER (PARTITION BY m.tag ORDER BY m.ts) AS prev_ts
        FROM mesures m JOIN rt ON rt.running_tag = m.tag
        WHERE m.value = 1 AND m.ts > now() - ($1 || ' days')::interval
     ),
     stops AS (
        SELECT r.line, date_trunc('second', r.prev_ts) AS start_ts,
               EXTRACT(EPOCH FROM (r.ts - r.prev_ts))/60.0 AS minutes
        FROM runs r
        WHERE r.prev_ts IS NOT NULL
          AND EXTRACT(EPOCH FROM (r.ts - r.prev_ts))/60.0 >= $3
     ),
     classified AS (
        SELECT s.line, COALESCE(lbl.reason_code, 'stopped') AS reason_code, s.minutes
        FROM stops s
        LEFT JOIN stop_event_label lbl ON lbl.line = s.line AND lbl.start_ts = s.start_ts
     )
     SELECT c.line, c.reason_code, sr.label AS reason_label, sr.kind, sr.color,
            sum(c.minutes)::float8 AS minutes, count(*)::int AS stops
     FROM classified c JOIN stop_reason sr ON sr.code = c.reason_code
     GROUP BY c.line, c.reason_code, sr.label, sr.kind, sr.color
     ORDER BY c.line ASC, minutes DESC`,
    [days, q.line ?? "", minMinutes],
  );
  return rows;
});

// ─── Assistant IA local (profil `ai`, Ollama) — cf. docs/llm-integration.md ──
// Chemin B : la boucle d'agent vit ici, les tools (lecture) s'exécutent avec le
// contexte de l'utilisateur connecté. Le LLM ne touche jamais la base en direct.
app.post("/api/assistant/chat", { preHandler: requireAuth }, async (req, reply) => {
  const b = req.body as { messages?: ChatMessage[]; message?: string };
  const history: ChatMessage[] =
    b.messages?.length ? b.messages : b.message ? [{ role: "user", content: b.message }] : [];
  if (!history.length) return reply.code(400).send({ error: "messages ou message requis" });
  try {
    const out = await runAssistant(pool, req.user, history);
    await audit(req.user!.username, "assistant.chat", null, { steps: out.steps });
    return out;
  } catch (e) {
    return reply.code(502).send({ error: `assistant indisponible (profil ai démarré ?): ${(e as Error).message}` });
  }
});

// Objectifs OEE par ligne (cible OEE + objectif de pièces/shift). Admin.
app.get("/api/oee-targets", { preHandler: requireAdmin }, async () => {
  const { rows } = await pool.query(
    "SELECT line, target_oee, target_pieces, enabled FROM oee_target ORDER BY line",
  );
  return rows;
});

app.post("/api/oee-targets", { preHandler: requireAdmin }, async (req, reply) => {
  const b = req.body as {
    line?: string;
    target_oee?: number | null;
    target_pieces?: number | null;
    enabled?: boolean;
  };
  if (!b.line) return reply.code(400).send({ error: "line requis" });
  await pool.query(
    `INSERT INTO oee_target (line, target_oee, target_pieces, enabled)
     VALUES ($1,$2,$3,COALESCE($4,true))
     ON CONFLICT (line) DO UPDATE SET
       target_oee=EXCLUDED.target_oee, target_pieces=EXCLUDED.target_pieces,
       enabled=EXCLUDED.enabled`,
    [b.line, b.target_oee ?? null, b.target_pieces ?? null, b.enabled],
  );
  await audit(req.user!.username, "oee_target.upsert", b.line);
  return { ok: true };
});

app.delete("/api/oee-targets/:line", { preHandler: requireAdmin }, async (req) => {
  const { line } = req.params as { line: string };
  await pool.query("DELETE FROM oee_target WHERE line = $1", [line]);
  await audit(req.user!.username, "oee_target.delete", line);
  return { ok: true };
});

// Config OEE par ligne (cadence nominale + tag de marche). Réglage global -> admin.
app.get("/api/oee-lines", { preHandler: requireAdmin }, async () => {
  const { rows } = await pool.query(
    "SELECT line, label, ideal_rate, running_tag, enabled FROM oee_line ORDER BY line",
  );
  return rows;
});

app.post("/api/oee-lines", { preHandler: requireAdmin }, async (req, reply) => {
  const b = req.body as {
    line?: string;
    label?: string;
    ideal_rate?: number;
    running_tag?: string;
    enabled?: boolean;
  };
  if (!b.line || b.ideal_rate == null)
    return reply.code(400).send({ error: "line, ideal_rate requis" });
  await pool.query(
    `INSERT INTO oee_line (line, label, ideal_rate, running_tag, enabled)
     VALUES ($1,$2,$3,$4,COALESCE($5,true))
     ON CONFLICT (line) DO UPDATE SET
       label=EXCLUDED.label, ideal_rate=EXCLUDED.ideal_rate,
       running_tag=EXCLUDED.running_tag, enabled=EXCLUDED.enabled`,
    [b.line, b.label ?? null, b.ideal_rate, b.running_tag ?? null, b.enabled],
  );
  await audit(req.user!.username, "oee_line.upsert", b.line);
  return { ok: true };
});

app.delete("/api/oee-lines/:line", { preHandler: requireAdmin }, async (req) => {
  const { line } = req.params as { line: string };
  await pool.query("DELETE FROM oee_line WHERE line = $1", [line]);
  await audit(req.user!.username, "oee_line.delete", line);
  return { ok: true };
});

// Planning de shifts (toutes versions).
app.get("/api/shifts", async () => {
  const { rows } = await pool.query(
    `SELECT valid_from, shift_no, label, start_time, end_time
     FROM shift_schedule ORDER BY valid_from DESC, shift_no ASC`,
  );
  return rows;
});

// Upsert d'une ligne de planning. Réglage global -> admin.
app.post("/api/shifts", { preHandler: requireAdmin }, async (req, reply) => {
  const b = req.body as {
    valid_from?: string;
    shift_no?: number;
    label?: string;
    start_time?: string;
    end_time?: string;
  };
  if (!b.valid_from || b.shift_no == null || !b.start_time || !b.end_time)
    return reply.code(400).send({ error: "valid_from, shift_no, start_time, end_time requis" });
  await pool.query(
    `INSERT INTO shift_schedule (valid_from, shift_no, label, start_time, end_time)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (valid_from, shift_no) DO UPDATE SET
       label = EXCLUDED.label,
       start_time = EXCLUDED.start_time,
       end_time = EXCLUDED.end_time`,
    [b.valid_from, b.shift_no, b.label ?? null, b.start_time, b.end_time],
  );
  return { ok: true };
});

// Suppression d'une ligne de planning. Réglage global -> admin.
app.delete("/api/shifts/:validFrom/:shiftNo", { preHandler: requireAdmin }, async (req) => {
  const { validFrom, shiftNo } = req.params as { validFrom: string; shiftNo: string };
  await pool.query(
    "DELETE FROM shift_schedule WHERE valid_from = $1 AND shift_no = $2",
    [validFrom, Number(shiftNo)],
  );
  return { ok: true };
});

// Rôles des tags (mapping tag -> produced/ok/scrap/available).
app.get("/api/tag-roles", async () => {
  const { rows } = await pool.query(
    "SELECT tag_name, role FROM tag_role ORDER BY tag_name",
  );
  return rows;
});

// Définit/retire le rôle d'un tag. role=null pour retirer. Réglage global -> admin.
app.post("/api/tag-roles", { preHandler: requireAdmin }, async (req, reply) => {
  const b = req.body as { tag_name?: string; role?: string | null };
  if (!b.tag_name) return reply.code(400).send({ error: "tag_name requis" });
  // Un tag a au plus un rôle ici : on nettoie puis on (ré)insère.
  await pool.query("DELETE FROM tag_role WHERE tag_name = $1", [b.tag_name]);
  if (b.role) {
    await pool.query("INSERT INTO tag_role (tag_name, role) VALUES ($1, $2)", [
      b.tag_name,
      b.role,
    ]);
  }
  return { ok: true };
});

// ─── Automates (devices) & adresses de tags (admin only) ──────────────────

// Liste des automates + nombre de tags rattachés.
app.get("/api/devices", { preHandler: requireAdmin }, async () => {
  const { rows } = await pool.query(
    `SELECT d.*, count(t.name)::int AS tag_count
     FROM devices d LEFT JOIN tags t ON t.device = d.name
     GROUP BY d.name ORDER BY d.name`,
  );
  return rows;
});

// Upsert d'un automate.
app.post("/api/devices", { preHandler: requireAdmin }, async (req, reply) => {
  const b = req.body as {
    name?: string;
    protocol?: string;
    host?: string;
    options?: string;
    poll_ms?: number;
    enabled?: boolean;
    base_tag?: string;
  };
  if (!b.name || !b.protocol || !b.host)
    return reply.code(400).send({ error: "name, protocol, host requis" });
  await pool.query(
    `INSERT INTO devices (name, protocol, host, options, poll_ms, enabled, base_tag)
     VALUES ($1,$2,$3,$4,COALESCE($5,1000),COALESCE($6,true),$7)
     ON CONFLICT (name) DO UPDATE SET
       protocol=EXCLUDED.protocol, host=EXCLUDED.host, options=EXCLUDED.options,
       poll_ms=EXCLUDED.poll_ms, enabled=EXCLUDED.enabled, base_tag=EXCLUDED.base_tag`,
    [b.name, b.protocol, b.host, b.options ?? null, b.poll_ms, b.enabled, b.base_tag ?? null],
  );
  await audit(req.user!.username, "device.upsert", b.name);
  return { ok: true };
});

// Suppression d'un automate (les tags rattachés perdent leur device, pas leur config).
app.delete("/api/devices/:name", { preHandler: requireAdmin }, async (req) => {
  const { name } = req.params as { name: string };
  await pool.query("DELETE FROM devices WHERE name = $1", [name]);
  await audit(req.user!.username, "device.delete", name);
  return { ok: true };
});

// Tags d'un automate (avec leur adresse physique).
app.get("/api/devices/:name/tags", { preHandler: requireAdmin }, async (req) => {
  const { name } = req.params as { name: string };
  const { rows } = await pool.query(
    `SELECT name, label, unit, address, datatype, enabled
     FROM tags WHERE device = $1 ORDER BY name`,
    [name],
  );
  return rows;
});

// Met à jour l'adresse / le rattachement d'un tag (crée le tag si absent).
app.post("/api/tags/:name/address", { preHandler: requireAdmin }, async (req, reply) => {
  const { name } = req.params as { name: string };
  const b = req.body as { device?: string | null; address?: string | null; datatype?: string | null };
  await pool.query(
    `INSERT INTO tags (name, label, device, address, datatype)
     VALUES ($1, $1, $2, $3, $4)
     ON CONFLICT (name) DO UPDATE SET
       device=EXCLUDED.device, address=EXCLUDED.address, datatype=EXCLUDED.datatype`,
    [name, b.device ?? null, b.address ?? null, b.datatype ?? null],
  );
  await refreshTagCache();
  return reply.send({ ok: true });
});

// Import CSV de tags : lignes "tag,address[,datatype[,unit]]". Rattachés au device.
app.post("/api/devices/:name/import", { preHandler: requireAdmin }, async (req, reply) => {
  const { name } = req.params as { name: string };
  const b = req.body as { csv?: string };
  if (!b.csv) return reply.code(400).send({ error: "champ 'csv' requis" });
  let imported = 0;
  const errors: string[] = [];
  for (const raw of b.csv.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [tag, address, datatype, unit] = line.split(",").map((s) => s?.trim());
    if (!tag || !address) {
      errors.push(`ligne ignorée: ${line}`);
      continue;
    }
    await pool.query(
      `INSERT INTO tags (name, label, device, address, datatype, unit)
       VALUES ($1, $1, $2, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE SET
         device=EXCLUDED.device, address=EXCLUDED.address,
         datatype=COALESCE(EXCLUDED.datatype, tags.datatype),
         unit=COALESCE(EXCLUDED.unit, tags.unit)`,
      [tag, name, address, datatype || null, unit || null],
    );
    imported++;
  }
  await refreshTagCache();
  await audit(req.user!.username, "device.import", name, { imported });
  return { imported, errors };
});

// Déploie le connecteur PLC4X d'un device vers Kafka Connect (génère depuis la base).
app.post("/api/devices/:name/deploy", { preHandler: requireAdmin }, async (req) => {
  const { name } = req.params as { name: string };
  const result = await deployDevice(pool, name);
  await audit(req.user!.username, "device.deploy", name, result);
  return result;
});

// Retire le connecteur d'un device de Kafka Connect.
app.post("/api/devices/:name/undeploy", { preHandler: requireAdmin }, async (req) => {
  const { name } = req.params as { name: string };
  const result = await undeployDevice(name);
  await audit(req.user!.username, "device.undeploy", name, result);
  return result;
});

// ─── Administration des utilisateurs & droits (Phase 7, admin only) ────────

// Liste des utilisateurs avec leurs rôles.
app.get("/api/users", { preHandler: requireAdmin }, async () => {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.enabled,
            COALESCE(array_agg(ur.role) FILTER (WHERE ur.role IS NOT NULL), '{}') AS roles
     FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id
     GROUP BY u.id ORDER BY u.username`,
  );
  return rows;
});

// Crée un utilisateur (+ rôles optionnels).
app.post("/api/users", { preHandler: requireAdmin }, async (req, reply) => {
  const b = req.body as {
    username?: string;
    password?: string;
    display_name?: string;
    roles?: string[];
  };
  if (!b.username || !b.password)
    return reply.code(400).send({ error: "username et password requis" });
  const hash = await hashPassword(b.password);
  const { rows } = await pool.query(
    `INSERT INTO users (username, password_hash, display_name) VALUES ($1,$2,$3)
     ON CONFLICT (username) DO NOTHING RETURNING id`,
    [b.username, hash, b.display_name ?? null],
  );
  if (rows.length === 0)
    return reply.code(409).send({ error: "utilisateur déjà existant" });
  const userId = rows[0].id;
  for (const role of b.roles ?? []) {
    await pool.query(
      "INSERT INTO user_roles (user_id, role) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [userId, role],
    );
  }
  await audit(req.user!.username, "user.create", b.username, { roles: b.roles });
  return { id: userId };
});

// Met à jour les rôles d'un utilisateur (remplace l'ensemble).
app.put("/api/users/:id/roles", { preHandler: requireAdmin }, async (req) => {
  const { id } = req.params as { id: string };
  const b = req.body as { roles?: string[] };
  await pool.query("DELETE FROM user_roles WHERE user_id = $1", [Number(id)]);
  for (const role of b.roles ?? []) {
    await pool.query(
      "INSERT INTO user_roles (user_id, role) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [Number(id), role],
    );
  }
  await audit(req.user!.username, "user.roles", id, { roles: b.roles });
  return { ok: true };
});

// Réinitialise le mot de passe d'un utilisateur.
app.put("/api/users/:id/password", { preHandler: requireAdmin }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const b = req.body as { password?: string };
  if (!b.password) return reply.code(400).send({ error: "password requis" });
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [
    await hashPassword(b.password),
    Number(id),
  ]);
  // Révoque les sessions existantes de cet utilisateur.
  await pool.query("DELETE FROM sessions WHERE user_id = $1", [Number(id)]);
  await audit(req.user!.username, "user.password", id);
  return { ok: true };
});

// Active/désactive un utilisateur.
app.put("/api/users/:id/enabled", { preHandler: requireAdmin }, async (req) => {
  const { id } = req.params as { id: string };
  const b = req.body as { enabled?: boolean };
  await pool.query("UPDATE users SET enabled = $1 WHERE id = $2", [
    b.enabled !== false,
    Number(id),
  ]);
  if (b.enabled === false)
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [Number(id)]);
  return { ok: true };
});

// Rôles disponibles + leurs droits (pour l'UI d'admin).
app.get("/api/roles", { preHandler: requireAdmin }, async () => {
  const { rows } = await pool.query(
    `SELECT r.name, r.description,
            COALESCE(json_agg(json_build_object('scope', g.scope, 'action', g.action))
                     FILTER (WHERE g.role IS NOT NULL), '[]') AS grants
     FROM roles r LEFT JOIN grants g ON g.role = r.name
     GROUP BY r.name ORDER BY r.name`,
  );
  return rows;
});

// Définit les droits d'un rôle (remplace l'ensemble).
app.put("/api/roles/:name/grants", { preHandler: requireAdmin }, async (req) => {
  const { name } = req.params as { name: string };
  const b = req.body as { grants?: { scope: string; action: string }[] };
  await pool.query("DELETE FROM grants WHERE role = $1", [name]);
  for (const g of b.grants ?? []) {
    await pool.query(
      "INSERT INTO grants (role, scope, action) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [name, g.scope || "*", g.action],
    );
  }
  await audit(req.user!.username, "role.grants", name, b.grants);
  return { ok: true };
});

// Journal d'audit (dernières entrées).
app.get("/api/audit", { preHandler: requireAdmin }, async (req) => {
  const q = req.query as { limit?: string };
  const limit = Math.min(500, Number(q.limit ?? 100));
  const { rows } = await pool.query(
    "SELECT ts, username, action, target, detail FROM audit_log ORDER BY ts DESC LIMIT $1",
    [limit],
  );
  return rows;
});

app.register(async (f) => {
  f.get("/ws", { websocket: true }, async (socket, req) => {
    // Auth au handshake : on lit la session depuis le cookie (same-origin -> il
    // part tout seul). Pas de session valide -> on ferme proprement (4401).
    const sid = readSessionCookie(req);
    const user = sid ? await loadUserFromSession(pool, sid).catch(() => null) : null;
    if (!user) {
      socket.close(4401, "non authentifié");
      return;
    }
    clients.set(socket, user);
    socket.on("close", () => clients.delete(socket));
  });
});

// --- Consumer Redpanda : fan-out vers les WS (scaling appliqué) ------------
async function startConsumer() {
  const consumer = kafka.consumer({ groupId: "strata-gateway-ws" });

  // Si le consumer crashe (format non géré, coupure…), KafkaJS émet CRASH puis
  // s'arrête. On le relance pour ne pas rester muet en silence.
  consumer.on(consumer.events.CRASH, (e) => {
    app.log.error(`consumer crash: ${e.payload.error.message} — relance dans 3s`);
    setTimeout(() => startConsumer().catch(() => {}), 3000);
  });

  await consumer.connect();
  await consumer.subscribe({ topic: "tags.raw", fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const payload = message.value?.toString();
      if (!payload) return;
      let m: { tag: string; value: number; ts: string; quality?: string; source?: string };
      try {
        m = JSON.parse(payload);
      } catch {
        return;
      }
      // Auto-découverte : un nouveau tag apparaît -> on crée sa config par défaut.
      if (!tagCache.has(m.tag)) await ensureTagExists(m.tag);
      const value = scaled(m.tag, m.value);
      // Détection d'alarmes sur la valeur SCALÉE (seuils en unité métier).
      alarmEngine.onMeasure(m.tag, value).catch((e) =>
        app.log.error(`alarme: ${(e as Error).message}`),
      );
      // On pousse la valeur SCALÉE au navigateur (cohérent avec l'historique),
      // mais SEULEMENT aux clients qui ont le droit de LIRE ce tag (filtrage RBAC).
      const out = JSON.stringify({ ...m, value });
      for (const [ws, user] of clients) {
        if (ws.readyState === 1 && can(user, "read", m.tag)) ws.send(out); // 1 = OPEN
      }
    },
  });
  app.log.info("consumer Redpanda démarré sur tags.raw");
}

/**
 * Consumer du topic `tags.derived` : les anomalies calculées par RisingWave
 * (MV -> sink) deviennent des alarmes `source='derived'` dans le modèle existant.
 * Anti-doublon : au plus une anomalie 'derived' active par tag à la fois.
 */
async function startDerivedConsumer() {
  const consumer = kafka.consumer({ groupId: "strata-gateway-derived" });
  consumer.on(consumer.events.CRASH, (e) => {
    app.log.error(`consumer derived crash: ${e.payload.error.message} — relance dans 3s`);
    setTimeout(() => startDerivedConsumer().catch(() => {}), 3000);
  });
  await consumer.connect();
  await consumer.subscribe({ topic: "tags.derived", fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const payload = message.value?.toString();
      if (!payload) return;
      let a: { tag?: string; mean?: number; sd?: number; detected_at?: string };
      try {
        a = JSON.parse(payload);
      } catch {
        return;
      }
      if (!a.tag) return;
      // Insère une anomalie active si aucune n'est déjà ouverte pour ce tag.
      await pool.query(
        `INSERT INTO alarms (id, source, tag, severity, message, value, state, raised_at)
         SELECT $1, 'derived', $2, 'warning', $3, $4, 'active', now()
         WHERE NOT EXISTS (
           SELECT 1 FROM alarms WHERE tag = $2 AND source = 'derived' AND state = 'active'
         )`,
        [
          randomUUID(),
          a.tag,
          `Anomalie détectée (RisingWave) sur ${a.tag}`,
          a.mean ?? null,
        ],
      ).catch((e) => app.log.error(`alarme derived: ${(e as Error).message}`));
    },
  });
  app.log.info("consumer Redpanda démarré sur tags.derived (anomalies)");
}

/**
 * Crée un compte admin initial s'il n'existe aucun utilisateur. Le mot de passe
 * vient de ADMIN_PASSWORD (défaut: "admin", à changer au 1er login en prod).
 */
async function seedAdmin() {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM users");
  if (rows[0].n > 0) return;
  const password = process.env.ADMIN_PASSWORD ?? "admin";
  const hash = await hashPassword(password);
  const ins = await pool.query(
    "INSERT INTO users (username, password_hash, display_name) VALUES ('admin',$1,'Administrateur') RETURNING id",
    [hash],
  );
  await pool.query("INSERT INTO user_roles (user_id, role) VALUES ($1,'admin')", [
    ins.rows[0].id,
  ]);
  // On ne logue JAMAIS le mot de passe. On alerte fort seulement si le défaut
  // (non sécurisé) est utilisé, sinon une simple info.
  if (password === "admin") {
    app.log.warn(
      "[auth] compte 'admin' créé avec le MOT DE PASSE PAR DÉFAUT 'admin' — " +
        "définir ADMIN_PASSWORD (.env) et/ou le changer au 1er login !",
    );
  } else {
    app.log.info("[auth] compte 'admin' créé (mot de passe depuis ADMIN_PASSWORD).");
  }
}

/**
 * Seed de règles d'alarme de démo (idempotent : seulement si la table est vide).
 * Calées sur les tags du simulateur brasserie pour que des alarmes se déclenchent
 * au fil des incidents du scénario. Désactivable via SEED_DEMO_ALARMS=0.
 */
async function seedDemoAlarms() {
  if (process.env.SEED_DEMO_ALARMS === "0") return;
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM alarm_rules");
  if (rows[0].n > 0) return;
  const demo = [
    // Seuils analogiques (Type A).
    { tag: "brasserie.ipa.fermenteur.temperature", operator: ">", threshold: 24, severity: "warning", message: "Fermentation IPA trop chaude", hysteresis: 1 },
    { tag: "brasserie.blonde.empateur.temperature", operator: ">", threshold: 70, severity: "critical", message: "Empâtage blonde en surchauffe (enzymes)", hysteresis: 2 },
    // Tags d'alarme booléens du simulateur (préfigure le Type B), condition == 1.
    { tag: "brasserie.ipa.fermenteur.defaut_thermique", operator: "==", threshold: 1, severity: "warning", message: "Défaut thermique fermenteur IPA", hysteresis: 0 },
    { tag: "brasserie.blonde.embouteilleuse.panne", operator: "==", threshold: 1, severity: "critical", message: "Panne embouteilleuse blonde", hysteresis: 0 },
    { tag: "brasserie.blonde.qualite_basse", operator: "==", threshold: 1, severity: "info", message: "Qualité ligne blonde dégradée", hysteresis: 0 },
  ];
  for (const r of demo) {
    await pool.query(
      `INSERT INTO alarm_rules (id, tag, operator, threshold, severity, message, hysteresis)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), r.tag, r.operator, r.threshold, r.severity, r.message, r.hysteresis],
    );
  }
  app.log.info(`[alarms] ${demo.length} règles de démo créées (SEED_DEMO_ALARMS=0 pour désactiver)`);
}

// --- Démarrage -------------------------------------------------------------
async function main() {
  await seedAdmin();
  await seedDemoRoles();
  await refreshTagCache();
  setInterval(() => refreshTagCache().catch(() => {}), 10_000); // garde le cache frais

  // Moteur d'alarmes : charge les règles, resynchronise l'état actif, puis
  // rafraîchit les règles périodiquement (les modifs via l'UI sont prises en compte).
  await seedDemoAlarms();
  await alarmEngine.refresh();
  await alarmEngine.hydrate();
  setInterval(() => alarmEngine.refresh().catch(() => {}), 10_000);
  await app.listen({ host: "0.0.0.0", port: PORT });
  for (;;) {
    try {
      await startConsumer();
      break;
    } catch (err) {
      app.log.warn(`consumer KO, retry dans 3s: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  // Consumer des anomalies RisingWave (topic tags.derived). Best-effort : si le
  // topic/profil risingwave n'est pas là, il retentera tout seul sans bloquer.
  startDerivedConsumer().catch((e) =>
    app.log.warn(`consumer derived indispo: ${(e as Error).message}`),
  );
}

main();

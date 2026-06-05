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

/** Crée une ligne `tags` par défaut pour un tag jamais vu (auto-découverte). */
async function ensureTagExists(name: string) {
  if (tagCache.has(name)) return;
  await pool.query(
    `INSERT INTO tags (name, label) VALUES ($1, $1)
     ON CONFLICT (name) DO NOTHING`,
    [name],
  );
  await refreshTagCache();
}

// --- Fastify ---------------------------------------------------------------
const app = Fastify({ logger: true });
await app.register(websocket);

/** Connexions WS actives. */
const clients = new Set<import("ws").WebSocket>();

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
  const q = req.query as { tag?: string; minutes?: string };
  const tag = q.tag;
  const minutes = Number(q.minutes ?? 15);
  if (!tag) return reply.code(400).send({ error: "param 'tag' requis" });
  const cfg = tagCache.get(tag);
  const scale = cfg?.scale ?? 1;
  const offset = cfg?.offset ?? 0;
  const { rows } = await pool.query(
    `SELECT ts, value * $2 + $3 AS value FROM mesures
     WHERE tag = $1 AND ts > now() - ($4 || ' minutes')::interval
     ORDER BY ts ASC`,
    [tag, scale, offset, minutes],
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
  f.get("/ws", { websocket: true }, (socket) => {
    clients.add(socket);
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
      // On pousse la valeur SCALÉE au navigateur (cohérent avec l'historique).
      const out = JSON.stringify({ ...m, value: scaled(m.tag, m.value) });
      for (const ws of clients) {
        if (ws.readyState === 1) ws.send(out); // 1 = OPEN
      }
    },
  });
  app.log.info("consumer Redpanda démarré sur tags.raw");
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
  app.log.warn(
    `[auth] compte 'admin' créé (mot de passe par défaut: '${password}') — à changer !`,
  );
}

// --- Démarrage -------------------------------------------------------------
async function main() {
  await seedAdmin();
  await refreshTagCache();
  setInterval(() => refreshTagCache().catch(() => {}), 10_000); // garde le cache frais
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
}

main();

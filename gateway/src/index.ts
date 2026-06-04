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

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "redpanda:9092").split(",");
const PG_DSN =
  process.env.PG_DSN ?? "postgres://strata:strata@timescaledb:5432/strata";
const PORT = Number(process.env.PORT ?? 3001);

// --- Postgres --------------------------------------------------------------
const pool = new pg.Pool({ connectionString: PG_DSN });

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

// Liste des tags configurés (avec métadonnées).
app.get("/api/tags", async () => {
  const { rows } = await pool.query(
    `SELECT name, label, unit, scale, offset_val AS offset, enabled, description
     FROM tags ORDER BY name`,
  );
  return rows;
});

// Upsert d'un tag.
app.post("/api/tags", async (req, reply) => {
  const b = req.body as Partial<TagConfig> & { name?: string };
  if (!b.name) return reply.code(400).send({ error: "champ 'name' requis" });
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
app.delete("/api/tags/:name", async (req) => {
  const { name } = req.params as { name: string };
  await pool.query("DELETE FROM tags WHERE name = $1", [name]);
  await refreshTagCache();
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

// Upsert d'une ligne de planning.
app.post("/api/shifts", async (req, reply) => {
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

// Suppression d'une ligne de planning.
app.delete("/api/shifts/:validFrom/:shiftNo", async (req) => {
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

// Définit/retire le rôle d'un tag. role=null pour retirer.
app.post("/api/tag-roles", async (req, reply) => {
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

app.register(async (f) => {
  f.get("/ws", { websocket: true }, (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
  });
});

// --- Consumer Redpanda : fan-out vers les WS (scaling appliqué) ------------
const kafka = new Kafka({
  clientId: "strata-gateway",
  brokers: KAFKA_BROKERS,
  logLevel: logLevel.WARN,
});

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

// --- Démarrage -------------------------------------------------------------
async function main() {
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

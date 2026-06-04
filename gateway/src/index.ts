/**
 * Gateway temps réel Strata.
 *
 *  - WS  /ws            : pousse en direct chaque mesure du topic Redpanda `tags.raw`.
 *  - GET /api/history   : renvoie l'historique d'un tag depuis TimescaleDB.
 *  - GET /api/tags      : liste les tags connus.
 *  - GET /health        : sonde de vie.
 */
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { Kafka, logLevel } from "kafkajs";
import pg from "pg";

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "redpanda:9092").split(",");
const PG_DSN =
  process.env.PG_DSN ??
  "postgres://strata:strata@timescaledb:5432/strata";
const PORT = Number(process.env.PORT ?? 3001);

// --- Postgres (historique) -------------------------------------------------
const pool = new pg.Pool({ connectionString: PG_DSN });

// --- Fastify ---------------------------------------------------------------
const app = Fastify({ logger: true });
await app.register(websocket);

/** Connexions WS actives. */
const clients = new Set<import("ws").WebSocket>();

app.get("/health", async () => ({ status: "ok" }));

app.get("/api/tags", async () => {
  const { rows } = await pool.query(
    "SELECT DISTINCT tag FROM mesures ORDER BY tag",
  );
  return rows.map((r) => r.tag);
});

app.get("/api/history", async (req) => {
  const q = req.query as { tag?: string; minutes?: string };
  const tag = q.tag;
  const minutes = Number(q.minutes ?? 15);
  if (!tag) return { error: "param 'tag' requis" };
  const { rows } = await pool.query(
    `SELECT ts, value FROM mesures
     WHERE tag = $1 AND ts > now() - ($2 || ' minutes')::interval
     ORDER BY ts ASC`,
    [tag, minutes],
  );
  return rows;
});

app.register(async (f) => {
  f.get("/ws", { websocket: true }, (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
  });
});

// --- Consumer Redpanda : fan-out vers les WS -------------------------------
const kafka = new Kafka({
  clientId: "strata-gateway",
  brokers: KAFKA_BROKERS,
  logLevel: logLevel.WARN,
});

async function startConsumer() {
  const consumer = kafka.consumer({ groupId: "strata-gateway-ws" });

  // Si le consumer crashe (ex: message dans un format non géré), KafkaJS émet
  // CRASH puis s'arrête. On le relance pour ne pas rester muet en silence.
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
      for (const ws of clients) {
        if (ws.readyState === 1) ws.send(payload); // 1 = OPEN
      }
    },
  });
  app.log.info("consumer Redpanda démarré sur tags.raw");
}

// --- Démarrage avec retry (le broker peut ne pas être prêt) ----------------
async function main() {
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

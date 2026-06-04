/**
 * Simulateur d'usine Strata (v0).
 *
 * Publie quelques tags en MQTT, sous le topic `factory/<groupe>/<nom>`.
 * Le payload est volontairement minimal : `{ "value": <number> }`.
 * C'est Redpanda Connect qui se charge de normaliser au contrat `tags.raw`
 * (ajout de ts, quality, source, dérivation du nom de tag depuis le topic MQTT).
 */
import mqtt from "mqtt";

const MQTT_URL = process.env.MQTT_URL ?? "tcp://mosquitto:1883";
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 1000);

type Tag = {
  /** topic MQTT, ex: factory/ligne1/compteur */
  topic: string;
  /** calcule la prochaine valeur */
  next: () => number;
};

// État interne du simulateur.
let compteur = 0;
const t0 = Date.now();

const tags: Tag[] = [
  {
    // Compteur de production : monotone croissant, ~1 pièce/s en moyenne.
    topic: "factory/ligne1/compteur",
    next: () => {
      if (Math.random() < 0.8) compteur += 1; // un peu d'irrégularité
      return compteur;
    },
  },
  {
    // Température : sinusoïde autour de 60 °C + bruit.
    topic: "factory/ligne1/temperature",
    next: () => {
      const t = (Date.now() - t0) / 1000;
      return 60 + 8 * Math.sin(t / 30) + (Math.random() - 0.5);
    },
  },
  {
    // Vitesse ligne : autour de 1500 tr/min + bruit.
    topic: "factory/ligne1/vitesse",
    next: () => 1500 + 50 * Math.sin(Date.now() / 7000) + (Math.random() - 0.5) * 10,
  },
];

const client = mqtt.connect(MQTT_URL, { reconnectPeriod: 2000 });

client.on("connect", () => {
  console.log(`[sim] connecté à ${MQTT_URL}, publication toutes les ${INTERVAL_MS} ms`);
  setInterval(() => {
    for (const tag of tags) {
      const value = Number(tag.next().toFixed(3));
      client.publish(tag.topic, JSON.stringify({ value }));
    }
  }, INTERVAL_MS);
});

client.on("error", (err) => console.error("[sim] erreur MQTT:", err.message));
client.on("reconnect", () => console.log("[sim] reconnexion…"));

process.on("SIGINT", () => client.end(true, () => process.exit(0)));
process.on("SIGTERM", () => client.end(true, () => process.exit(0)));

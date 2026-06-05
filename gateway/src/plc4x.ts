/**
 * Génération et déploiement des connecteurs PLC4X depuis la base (Phase « gestion
 * des tags »). Strata est la source de vérité : on génère le JSON du connecteur
 * source à partir d'un `device` et de ses `tags`, puis on le déploie via l'API
 * REST de Kafka Connect.
 *
 * Le format produit reprend celui des templates validés dans connectors/plc4x/.
 */
import pg from "pg";

const CONNECT_URL = process.env.KAFKA_CONNECT_URL ?? "http://kafka-connect:8083";

export type Device = {
  name: string;
  protocol: "modbus-tcp" | "s7" | "eip" | "simulated";
  host: string;
  options: string | null;
  poll_ms: number;
  enabled: boolean;
  base_tag: string | null;
};

export type DeviceTag = {
  name: string; // tag métier complet
  address: string | null; // adresse physique PLC4X
};

/** connectionString PLC4X pour un device. */
function connectionString(d: Device): string {
  const scheme = d.protocol === "modbus-tcp" ? "modbus-tcp" : d.protocol;
  const base = `${scheme}://${d.host}`;
  return d.options ? `${base}?${d.options}` : base;
}

/** Nom du connecteur Kafka Connect pour un device. */
export function connectorName(deviceName: string): string {
  return `strata-src-${deviceName}`;
}

/**
 * Construit la config du connecteur source PLC4X pour un device et ses tags.
 * Chaque tag devient une entrée du job, sous l'alias = son nom métier *relatif*
 * (on retire le base_tag pour ne pas le dupliquer ; le normaliseur le rajoute).
 */
export function buildSourceConnector(device: Device, tags: DeviceTag[]) {
  const usable = tags.filter((t) => t.address);
  const aliases: Record<string, string> = {};
  const tagNames: string[] = [];
  for (const t of usable) {
    // alias = nom du tag RELATIF au base_tag (ex: fermenteur.temperature). Le
    // normaliseur recompose le nom métier complet = sourceName + "." + alias.
    let alias = t.name;
    if (device.base_tag && alias.startsWith(device.base_tag + ".")) {
      alias = alias.slice(device.base_tag.length + 1);
    }
    aliases[alias] = t.address!;
    tagNames.push(alias);
  }

  // IMPORTANT : la `source` PLC4X est nommée d'après le base_tag métier
  // (ex: brasserie.ipa). Ainsi le normaliseur préfixe simplement avec le
  // sourceName, sans aucune table de correspondance codée en dur.
  const source = device.base_tag ?? device.name;

  const config: Record<string, string> = {
    "connector.class": "org.apache.plc4x.kafka.Plc4xSourceConnector",
    "tasks.max": "1",
    "default.topic": "plc.raw",
    sources: source,
    [`sources.${source}.connectionString`]: connectionString(device),
    [`sources.${source}.pollReturnInterval`]: String(device.poll_ms),
    [`sources.${source}.bufferSize`]: "100",
    [`sources.${source}.jobReferences`]: "scan",
    jobs: "scan",
    "jobs.scan.interval": String(device.poll_ms),
    "jobs.scan.tags": tagNames.join(","),
  };
  for (const [alias, address] of Object.entries(aliases)) {
    config[`jobs.scan.tags.${alias}`] = address;
  }
  return { name: connectorName(device.name), config };
}

// ─── Déploiement via l'API REST de Kafka Connect ───────────────────────────

export type DeployResult = { device: string; ok: boolean; detail: string };

async function connectFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${CONNECT_URL}${path}`, init);
}

/** Crée ou met à jour le connecteur d'un device (PUT config = idempotent). */
export async function deployDevice(
  pool: pg.Pool,
  deviceName: string,
): Promise<DeployResult> {
  const dRes = await pool.query("SELECT * FROM devices WHERE name = $1", [deviceName]);
  if (dRes.rows.length === 0) return { device: deviceName, ok: false, detail: "device inconnu" };
  const device = dRes.rows[0] as Device;

  const tRes = await pool.query(
    "SELECT name, address FROM tags WHERE device = $1 AND address IS NOT NULL",
    [deviceName],
  );
  const tags = tRes.rows as DeviceTag[];
  if (tags.length === 0)
    return { device: deviceName, ok: false, detail: "aucun tag avec adresse" };

  const { name, config } = buildSourceConnector(device, tags);
  try {
    const r = await connectFetch(`/connectors/${name}/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!r.ok) {
      const txt = await r.text();
      return { device: deviceName, ok: false, detail: `Connect ${r.status}: ${txt}` };
    }
    return { device: deviceName, ok: true, detail: `connecteur ${name} déployé (${tags.length} tags)` };
  } catch (err) {
    return {
      device: deviceName,
      ok: false,
      detail: `Kafka Connect injoignable (profil plc4x démarré ?): ${(err as Error).message}`,
    };
  }
}

/** Supprime le connecteur d'un device. */
export async function undeployDevice(deviceName: string): Promise<DeployResult> {
  try {
    const r = await connectFetch(`/connectors/${connectorName(deviceName)}`, {
      method: "DELETE",
    });
    return {
      device: deviceName,
      ok: r.ok || r.status === 404,
      detail: r.ok ? "connecteur supprimé" : `Connect ${r.status}`,
    };
  } catch (err) {
    return { device: deviceName, ok: false, detail: (err as Error).message };
  }
}

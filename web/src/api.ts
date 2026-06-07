/** Erreur HTTP enrichie du code de statut (pour distinguer 401/403…). */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Wrapper fetch : envoie le cookie de session et lève une ApiError si !ok. */
export async function api<T = unknown>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const r = await fetch(path, {
    credentials: "include",
    headers: opts.body ? { "content-type": "application/json", ...opts.headers } : opts.headers,
    ...opts,
  });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      msg = (await r.json()).error ?? msg;
    } catch {
      /* corps non-JSON */
    }
    throw new ApiError(r.status, msg);
  }
  // 204/sans corps -> null
  const text = await r.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** Config d'un tag telle qu'exposée par la gateway (Phase 2). */
export type Tag = {
  name: string;
  label: string | null;
  unit: string | null;
  scale: number;
  offset: number;
  enabled: boolean;
  description: string | null;
};

/** Une mesure poussée par la gateway (valeur déjà scalée). */
export type Mesure = {
  tag: string;
  value: number;
  ts: string;
  quality?: string;
  source?: string;
};

export const fetchTags = () => api<Tag[]>("/api/tags");

export const saveTag = (t: Tag) =>
  api<Tag>("/api/tags", { method: "POST", body: JSON.stringify(t) });

export const deleteTag = (name: string) =>
  api(`/api/tags/${encodeURIComponent(name)}`, { method: "DELETE" });

export const fetchHistory = (tag: string, minutes: number) =>
  api<{ ts: string; value: number }[]>(
    `/api/history?tag=${encodeURIComponent(tag)}&minutes=${minutes}`,
  );

/**
 * Historique sur une plage absolue [from, to] (ISO 8601). Mode « historique » de
 * l'Explorer. Nécessite le support `from`/`to` côté gateway (cf. contrat d'API).
 */
export const fetchHistoryRange = (tag: string, fromIso: string, toIso: string) =>
  api<{ ts: string; value: number }[]>(
    `/api/history?tag=${encodeURIComponent(tag)}&from=${encodeURIComponent(
      fromIso,
    )}&to=${encodeURIComponent(toIso)}`,
  );

/** Libellé d'affichage d'un tag : label si présent, sinon son nom. */
export function tagLabel(t: Tag): string {
  return t.label?.trim() ? t.label : t.name;
}

// ─── Production / shifts / rôles (Phase 3) ────────────────────────────────

export type ProductionRow = {
  day: string;
  shift_no: number;
  shift_label: string | null;
  ok: number | null;
  scrap: number | null;
  produced: number | null;
  available: number | null;
};

export type ShiftRow = {
  valid_from: string;
  shift_no: number;
  label: string | null;
  start_time: string;
  end_time: string;
};

export type TagRoleRow = { tag_name: string; role: string };

export const ROLES = ["produced", "ok", "scrap", "available"] as const;
export type Role = (typeof ROLES)[number];

export const fetchProduction = (days = 7) =>
  api<ProductionRow[]>(`/api/production?days=${days}`);

export const fetchShifts = () => api<ShiftRow[]>("/api/shifts");

export const saveShift = (s: ShiftRow) =>
  api("/api/shifts", { method: "POST", body: JSON.stringify(s) });

export const deleteShift = (validFrom: string, shiftNo: number) =>
  api(`/api/shifts/${validFrom}/${shiftNo}`, { method: "DELETE" });

export const fetchTagRoles = () => api<TagRoleRow[]>("/api/tag-roles");

export const saveTagRole = (tag_name: string, role: Role | "") =>
  api("/api/tag-roles", {
    method: "POST",
    body: JSON.stringify({ tag_name, role: role || null }),
  });

// ─── Auth & administration (Phase 7) ──────────────────────────────────────

export type Grant = { scope: string; action: "read" | "write" | "admin" };
export type AuthUser = {
  id: number;
  username: string;
  display_name: string | null;
  roles: string[];
  grants: Grant[];
};

export type UserRow = {
  id: number;
  username: string;
  display_name: string | null;
  enabled: boolean;
  roles: string[];
};

export type RoleRow = { name: string; description: string | null; grants: Grant[] };

export type AuditRow = {
  ts: string;
  username: string | null;
  action: string;
  target: string | null;
  detail: unknown;
};

export const login = (username: string, password: string) =>
  api<AuthUser>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });

export const logout = () => api("/api/auth/logout", { method: "POST" });
export const me = () => api<AuthUser | null>("/api/auth/me");

/** L'utilisateur a-t-il un droit admin (côté UI ; le backend reste l'autorité) ? */
export function userIsAdmin(u: AuthUser | null): boolean {
  return !!u?.grants.some((g) => g.action === "admin");
}

/** L'utilisateur peut-il écrire sur ce tag (vérif UI, le backend tranche) ? */
export function canWrite(u: AuthUser | null, tag = "*"): boolean {
  if (!u) return false;
  const covers = (scope: string) =>
    scope === "*" || scope === "" || tag === scope || tag.startsWith(scope + ".");
  return u.grants.some(
    (g) => (g.action === "write" || g.action === "admin") && covers(g.scope),
  );
}

export const fetchUsers = () => api<UserRow[]>("/api/users");
export const createUser = (u: {
  username: string;
  password: string;
  display_name?: string;
  roles?: string[];
}) => api<{ id: number }>("/api/users", { method: "POST", body: JSON.stringify(u) });
export const setUserRoles = (id: number, roles: string[]) =>
  api(`/api/users/${id}/roles`, { method: "PUT", body: JSON.stringify({ roles }) });
export const setUserEnabled = (id: number, enabled: boolean) =>
  api(`/api/users/${id}/enabled`, { method: "PUT", body: JSON.stringify({ enabled }) });
export const resetUserPassword = (id: number, password: string) =>
  api(`/api/users/${id}/password`, { method: "PUT", body: JSON.stringify({ password }) });

export const fetchRoles = () => api<RoleRow[]>("/api/roles");
export const setRoleGrants = (name: string, grants: Grant[]) =>
  api(`/api/roles/${name}/grants`, { method: "PUT", body: JSON.stringify({ grants }) });

export const fetchAudit = (limit = 100) => api<AuditRow[]>(`/api/audit?limit=${limit}`);

/** Écrit une consigne (Phase 8). Le backend vérifie le droit write sur le tag. */
export const sendCommand = (tag: string, value: number) =>
  api<{ ok: boolean }>("/api/command", {
    method: "POST",
    body: JSON.stringify({ tag, value }),
  });

// ─── Automates (devices) & adresses (gestion des tags) ─────────────────────

export const PROTOCOLS = ["modbus-tcp", "s7", "eip", "simulated"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export type Device = {
  name: string;
  protocol: Protocol;
  host: string;
  options: string | null;
  poll_ms: number;
  enabled: boolean;
  base_tag: string | null;
  tag_count: number;
};

export type DeviceTag = {
  name: string;
  label: string | null;
  unit: string | null;
  address: string | null;
  datatype: string | null;
  enabled: boolean;
};

export type DeployResult = { device: string; ok: boolean; detail: string };

export const fetchDevices = () => api<Device[]>("/api/devices");
export const saveDevice = (d: Partial<Device>) =>
  api("/api/devices", { method: "POST", body: JSON.stringify(d) });
export const deleteDevice = (name: string) =>
  api(`/api/devices/${encodeURIComponent(name)}`, { method: "DELETE" });
export const fetchDeviceTags = (name: string) =>
  api<DeviceTag[]>(`/api/devices/${encodeURIComponent(name)}/tags`);
export const saveTagAddress = (
  tag: string,
  device: string | null,
  address: string | null,
  datatype: string | null,
) =>
  api(`/api/tags/${encodeURIComponent(tag)}/address`, {
    method: "POST",
    body: JSON.stringify({ device, address, datatype }),
  });
export const importTagsCsv = (device: string, csv: string) =>
  api<{ imported: number; errors: string[] }>(
    `/api/devices/${encodeURIComponent(device)}/import`,
    { method: "POST", body: JSON.stringify({ csv }) },
  );
export const deployDevice = (name: string) =>
  api<DeployResult>(`/api/devices/${encodeURIComponent(name)}/deploy`, {
    method: "POST",
  });
export const undeployDevice = (name: string) =>
  api<DeployResult>(`/api/devices/${encodeURIComponent(name)}/undeploy`, {
    method: "POST",
  });

// ─── Paramètres ────────────────────────────────────────────────────────────

export const changeMyPassword = (current: string, next: string) =>
  api("/api/auth/password", {
    method: "POST",
    body: JSON.stringify({ current, next }),
  });

export type Storage = {
  size: { total: string; rows: string };
  compression: { before: string | null; after: string | null; before_b: string | null; after_b: string | null };
  retention_after: string | null;
  compress_after: string | null;
};

export const fetchStorage = () => api<Storage>("/api/storage");
export const setRetention = (days: number) =>
  api("/api/storage/retention", { method: "POST", body: JSON.stringify({ days }) });
export const setCompression = (days: number) =>
  api("/api/storage/compression", { method: "POST", body: JSON.stringify({ days }) });

export type SystemInfo = {
  counts: { tags: number; devices: number; users: number; mesures: string };
  timescaledb_version: string;
  node_version: string;
  connectors: { name: string; state: string }[];
};

export const fetchSystem = () => api<SystemInfo>("/api/system");

// ─── Dashboards (multi-plots sauvegardés, privés par utilisateur) ──────────

export type PanelSeries = { tag: string; axis: "left" | "right" };
export type DashboardPanel = { id: string; title: string; series: PanelSeries[] };
export type DashboardRange =
  | { mode: "relative"; sec: number }
  | { mode: "absolute"; from: string; to: string };
export type DashboardSpec = {
  panels: DashboardPanel[];
  range: DashboardRange;
  refreshSec: number;
};

export type DashboardSummary = { id: string; name: string; updated_at: string };
export type Dashboard = {
  id: string;
  name: string;
  spec: DashboardSpec;
  updated_at: string;
};

export const fetchDashboards = () => api<DashboardSummary[]>("/api/dashboards");
export const fetchDashboard = (id: string) =>
  api<Dashboard>(`/api/dashboards/${encodeURIComponent(id)}`);
export const createDashboard = (name: string, spec: DashboardSpec) =>
  api<Dashboard>("/api/dashboards", {
    method: "POST",
    body: JSON.stringify({ name, spec }),
  });
export const updateDashboard = (id: string, name: string, spec: DashboardSpec) =>
  api<Dashboard>(`/api/dashboards/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ name, spec }),
  });
export const deleteDashboard = (id: string) =>
  api(`/api/dashboards/${encodeURIComponent(id)}`, { method: "DELETE" });

// ─── Alarmes (Phase A : seuils calculés par Strata) ────────────────────────

export type Severity = "critical" | "warning" | "info";
export const ALARM_OPERATORS = [">", ">=", "<", "<=", "==", "!="] as const;
export type AlarmOperator = (typeof ALARM_OPERATORS)[number];

export type AlarmRule = {
  id: string;
  tag: string;
  operator: AlarmOperator;
  threshold: number;
  severity: Severity;
  message: string | null;
  for_ms?: number;
  hysteresis?: number;
  enabled: boolean;
};

export type Alarm = {
  id: string;
  rule_id: string | null;
  source: "rule" | "tag";
  tag: string;
  severity: Severity;
  message: string;
  value: number | null;
  state: "active" | "cleared";
  raised_at: string;
  cleared_at: string | null;
  acked: boolean;
  acked_by: string | null;
  acked_at: string | null;
};

export const fetchAlarmRules = () => api<AlarmRule[]>("/api/alarm-rules");
export const saveAlarmRule = (rule: Omit<AlarmRule, "id"> & { id?: string }) =>
  rule.id
    ? api<AlarmRule>(`/api/alarm-rules/${encodeURIComponent(rule.id)}`, {
        method: "PUT",
        body: JSON.stringify(rule),
      })
    : api<AlarmRule>("/api/alarm-rules", { method: "POST", body: JSON.stringify(rule) });
export const deleteAlarmRule = (id: string) =>
  api(`/api/alarm-rules/${encodeURIComponent(id)}`, { method: "DELETE" });

export const fetchAlarms = () => api<Alarm[]>("/api/alarms");
export const ackAlarm = (id: string) =>
  api<Alarm>(`/api/alarms/${encodeURIComponent(id)}/ack`, { method: "POST" });

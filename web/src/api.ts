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

export async function fetchTags(): Promise<Tag[]> {
  const r = await fetch("/api/tags");
  return r.json();
}

export async function saveTag(t: Tag): Promise<Tag> {
  const r = await fetch("/api/tags", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(t),
  });
  return r.json();
}

export async function deleteTag(name: string): Promise<void> {
  await fetch(`/api/tags/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export async function fetchHistory(
  tag: string,
  minutes: number,
): Promise<{ ts: string; value: number }[]> {
  const r = await fetch(
    `/api/history?tag=${encodeURIComponent(tag)}&minutes=${minutes}`,
  );
  return r.json();
}

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

export async function fetchProduction(days = 7): Promise<ProductionRow[]> {
  const r = await fetch(`/api/production?days=${days}`);
  return r.json();
}

export async function fetchShifts(): Promise<ShiftRow[]> {
  const r = await fetch("/api/shifts");
  return r.json();
}

export async function saveShift(s: ShiftRow): Promise<void> {
  await fetch("/api/shifts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(s),
  });
}

export async function deleteShift(validFrom: string, shiftNo: number): Promise<void> {
  await fetch(`/api/shifts/${validFrom}/${shiftNo}`, { method: "DELETE" });
}

export async function fetchTagRoles(): Promise<TagRoleRow[]> {
  const r = await fetch("/api/tag-roles");
  return r.json();
}

export async function saveTagRole(tag_name: string, role: Role | ""): Promise<void> {
  await fetch("/api/tag-roles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tag_name, role: role || null }),
  });
}

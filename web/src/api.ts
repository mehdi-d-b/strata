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

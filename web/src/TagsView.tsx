import { useEffect, useState } from "react";
import { deleteTag, fetchTags, saveTag, type Tag } from "./api";

/** Page de paramétrage : tableau éditable des tags. */
export function TagsView() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [savingName, setSavingName] = useState<string | null>(null);

  const load = () => fetchTags().then(setTags).catch(() => setTags([]));
  useEffect(() => {
    load();
  }, []);

  // Édition locale d'une ligne (sans persister tant qu'on ne sauve pas).
  const patch = (name: string, p: Partial<Tag>) =>
    setTags((ts) => ts.map((t) => (t.name === name ? { ...t, ...p } : t)));

  const onSave = async (t: Tag) => {
    setSavingName(t.name);
    await saveTag(t);
    setSavingName(null);
  };

  const onDelete = async (name: string) => {
    if (!confirm(`Supprimer la config du tag "${name}" ?`)) return;
    await deleteTag(name);
    load();
  };

  return (
    <div className="card">
      <table className="tags">
        <thead>
          <tr>
            <th>Tag</th>
            <th>Libellé</th>
            <th>Unité</th>
            <th>Échelle</th>
            <th>Offset</th>
            <th>Activé</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {tags.map((t) => (
            <tr key={t.name}>
              <td><code>{t.name}</code></td>
              <td>
                <input
                  value={t.label ?? ""}
                  onChange={(e) => patch(t.name, { label: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="narrow"
                  value={t.unit ?? ""}
                  onChange={(e) => patch(t.name, { unit: e.target.value })}
                />
              </td>
              <td>
                <input
                  className="narrow"
                  type="number"
                  step="any"
                  value={t.scale}
                  onChange={(e) =>
                    patch(t.name, { scale: Number(e.target.value) })
                  }
                />
              </td>
              <td>
                <input
                  className="narrow"
                  type="number"
                  step="any"
                  value={t.offset}
                  onChange={(e) =>
                    patch(t.name, { offset: Number(e.target.value) })
                  }
                />
              </td>
              <td style={{ textAlign: "center" }}>
                <input
                  type="checkbox"
                  checked={t.enabled}
                  onChange={(e) => patch(t.name, { enabled: e.target.checked })}
                />
              </td>
              <td>
                <button onClick={() => onSave(t)} disabled={savingName === t.name}>
                  {savingName === t.name ? "…" : "Enregistrer"}
                </button>
                <button className="ghost" onClick={() => onDelete(t.name)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
          {tags.length === 0 && (
            <tr>
              <td colSpan={7} style={{ color: "var(--muted-foreground)" }}>
                Aucun tag pour l'instant. Les tags apparaissent automatiquement
                dès que des données arrivent.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="hint">
        L'échelle et l'offset sont appliqués à la lecture :{" "}
        <code>valeur affichée = valeur brute × échelle + offset</code>. La donnée
        brute reste intacte en base — corriger une échelle répare tout
        l'historique.
      </p>
    </div>
  );
}

import { useEffect, useState } from "react";
import {
  ROLES,
  deleteShift,
  fetchProduction,
  fetchShifts,
  fetchTagRoles,
  fetchTags,
  saveShift,
  saveTagRole,
  type ProductionRow,
  type Role,
  type ShiftRow,
  type Tag,
  type TagRoleRow,
} from "./api";

/** Taux de rebut = scrap / (ok + scrap). */
function scrapRate(r: ProductionRow): string {
  const ok = r.ok ?? 0;
  const scrap = r.scrap ?? 0;
  const total = ok + scrap;
  if (!total) return "—";
  return `${((scrap / total) * 100).toFixed(1)} %`;
}

export function ProductionView() {
  const [prod, setProd] = useState<ProductionRow[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [roles, setRoles] = useState<TagRoleRow[]>([]);

  const loadAll = () => {
    fetchProduction(7).then(setProd).catch(() => setProd([]));
    fetchShifts().then(setShifts).catch(() => setShifts([]));
    fetchTags().then(setTags).catch(() => setTags([]));
    fetchTagRoles().then(setRoles).catch(() => setRoles([]));
  };
  useEffect(loadAll, []);

  const roleOf = (tagName: string): Role | "" =>
    (roles.find((r) => r.tag_name === tagName)?.role as Role) ?? "";

  const onRoleChange = async (tagName: string, role: Role | "") => {
    await saveTagRole(tagName, role);
    fetchTagRoles().then(setRoles);
    // La prod se recalcule côté vues SQL ; on rafraîchit après un court délai.
    setTimeout(() => fetchProduction(7).then(setProd), 300);
  };

  // Édition planning : nouvelle ligne vierge.
  const addShiftRow = () => {
    const today = new Date().toISOString().slice(0, 10);
    setShifts((s) => [
      { valid_from: today, shift_no: 1, label: "", start_time: "06:00", end_time: "14:00" },
      ...s,
    ]);
  };
  const patchShift = (i: number, p: Partial<ShiftRow>) =>
    setShifts((s) => s.map((row, idx) => (idx === i ? { ...row, ...p } : row)));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* ─── Tableau de production ─────────────────────────────── */}
      <div className="card">
        <h2 className="card-title">Production par shift</h2>
        <table className="tags">
          <thead>
            <tr>
              <th>Date</th>
              <th>Shift</th>
              <th>OK</th>
              <th>Rebut</th>
              <th>Produit</th>
              <th>Dispo</th>
              <th>Taux rebut</th>
            </tr>
          </thead>
          <tbody>
            {prod.map((r) => (
              <tr key={`${r.day}-${r.shift_no}`}>
                <td>{r.day.slice(0, 10)}</td>
                <td>{r.shift_label ?? `#${r.shift_no}`}</td>
                <td>{r.ok ?? "—"}</td>
                <td style={{ color: r.scrap ? "#f0883e" : undefined }}>
                  {r.scrap ?? "—"}
                </td>
                <td>{r.produced ?? "—"}</td>
                <td>{r.available ?? "—"}</td>
                <td>{scrapRate(r)}</td>
              </tr>
            ))}
            {prod.length === 0 && (
              <tr>
                <td colSpan={7} style={{ color: "#8b97a7" }}>
                  Aucune production calculée. Mappe des tags compteurs à des rôles
                  ci-dessous (OK / rebut…).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ─── Mapping des rôles ─────────────────────────────────── */}
      <div className="card">
        <h2 className="card-title">Rôles des compteurs</h2>
        <table className="tags">
          <thead>
            <tr>
              <th>Tag</th>
              <th>Rôle de production</th>
            </tr>
          </thead>
          <tbody>
            {tags.map((t) => (
              <tr key={t.name}>
                <td><code>{t.name}</code></td>
                <td>
                  <select
                    value={roleOf(t.name)}
                    onChange={(e) => onRoleChange(t.name, e.target.value as Role | "")}
                  >
                    <option value="">— aucun —</option>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">
          Déclare quel compteur représente quoi. <code>ok</code> = pièces bonnes,{" "}
          <code>scrap</code> = rebut, <code>produced</code> = total,{" "}
          <code>available</code> = disponibles.
        </p>
      </div>

      {/* ─── Planning de shifts versionné ──────────────────────── */}
      <div className="card">
        <h2 className="card-title">
          Planning de shifts
          <button className="add" onClick={addShiftRow}>
            + Ajouter
          </button>
        </h2>
        <table className="tags">
          <thead>
            <tr>
              <th>Valable à partir du</th>
              <th>N°</th>
              <th>Libellé</th>
              <th>Début</th>
              <th>Fin</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shifts.map((s, i) => (
              <tr key={`${s.valid_from}-${s.shift_no}-${i}`}>
                <td>
                  <input
                    type="date"
                    value={s.valid_from.slice(0, 10)}
                    onChange={(e) => patchShift(i, { valid_from: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="narrow"
                    type="number"
                    value={s.shift_no}
                    onChange={(e) => patchShift(i, { shift_no: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    value={s.label ?? ""}
                    onChange={(e) => patchShift(i, { label: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="narrow"
                    type="time"
                    value={s.start_time.slice(0, 5)}
                    onChange={(e) => patchShift(i, { start_time: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="narrow"
                    type="time"
                    value={s.end_time.slice(0, 5)}
                    onChange={(e) => patchShift(i, { end_time: e.target.value })}
                  />
                </td>
                <td>
                  <button
                    onClick={async () => {
                      await saveShift(s);
                      setTimeout(() => fetchProduction(7).then(setProd), 300);
                    }}
                  >
                    Enregistrer
                  </button>
                  <button
                    className="ghost"
                    onClick={async () => {
                      await deleteShift(s.valid_from, s.shift_no);
                      loadAll();
                    }}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">
          Le planning est <strong>versionné</strong> : pour passer de 2 à 3 shifts
          ou changer des horaires, ajoute des lignes avec une nouvelle date d'effet.
          L'historique d'avant garde son ancienne config.
        </p>
      </div>
    </div>
  );
}

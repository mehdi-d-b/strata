import { useEffect, useState } from "react";
import {
  createUser,
  fetchAudit,
  fetchRoles,
  fetchUsers,
  resetUserPassword,
  setRoleGrants,
  setUserEnabled,
  setUserRoles,
  type AuditRow,
  type Grant,
  type RoleRow,
  type UserRow,
} from "./api";

type Section = "users" | "roles" | "audit";

export function AdminView() {
  const [section, setSection] = useState<Section>("users");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="subnav">
        {(["users", "roles", "audit"] as Section[]).map((s) => (
          <button
            key={s}
            className={section === s ? "active" : ""}
            onClick={() => setSection(s)}
          >
            {s === "users" ? "Utilisateurs" : s === "roles" ? "Rôles & droits" : "Audit"}
          </button>
        ))}
      </div>
      {section === "users" && <UsersSection />}
      {section === "roles" && <RolesSection />}
      {section === "audit" && <AuditSection />}
    </div>
  );
}

// ─── Utilisateurs ──────────────────────────────────────────────────────────

function UsersSection() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [nu, setNu] = useState({ username: "", password: "", display_name: "" });

  const load = () => {
    fetchUsers().then(setUsers).catch(() => setUsers([]));
    fetchRoles().then(setRoles).catch(() => setRoles([]));
  };
  useEffect(() => {
    load();
  }, []);

  const allRoles = roles.map((r) => r.name);

  const toggleRole = async (u: UserRow, role: string) => {
    const next = u.roles.includes(role)
      ? u.roles.filter((r) => r !== role)
      : [...u.roles, role];
    await setUserRoles(u.id, next);
    load();
  };

  const onCreate = async () => {
    if (!nu.username || !nu.password) return;
    await createUser(nu);
    setNu({ username: "", password: "", display_name: "" });
    load();
  };

  const onReset = async (u: UserRow) => {
    const pw = prompt(`Nouveau mot de passe pour ${u.username} :`);
    if (pw) await resetUserPassword(u.id, pw);
  };

  return (
    <div className="card">
      <h2 className="card-title">Utilisateurs</h2>
      <table className="tags">
        <thead>
          <tr>
            <th>Utilisateur</th>
            <th>Nom</th>
            <th>Rôles</th>
            <th>Actif</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td><code>{u.username}</code></td>
              <td>{u.display_name ?? "—"}</td>
              <td>
                <div className="chips">
                  {allRoles.map((r) => (
                    <button
                      key={r}
                      className={`chip ${u.roles.includes(r) ? "on" : ""}`}
                      onClick={() => toggleRole(u, r)}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </td>
              <td style={{ textAlign: "center" }}>
                <input
                  type="checkbox"
                  checked={u.enabled}
                  onChange={(e) => setUserEnabled(u.id, e.target.checked).then(load)}
                />
              </td>
              <td>
                <button onClick={() => onReset(u)}>Mot de passe…</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="newrow">
        <input
          placeholder="identifiant"
          value={nu.username}
          onChange={(e) => setNu({ ...nu, username: e.target.value })}
        />
        <input
          placeholder="nom affiché"
          value={nu.display_name}
          onChange={(e) => setNu({ ...nu, display_name: e.target.value })}
        />
        <input
          type="password"
          placeholder="mot de passe"
          value={nu.password}
          onChange={(e) => setNu({ ...nu, password: e.target.value })}
        />
        <button className="add" onClick={onCreate}>
          + Créer
        </button>
      </div>
    </div>
  );
}

// ─── Rôles & droits ─────────────────────────────────────────────────────────

const ACTIONS: Grant["action"][] = ["read", "write", "admin"];

function RolesSection() {
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const load = () => fetchRoles().then(setRoles).catch(() => setRoles([]));
  useEffect(() => {
    load();
  }, []);

  const addGrant = async (role: RoleRow) => {
    const scope = prompt(
      "Préfixe de tag (ex: brasserie.blonde, ou * pour tout) :",
      "*",
    );
    if (scope === null) return;
    const action = prompt("Action (read / write / admin) :", "read") as Grant["action"];
    if (!ACTIONS.includes(action)) return;
    await setRoleGrants(role.name, [...role.grants, { scope: scope || "*", action }]);
    load();
  };

  const removeGrant = async (role: RoleRow, idx: number) => {
    const next = role.grants.filter((_, i) => i !== idx);
    await setRoleGrants(role.name, next);
    load();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {roles.map((role) => (
        <div className="card" key={role.name}>
          <h2 className="card-title">
            {role.name}
            <button className="add" onClick={() => addGrant(role)}>
              + Droit
            </button>
          </h2>
          {role.description && <p className="hint">{role.description}</p>}
          <div className="chips">
            {role.grants.length === 0 && (
              <span style={{ color: "var(--muted-foreground)" }}>aucun droit</span>
            )}
            {role.grants.map((g, i) => (
              <span key={i} className={`grant grant-${g.action}`}>
                {g.action} : <code>{g.scope}</code>
                <button className="x" onClick={() => removeGrant(role, i)}>
                  ✕
                </button>
              </span>
            ))}
          </div>
        </div>
      ))}
      <p className="hint">
        Un droit <code>write</code> sur <code>brasserie.blonde</code> autorise
        l'écriture sur tous les tags de cette ligne. <code>*</code> = tout.
        <code> admin</code> donne accès à cette page et à toutes les écritures.
      </p>
    </div>
  );
}

// ─── Audit ───────────────────────────────────────────────────────────────────

function AuditSection() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  useEffect(() => {
    fetchAudit(100).then(setRows).catch(() => setRows([]));
  }, []);

  return (
    <div className="card">
      <h2 className="card-title">Journal d'audit</h2>
      <table className="tags">
        <thead>
          <tr>
            <th>Date</th>
            <th>Utilisateur</th>
            <th>Action</th>
            <th>Cible</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{new Date(r.ts).toLocaleString()}</td>
              <td>{r.username ?? "—"}</td>
              <td><code>{r.action}</code></td>
              <td>{r.target ?? "—"}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} style={{ color: "var(--muted-foreground)" }}>
                Aucune entrée.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

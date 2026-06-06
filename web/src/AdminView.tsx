import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
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
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type Tab = "users" | "roles" | "audit";
const TABS: { id: Tab; label: string }[] = [
  { id: "users", label: "Utilisateurs" },
  { id: "roles", label: "Rôles & droits" },
  { id: "audit", label: "Audit" },
];

export function AdminView() {
  const [tab, setTab] = useState<Tab>("users");
  return (
    <>
      <PageHeader
        title="Administration"
        description="Utilisateurs, rôles & droits, journal d'audit."
      />
      <div className="flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "rounded-md border px-3 py-1.5 text-sm transition-colors",
              tab === t.id
                ? "border-primary bg-card text-foreground"
                : "border-border bg-secondary text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "users" && <UsersSection />}
      {tab === "roles" && <RolesSection />}
      {tab === "audit" && <AuditSection />}
    </>
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
    <Section title="Utilisateurs">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Utilisateur</TableHead>
            <TableHead>Nom</TableHead>
            <TableHead>Rôles</TableHead>
            <TableHead className="text-center">Actif</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <TableRow key={u.id}>
              <TableCell>
                <code className="text-[var(--chart-2)]">{u.username}</code>
              </TableCell>
              <TableCell>{u.display_name ?? "—"}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1.5">
                  {allRoles.map((r) => {
                    const on = u.roles.includes(r);
                    return (
                      <button
                        key={r}
                        onClick={() => toggleRole(u, r)}
                        className={cn(
                          "rounded-full border px-3 py-0.5 text-xs transition-colors",
                          on
                            ? "border-good/45 bg-good/15 text-good"
                            : "border-border bg-background text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {r}
                      </button>
                    );
                  })}
                </div>
              </TableCell>
              <TableCell className="text-center">
                <input
                  type="checkbox"
                  checked={u.enabled}
                  onChange={(e) => setUserEnabled(u.id, e.target.checked).then(load)}
                />
              </TableCell>
              <TableCell>
                <Button size="sm" variant="outline" onClick={() => onReset(u)}>
                  Mot de passe…
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Input
          className="w-44"
          placeholder="identifiant"
          value={nu.username}
          onChange={(e) => setNu({ ...nu, username: e.target.value })}
        />
        <Input
          className="w-44"
          placeholder="nom affiché"
          value={nu.display_name}
          onChange={(e) => setNu({ ...nu, display_name: e.target.value })}
        />
        <Input
          type="password"
          className="w-44"
          placeholder="mot de passe"
          value={nu.password}
          onChange={(e) => setNu({ ...nu, password: e.target.value })}
        />
        <Button size="sm" variant="outline" onClick={onCreate}>
          <Plus />
          Créer
        </Button>
      </div>
    </Section>
  );
}

// ─── Rôles & droits ─────────────────────────────────────────────────────────

const ACTIONS: Grant["action"][] = ["read", "write", "admin"];

const grantTone: Record<Grant["action"], string> = {
  read: "border-border text-muted-foreground",
  write: "border-good/45 text-good",
  admin: "border-chart-4/50 text-chart-4",
};

function RolesSection() {
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const load = () => fetchRoles().then(setRoles).catch(() => setRoles([]));
  useEffect(() => {
    load();
  }, []);

  const addGrant = async (role: RoleRow) => {
    const scope = prompt("Préfixe de tag (ex: brasserie.blonde, ou * pour tout) :", "*");
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
    <>
      {roles.map((role) => (
        <Section
          key={role.name}
          title={role.name}
          action={
            <Button size="sm" variant="outline" onClick={() => addGrant(role)}>
              <Plus />
              Droit
            </Button>
          }
        >
          {role.description && (
            <p className="mb-2 text-xs text-muted-foreground">{role.description}</p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {role.grants.length === 0 && (
              <span className="text-sm text-muted-foreground">aucun droit</span>
            )}
            {role.grants.map((g, i) => (
              <span
                key={i}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-0.5 text-xs",
                  grantTone[g.action],
                )}
              >
                {g.action} : <code>{g.scope}</code>
                <button
                  className="text-destructive hover:opacity-80"
                  title="Retirer"
                  onClick={() => removeGrant(role, i)}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        </Section>
      ))}
      <p className="px-1 text-xs text-muted-foreground">
        Un droit <code>write</code> sur <code>brasserie.blonde</code> autorise
        l'écriture sur tous les tags de cette ligne. <code>*</code> = tout.{" "}
        <code>admin</code> donne accès à cette page et à toutes les écritures.
      </p>
    </>
  );
}

// ─── Audit ───────────────────────────────────────────────────────────────────

function AuditSection() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  useEffect(() => {
    fetchAudit(100).then(setRows).catch(() => setRows([]));
  }, []);

  return (
    <Section title="Journal d'audit">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Utilisateur</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Cible</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>
              <TableCell className="tabular-nums">
                {new Date(r.ts).toLocaleString()}
              </TableCell>
              <TableCell>{r.username ?? "—"}</TableCell>
              <TableCell>
                <code className="text-[var(--chart-2)]">{r.action}</code>
              </TableCell>
              <TableCell>{r.target ?? "—"}</TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="text-muted-foreground">
                Aucune entrée.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Section>
  );
}

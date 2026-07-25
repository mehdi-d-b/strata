import { useEffect, useRef, useState } from "react";
import { FileText, Plus, Upload, X } from "lucide-react";
import { toast } from "sonner";
import {
  createUser,
  fetchAudit,
  fetchKnowledge,
  fetchRoles,
  fetchUsers,
  knowledgeFileUrl,
  resetUserPassword,
  setRoleGrants,
  setUserEnabled,
  setUserRoles,
  uploadKnowledgePdf,
  type AuditRow,
  type Grant,
  type KnowledgeDoc,
  type RoleRow,
  type UserRow,
} from "./api";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/Section";
import { TabBar } from "@/components/TabBar";
import { Badge } from "@/components/ui/badge";
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

type Tab = "users" | "roles" | "audit" | "knowledge" | "assistant";
const TABS: { id: Tab; label: string }[] = [
  { id: "users", label: "Utilisateurs" },
  { id: "roles", label: "Rôles & droits" },
  { id: "audit", label: "Audit" },
  { id: "knowledge", label: "Base de connaissances" },
  { id: "assistant", label: "Assistant IA" },
];

export function AdminView() {
  const [tab, setTab] = useState<Tab>("users");
  return (
    <>
      <PageHeader
        title="Administration"
        description="Utilisateurs, rôles & droits, journal d'audit."
      />
      <TabBar tabs={TABS} value={tab} onChange={setTab} />
      {tab === "users" && <UsersSection />}
      {tab === "roles" && <RolesSection />}
      {tab === "audit" && <AuditSection />}
      {tab === "knowledge" && <KnowledgeSection />}
      {tab === "assistant" && <AssistantSection />}
    </>
  );
}

// ─── Base de connaissances (RAG) — étape 7 ─────────────────────────────────
// Remplace le script CLI (ai-service/ingest.py) par une vraie interface :
// liste des documents (chunks PDF regroupés par fichier), statut d'embedding,
// upload. Le PDF est lu côté navigateur (FileReader -> base64) et envoyé en
// JSON — même convention que importTagsCsv pour le CSV, pas de multipart.
function KnowledgeSection() {
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = () => fetchKnowledge().then(setDocs).catch(() => setDocs([]));
  useEffect(() => {
    load();
  }, []);

  const onFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const r = await uploadKnowledgePdf(file.name, base64);
      toast.success(`« ${r.filename} » ingéré — ${r.chunks} chunk(s).`);
      load();
    } catch {
      toast.error("Échec de l'ingestion du PDF.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <Section
      title="Documents (RAG)"
      hint="PDF ingérés dans la base de connaissances — utilisés par l'assistant (search_knowledge)."
      action={
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={onFileSelected}
          />
          <Button size="sm" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
            <Upload />
            {uploading ? "Ingestion…" : "Importer un PDF"}
          </Button>
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Document</TableHead>
            <TableHead>Catégorie</TableHead>
            <TableHead>Chunks</TableHead>
            <TableHead>Mis à jour</TableHead>
            <TableHead>Embeddings</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {docs.map((d) => (
            <TableRow key={`${d.category}-${d.doc_name}`}>
              <TableCell>{d.doc_name}</TableCell>
              <TableCell className="text-muted-foreground">{d.category}</TableCell>
              <TableCell className="tabular-nums">{d.chunks}</TableCell>
              <TableCell className="tabular-nums">{new Date(d.updated_at).toLocaleString()}</TableCell>
              <TableCell>
                <Badge variant={d.embedded ? "outline" : "destructive"}>
                  {d.embedded ? "OK" : "manquant"}
                </Badge>
              </TableCell>
              <TableCell>
                {d.has_file && (
                  <Button size="sm" variant="ghost" asChild>
                    <a href={knowledgeFileUrl(d.category, d.doc_name)} target="_blank" rel="noreferrer">
                      <FileText />
                      Ouvrir le PDF
                    </a>
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
          {docs.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-muted-foreground">
                Aucun document dans la base de connaissances.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Section>
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

// ─── Assistant IA ────────────────────────────────────────────────────────────
function AssistantSection() {
  return (
    <Section
      title="Assistant IA"
      hint="Le service assistant est accessible uniquement via la gateway authentifiée."
    >
      <p className="text-sm text-muted-foreground">
        Le service LangGraph n'expose plus de port hôte : cela empêche de contourner
        l'authentification de Strata. Pour déboguer localement, utilisez un override Docker
        temporaire qui publie le port uniquement sur votre poste de développement.
      </p>
    </Section>
  );
}

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  ApiError,
  ROLES,
  canWrite,
  deleteShift,
  fetchHistory,
  fetchOeeLines,
  fetchProduction,
  fetchShifts,
  fetchTagRoles,
  fetchTags,
  saveShift,
  saveTagRole,
  executeOperation,
  type OeeLine,
  type ProductionRow,
  type Role,
  type ShiftRow,
  type Tag,
  type TagRoleRow,
} from "./api";
import { useAuth } from "./auth";
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

/** Taux de rebut = scrap / (ok + scrap). */
function scrapRate(r: ProductionRow): string {
  const ok = r.ok ?? 0;
  const scrap = r.scrap ?? 0;
  const total = ok + scrap;
  if (!total) return "—";
  return `${((scrap / total) * 100).toFixed(1)} %`;
}

// ─── Pilotage : démarrer/arrêter une ligne ─────────────────────────────────
// Passe par le catalogue d'opérations de la gateway. Celle-ci résout le tag de
// marche configuré, vérifie le RBAC et refuse notamment un arrêt normal en plein
// batch ; cette UI et l'assistant appliquent donc les mêmes garde-fous.
function PilotageSection() {
  const { user } = useAuth();
  const [lines, setLines] = useState<OeeLine[]>([]);
  const [state, setState] = useState<Record<string, number | null>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    fetchOeeLines()
      .then((ls) => setLines(ls.filter((l) => l.enabled && l.running_tag)))
      .catch(() => setLines([]));
  }, []);

  useEffect(() => {
    if (lines.length === 0) return;
    let cancelled = false;
    const poll = () => {
      Promise.all(
        lines.map((l) =>
          fetchHistory(l.running_tag!, 1)
            .then((rows) => [l.line, rows.at(-1)?.value ?? null] as const)
            .catch(() => [l.line, null] as const),
        ),
      ).then((entries) => {
        if (!cancelled) setState(Object.fromEntries(entries));
      });
    };
    poll();
    const iv = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [lines]);

  const toggle = async (l: OeeLine) => {
    const running = (state[l.line] ?? 0) >= 1;
    setBusy(l.line);
    try {
      await executeOperation(running ? "stop_line" : "start_line", l.line);
      toast.success(
        running ? `Ligne ${l.label ?? l.line} arrêtée.` : `Ligne ${l.label ?? l.line} démarrée.`,
      );
      setState((s) => ({ ...s, [l.line]: running ? 0 : 1 }));
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 403 ? "Non autorisé." : "Échec de l'envoi.",
      );
    } finally {
      setBusy(null);
    }
  };

  if (lines.length === 0) return null;

  return (
    <Section
      title="Pilotage"
      hint="Démarre/arrête une ligne (écrit sur son tag de marche). Nécessite le droit d'écriture sur la ligne."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {lines.map((l) => {
          const running = (state[l.line] ?? 0) >= 1;
          const writable = canWrite(user, l.line);
          return (
            <div
              key={l.line}
              className="flex items-center justify-between rounded-lg border border-border p-3"
            >
              <div>
                <div className="text-sm font-medium">{l.label ?? l.line}</div>
                <span className={`status ${running ? "live" : "off"}`}>
                  {running ? "En marche" : "Arrêtée"}
                </span>
              </div>
              {writable && (
                <Button
                  size="sm"
                  variant={running ? "outline" : "default"}
                  disabled={busy === l.line}
                  onClick={() => toggle(l)}
                >
                  {busy === l.line ? "…" : running ? "Arrêter" : "Démarrer"}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
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
  useEffect(() => {
    loadAll();
  }, []);

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
    <>
      <PageHeader
        title="Production"
        description="Sorties par shift, rôles des compteurs et planning."
      />

      <PilotageSection />

      {/* ─── Tableau de production ─────────────────────────────── */}
      <Section title="Production par shift">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Shift</TableHead>
              <TableHead>OK</TableHead>
              <TableHead>Rebut</TableHead>
              <TableHead>Produit</TableHead>
              <TableHead>Dispo</TableHead>
              <TableHead>Taux rebut</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {prod.map((r) => (
              <TableRow key={`${r.day}-${r.shift_no}`}>
                <TableCell className="tabular-nums">{r.day.slice(0, 10)}</TableCell>
                <TableCell>{r.shift_label ?? `#${r.shift_no}`}</TableCell>
                <TableCell className="tabular-nums">{r.ok ?? "—"}</TableCell>
                <TableCell className={`tabular-nums ${r.scrap ? "text-warn" : ""}`}>
                  {r.scrap ?? "—"}
                </TableCell>
                <TableCell className="tabular-nums">{r.produced ?? "—"}</TableCell>
                <TableCell className="tabular-nums">{r.available ?? "—"}</TableCell>
                <TableCell className="tabular-nums">{scrapRate(r)}</TableCell>
              </TableRow>
            ))}
            {prod.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  Aucune production calculée. Mappe des tags compteurs à des rôles
                  ci-dessous (OK / rebut…).
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Section>

      {/* ─── Mapping des rôles ─────────────────────────────────── */}
      <Section
        title="Rôles des compteurs"
        hint={
          <>
            Déclare quel compteur représente quoi. <code>ok</code> = pièces bonnes,{" "}
            <code>scrap</code> = rebut, <code>produced</code> = total,{" "}
            <code>available</code> = disponibles.
          </>
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tag</TableHead>
              <TableHead>Rôle de production</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tags.map((t) => (
              <TableRow key={t.name}>
                <TableCell>
                  <code className="text-[var(--chart-2)]">{t.name}</code>
                </TableCell>
                <TableCell>
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
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      {/* ─── Planning de shifts versionné ──────────────────────── */}
      <Section
        title="Planning de shifts"
        action={
          <Button size="sm" variant="outline" onClick={addShiftRow}>
            <Plus />
            Ajouter
          </Button>
        }
        hint={
          <>
            Le planning est <strong>versionné</strong> : pour passer de 2 à 3 shifts
            ou changer des horaires, ajoute des lignes avec une nouvelle date d'effet.
            L'historique d'avant garde son ancienne config.
          </>
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Valable à partir du</TableHead>
              <TableHead>N°</TableHead>
              <TableHead>Libellé</TableHead>
              <TableHead>Début</TableHead>
              <TableHead>Fin</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shifts.map((s, i) => (
              <TableRow key={`${s.valid_from}-${s.shift_no}-${i}`}>
                <TableCell>
                  <Input
                    type="date"
                    className="w-40"
                    value={s.valid_from.slice(0, 10)}
                    onChange={(e) => patchShift(i, { valid_from: e.target.value })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    type="number"
                    className="w-16"
                    value={s.shift_no}
                    onChange={(e) => patchShift(i, { shift_no: Number(e.target.value) })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    className="w-48"
                    value={s.label ?? ""}
                    onChange={(e) => patchShift(i, { label: e.target.value })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    type="time"
                    className="w-28"
                    value={s.start_time.slice(0, 5)}
                    onChange={(e) => patchShift(i, { start_time: e.target.value })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    type="time"
                    className="w-28"
                    value={s.end_time.slice(0, 5)}
                    onChange={(e) => patchShift(i, { end_time: e.target.value })}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      onClick={async () => {
                        await saveShift(s);
                        setTimeout(() => fetchProduction(7).then(setProd), 300);
                      }}
                    >
                      Enregistrer
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      title="Supprimer"
                      onClick={async () => {
                        await deleteShift(s.valid_from, s.shift_no);
                        loadAll();
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
    </>
  );
}

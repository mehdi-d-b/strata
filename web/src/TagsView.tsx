import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { deleteTag, fetchTags, saveTag, type Tag } from "./api";
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
    <>
      <PageHeader
        title="Tags"
        description="Libellé, unité, échelle et activation de chaque tag."
      />

      <Section
        title="Tags configurés"
        hint={
          <>
            L'échelle et l'offset sont appliqués à la lecture :{" "}
            <code>valeur affichée = valeur brute × échelle + offset</code>. La
            donnée brute reste intacte en base — corriger une échelle répare tout
            l'historique.
          </>
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tag</TableHead>
              <TableHead>Libellé</TableHead>
              <TableHead>Unité</TableHead>
              <TableHead>Échelle</TableHead>
              <TableHead>Offset</TableHead>
              <TableHead className="text-center">Activé</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tags.map((t) => (
              <TableRow key={t.name}>
                <TableCell>
                  <code className="text-[var(--chart-2)]">{t.name}</code>
                </TableCell>
                <TableCell>
                  <Input
                    className="w-44"
                    value={t.label ?? ""}
                    onChange={(e) => patch(t.name, { label: e.target.value })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    className="w-20"
                    value={t.unit ?? ""}
                    onChange={(e) => patch(t.name, { unit: e.target.value })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    type="number"
                    step="any"
                    className="w-24"
                    value={t.scale}
                    onChange={(e) => patch(t.name, { scale: Number(e.target.value) })}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    type="number"
                    step="any"
                    className="w-24"
                    value={t.offset}
                    onChange={(e) => patch(t.name, { offset: Number(e.target.value) })}
                  />
                </TableCell>
                <TableCell className="text-center">
                  <input
                    type="checkbox"
                    checked={t.enabled}
                    onChange={(e) => patch(t.name, { enabled: e.target.checked })}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      onClick={() => onSave(t)}
                      disabled={savingName === t.name}
                    >
                      {savingName === t.name ? "…" : "Enregistrer"}
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      title="Supprimer la config"
                      onClick={() => onDelete(t.name)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {tags.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  Aucun tag pour l'instant. Les tags apparaissent automatiquement
                  dès que des données arrivent.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Section>
    </>
  );
}

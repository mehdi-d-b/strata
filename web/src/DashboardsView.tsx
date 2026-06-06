import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LayoutGrid, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  createDashboard,
  deleteDashboard,
  fetchDashboards,
  type DashboardSpec,
  type DashboardSummary,
} from "./api";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";

const EMPTY_SPEC: DashboardSpec = {
  panels: [],
  range: { mode: "relative", sec: 900 },
  refreshSec: 10,
};

export function DashboardsView() {
  const [list, setList] = useState<DashboardSummary[]>([]);
  const navigate = useNavigate();

  const load = () => fetchDashboards().then(setList).catch(() => setList([]));
  useEffect(() => {
    load();
  }, []);

  const createNew = async () => {
    const name = prompt("Nom du nouveau dashboard :", "Sans titre");
    if (!name) return;
    try {
      const d = await createDashboard(name, EMPTY_SPEC);
      navigate(`/dashboards/${d.id}`);
    } catch {
      toast.error("Création impossible (endpoint dashboards pas encore dispo ?).");
    }
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`Supprimer le dashboard « ${name} » ?`)) return;
    try {
      await deleteDashboard(id);
      load();
    } catch {
      toast.error("Suppression impossible.");
    }
  };

  return (
    <>
      <PageHeader
        title="Dashboards"
        description="Vues multi-panneaux sauvegardées, rejouables à tout moment."
        actions={
          <Button size="sm" onClick={createNew}>
            <Plus />
            Nouveau
          </Button>
        }
      />

      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Aucun dashboard. Crée-en un avec « Nouveau » : tu pourras y empiler des
          panneaux de courbes et les retrouver à chaque visite.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((d) => (
            <div
              key={d.id}
              className="group relative rounded-xl border border-border bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-primary"
            >
              <Link to={`/dashboards/${d.id}`} className="block">
                <div className="mb-2 flex items-center gap-2">
                  <LayoutGrid className="size-4 text-muted-foreground transition-colors group-hover:text-primary" />
                  <span className="font-semibold text-foreground">{d.name}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Modifié le {new Date(d.updated_at).toLocaleString()}
                </div>
              </Link>
              <Button
                size="icon-sm"
                variant="ghost"
                className="absolute right-2 top-2 text-destructive opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                title="Supprimer"
                onClick={() => remove(d.id, d.name)}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

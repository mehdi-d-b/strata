import { useEffect, useState } from "react";
import { CheckCircle2, Timer, XCircle } from "lucide-react";
import { api } from "./api";
import { PageHeader } from "@/components/PageHeader";
import { cn } from "@/lib/utils";

type Batch = {
  id: string;
  recipe: string;
  line: string;
  started_at: string;
  ended_at: string | null;
  status: "running" | "done" | "failed";
  qc_verdict: string | null;
  defaut_type: string | null;
  rebut_pct: number | null;
  qc_notes: string | null;
};

function lineName(line: string) {
  const seg = line.split(".").pop() ?? line;
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

function recipeName(r: string) {
  return r.charAt(0).toUpperCase() + r.slice(1);
}

function fmtDuration(start: string, end: string | null) {
  const ms = (end ? new Date(end) : new Date()).getTime() - new Date(start).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
}

function VerdictBadge({ verdict, status }: { verdict: string | null; status: string }) {
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
        <span className="size-1.5 animate-pulse rounded-full bg-primary" />
        En cours
      </span>
    );
  }
  const ok = verdict === "ok";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        ok ? "bg-good/15 text-good" : "bg-bad/15 text-bad",
      )}
    >
      {ok ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
      {ok ? "OK" : (verdict ?? "Défaut")}
    </span>
  );
}

export function BatchesView() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () =>
    api<Batch[]>("/api/batches?limit=100")
      .then(setBatches)
      .catch(() => {})
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  const running = batches.filter((b) => b.status === "running");
  const done = batches.filter((b) => b.status !== "running");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Batches"
        description="Batches en cours et historique de production par ligne."
      />

      {running.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            En cours
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {running.map((b) => (
              <div key={b.id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{lineName(b.line)}</span>
                  <VerdictBadge verdict={b.qc_verdict} status={b.status} />
                </div>
                <div className="mt-0.5 text-sm text-muted-foreground">{recipeName(b.recipe)}</div>
                <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Timer className="size-3" />
                  {fmtDuration(b.started_at, null)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2">
        {running.length > 0 && (
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Historique
          </h2>
        )}
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {loading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Chargement…</div>
          ) : done.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Aucun batch terminé.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-medium">Ligne</th>
                  <th className="px-4 py-2.5 text-left font-medium">Recette</th>
                  <th className="px-4 py-2.5 text-left font-medium">Début</th>
                  <th className="px-4 py-2.5 text-left font-medium">Durée</th>
                  <th className="px-4 py-2.5 text-left font-medium">Verdict</th>
                  <th className="px-4 py-2.5 text-left font-medium">Rebut</th>
                </tr>
              </thead>
              <tbody>
                {done.map((b, i) => (
                  <tr
                    key={b.id}
                    className={cn(
                      "border-b border-border/50 last:border-0",
                      i % 2 === 1 && "bg-secondary/30",
                    )}
                  >
                    <td className="px-4 py-2.5 font-medium">{lineName(b.line)}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{recipeName(b.recipe)}</td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {new Date(b.started_at).toLocaleString("fr-FR", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {fmtDuration(b.started_at, b.ended_at)}
                    </td>
                    <td className="px-4 py-2.5">
                      <VerdictBadge verdict={b.qc_verdict} status={b.status} />
                    </td>
                    <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                      {b.rebut_pct != null ? `${b.rebut_pct.toFixed(1)} %` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

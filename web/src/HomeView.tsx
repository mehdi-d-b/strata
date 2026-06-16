import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bell,
  Cpu,
  Factory,
  FlaskConical,
  Gauge,
  LineChart,
  ShieldCheck,
  Tags as TagsIcon,
  TriangleAlert,
} from "lucide-react";
import {
  api,
  fetchDevices,
  fetchOee,
  fetchProduction,
  userIsAdmin,
  type OeeRow,
  type ProductionRow,
} from "./api";
import { useAuth } from "./auth";
import { useAlarms } from "./alarms";
import { PageHeader } from "@/components/PageHeader";
import { KpiCard } from "@/components/KpiCard";

type BatchSummary = { status: string };

export function HomeView() {
  const { user } = useAuth();
  const admin = userIsAdmin(user);
  const { counts, unacked } = useAlarms();

  const [prod, setProd] = useState<ProductionRow[]>([]);
  const [oee, setOee] = useState<OeeRow[]>([]);
  const [runningBatches, setRunningBatches] = useState(0);

  useEffect(() => {
    fetchProduction(1).then(setProd).catch(() => setProd([]));
    fetchOee(1).then(setOee).catch(() => setOee([]));
    api<BatchSummary[]>("/api/batches?limit=20")
      .then((bs) => setRunningBatches(bs.filter((b) => b.status === "running").length))
      .catch(() => setRunningBatches(0));
    if (admin) fetchDevices().catch(() => {});
  }, [admin]);

  const today = prod[0]?.day;
  const todayRows = prod.filter((r) => r.day === today);
  const ok = todayRows.reduce((s, r) => s + (r.ok ?? 0), 0);
  const scrap = todayRows.reduce((s, r) => s + (r.scrap ?? 0), 0);
  const scrapRate = ok + scrap ? ((scrap / (ok + scrap)) * 100).toFixed(1) : "—";

  const oeeValues = oee.map((r) => r.oee).filter((v): v is number => v != null);
  const oeeAvg = oeeValues.length
    ? `${(oeeValues.reduce((a, b) => a + b, 0) / oeeValues.length * 100).toFixed(0)} %`
    : "—";

  return (
    <>
      <PageHeader
        title={`Bonjour, ${user?.display_name ?? user?.username}`}
        description="Vue d'ensemble de la plateforme."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="OEE du jour"
          value={oeeAvg}
          hint="moyenne toutes lignes"
          tone={oeeValues.length && oeeValues.every((v) => v >= 0.8) ? "good" : "warn"}
          icon={Gauge}
        />
        <KpiCard
          label="Batches en cours"
          value={runningBatches}
          hint="lignes actives"
          icon={FlaskConical}
        />
        <KpiCard
          label="Alarmes actives"
          value={unacked}
          hint={counts.critical > 0 ? `dont ${counts.critical} critique${counts.critical > 1 ? "s" : ""}` : "aucune critique"}
          tone={counts.critical > 0 ? "bad" : unacked > 0 ? "warn" : "good"}
          icon={Bell}
        />
        <KpiCard
          label="Taux de rebut"
          value={`${scrapRate} %`}
          hint="aujourd'hui"
          tone={Number(scrapRate) > 5 ? "bad" : Number(scrapRate) > 2 ? "warn" : "good"}
          icon={TriangleAlert}
        />
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Shortcut to="/explorer" title="Explorer" desc="Temps réel & historique, multi-courbes" icon={LineChart} />
        <Shortcut to="/batches" title="Batches" desc="Suivi de production, verdicts QC" icon={FlaskConical} />
        <Shortcut to="/alarms" title="Alarmes" desc="Actives, historique, acquittement" icon={Bell} />
        <Shortcut to="/oee" title="OEE" desc="Disponibilité, performance, qualité" icon={Gauge} />
        <Shortcut to="/production" title="Production" desc="Par shift, qualité, rebut" icon={Factory} />
        <Shortcut to="/tags" title="Tags" desc="Configuration, unités, échelle" icon={TagsIcon} />
        {admin && (
          <Shortcut to="/devices" title="Automates" desc="Sources, adresses, déploiement" icon={Cpu} />
        )}
        {admin && (
          <Shortcut to="/admin" title="Administration" desc="Utilisateurs, rôles, audit" icon={ShieldCheck} />
        )}
      </div>
    </>
  );
}

function Shortcut({
  to,
  title,
  desc,
  icon: Icon,
}: {
  to: string;
  title: string;
  desc: string;
  icon: typeof LineChart;
}) {
  return (
    <Link
      to={to}
      className="group block rounded-xl border border-border bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-primary"
    >
      <div className="mb-2 flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground transition-colors group-hover:text-primary" />
        <span className="font-semibold text-foreground">{title}</span>
      </div>
      <div className="text-sm text-muted-foreground">{desc}</div>
    </Link>
  );
}

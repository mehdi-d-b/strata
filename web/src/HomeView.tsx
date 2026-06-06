import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  CheckCircle2,
  Cpu,
  Factory,
  LineChart,
  ShieldCheck,
  Tags as TagsIcon,
  TriangleAlert,
} from "lucide-react";
import {
  fetchDevices,
  fetchProduction,
  fetchTags,
  userIsAdmin,
  type Device,
  type ProductionRow,
  type Tag,
} from "./api";
import { useAuth } from "./auth";
import { PageHeader } from "@/components/PageHeader";
import { KpiCard } from "@/components/KpiCard";

/** Page d'accueil : tableau de bord (KPIs + raccourcis). */
export function HomeView() {
  const { user } = useAuth();
  const admin = userIsAdmin(user);

  const [tags, setTags] = useState<Tag[]>([]);
  const [prod, setProd] = useState<ProductionRow[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);

  useEffect(() => {
    fetchTags().then(setTags).catch(() => setTags([]));
    fetchProduction(1).then(setProd).catch(() => setProd([]));
    if (admin) fetchDevices().then(setDevices).catch(() => setDevices([]));
  }, [admin]);

  const enabled = tags.filter((t) => t.enabled).length;
  const today = prod[0]?.day;
  const todayRows = prod.filter((r) => r.day === today);
  const ok = todayRows.reduce((s, r) => s + (r.ok ?? 0), 0);
  const scrap = todayRows.reduce((s, r) => s + (r.scrap ?? 0), 0);
  const scrapRate = ok + scrap ? ((scrap / (ok + scrap)) * 100).toFixed(1) : "—";

  return (
    <>
      <PageHeader
        title={`Bonjour, ${user?.display_name ?? user?.username}`}
        description="Vue d'ensemble de la plateforme."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Tags actifs" value={enabled} hint={`${tags.length} au total`} icon={TagsIcon} />
        <KpiCard label="Bonnes (aujourd'hui)" value={ok} hint="toutes lignes" tone="good" icon={CheckCircle2} />
        <KpiCard label="Taux de rebut" value={`${scrapRate}%`} hint="aujourd'hui" tone="warn" icon={TriangleAlert} />
        {admin && <KpiCard label="Automates" value={devices.length} hint="sources" icon={Cpu} />}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Shortcut to="/explorer" title="Explorer" desc="Temps réel & historique, multi-courbes" icon={LineChart} />
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

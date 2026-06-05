import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
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

/** Page d'accueil : tableau de bord (KPIs + raccourcis), style maison cohérent. */
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
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h2 className="card-title">Bonjour, {user?.display_name ?? user?.username}</h2>
        <p className="hint">Vue d'ensemble de la plateforme.</p>
      </div>

      {/* KPIs */}
      <div className="kpi-grid">
        <Kpi label="Tags actifs" value={enabled} hint={`${tags.length} au total`} />
        <Kpi label="Bonnes (aujourd'hui)" value={ok} hint="toutes lignes" tone="green" />
        <Kpi label="Taux de rebut" value={`${scrapRate}%`} hint="aujourd'hui" tone="amber" />
        {admin && <Kpi label="Automates" value={devices.length} hint="sources" />}
      </div>

      {/* Raccourcis */}
      <div className="home-grid">
        <Shortcut to="/live" title="Temps réel" desc="Courbes multi-tags en direct" />
        <Shortcut to="/production" title="Production" desc="Par shift, qualité, rebut" />
        <Shortcut to="/tags" title="Tags" desc="Configuration, unités, échelle" />
        {admin && (
          <Shortcut to="/devices" title="Automates" desc="Sources, adresses, déploiement" />
        )}
        {admin && (
          <Shortcut to="/admin" title="Administration" desc="Utilisateurs, rôles, audit" />
        )}
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: "green" | "amber";
}) {
  return (
    <div className="card kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${tone ?? ""}`}>{value}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

function Shortcut({ to, title, desc }: { to: string; title: string; desc: string }) {
  return (
    <Link to={to} className="home-card">
      <div className="home-card-title">{title}</div>
      <div className="home-card-sub">{desc}</div>
    </Link>
  );
}

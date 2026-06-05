import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchTags, type Tag } from "./api";
import { useAuth } from "./auth";
import { userIsAdmin } from "./api";

/** Page d'accueil : vue d'ensemble + raccourcis (sera enrichie au polish). */
export function HomeView() {
  const { user } = useAuth();
  const [tags, setTags] = useState<Tag[]>([]);

  useEffect(() => {
    fetchTags().then(setTags).catch(() => setTags([]));
  }, []);

  const enabled = tags.filter((t) => t.enabled).length;
  const admin = userIsAdmin(user);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="card">
        <h2 className="card-title">Bienvenue, {user?.display_name ?? user?.username}</h2>
        <p className="hint">
          Strata — plateforme de streaming de données industrielles. Choisis une
          section ci-dessous ou dans le menu.
        </p>
      </div>

      <div className="home-grid">
        <Link to="/live" className="home-card">
          <div className="home-card-title">Temps réel</div>
          <div className="home-card-sub">Courbes en direct des {enabled} tags actifs</div>
        </Link>
        <Link to="/production" className="home-card">
          <div className="home-card-title">Production</div>
          <div className="home-card-sub">Tableau par shift, qualité, rebut</div>
        </Link>
        <Link to="/tags" className="home-card">
          <div className="home-card-title">Tags</div>
          <div className="home-card-sub">Configuration, unités, échelle</div>
        </Link>
        {admin && (
          <Link to="/devices" className="home-card">
            <div className="home-card-title">Automates</div>
            <div className="home-card-sub">Sources, adresses, déploiement</div>
          </Link>
        )}
        {admin && (
          <Link to="/admin" className="home-card">
            <div className="home-card-title">Administration</div>
            <div className="home-card-sub">Utilisateurs, rôles, audit</div>
          </Link>
        )}
      </div>
    </div>
  );
}

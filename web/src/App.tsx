import { useState } from "react";
import { LiveView } from "./LiveView";
import { TagsView } from "./TagsView";
import { ProductionView } from "./ProductionView";
import { AdminView } from "./AdminView";
import { DevicesView } from "./DevicesView";
import { LoginView } from "./LoginView";
import { useAuth } from "./auth";
import { userIsAdmin } from "./api";

type Tab = "live" | "production" | "tags" | "devices" | "admin";

export function App() {
  const { user, loading, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("live");

  if (loading) {
    return <div className="login-wrap">Chargement…</div>;
  }
  if (!user) {
    return <LoginView />;
  }

  const admin = userIsAdmin(user);

  return (
    <>
      <header>
        <div>
          <h1>STRATA</h1>
          <div className="sub">Industrial data streaming</div>
        </div>
        <nav>
          <button
            className={tab === "live" ? "active" : ""}
            onClick={() => setTab("live")}
          >
            Temps réel
          </button>
          <button
            className={tab === "production" ? "active" : ""}
            onClick={() => setTab("production")}
          >
            Production
          </button>
          <button
            className={tab === "tags" ? "active" : ""}
            onClick={() => setTab("tags")}
          >
            Tags
          </button>
          {admin && (
            <button
              className={tab === "devices" ? "active" : ""}
              onClick={() => setTab("devices")}
            >
              Automates
            </button>
          )}
          {admin && (
            <button
              className={tab === "admin" ? "active" : ""}
              onClick={() => setTab("admin")}
            >
              Admin
            </button>
          )}
        </nav>
        <div className="user-box">
          <span className="user-name">{user.display_name ?? user.username}</span>
          <button className="ghost" onClick={() => logout()}>
            Déconnexion
          </button>
        </div>
      </header>
      <main>
        {tab === "live" && <LiveView />}
        {tab === "production" && <ProductionView />}
        {tab === "tags" && <TagsView />}
        {tab === "devices" && admin && <DevicesView />}
        {tab === "admin" && admin && <AdminView />}
      </main>
    </>
  );
}

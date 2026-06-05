import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "./auth";
import { userIsAdmin } from "./api";
import { Button } from "@/components/ui/button";

/** Coquille de l'application : en-tête + navigation + zone de contenu (Outlet). */
export function Layout() {
  const { user, logout } = useAuth();
  const admin = userIsAdmin(user);

  const navClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? "active" : "";

  return (
    <>
      <header>
        <div>
          <h1>STRATA</h1>
          <div className="sub">Industrial data streaming</div>
        </div>
        <nav>
          <NavLink to="/" end className={navClass}>
            Accueil
          </NavLink>
          <NavLink to="/live" className={navClass}>
            Temps réel
          </NavLink>
          <NavLink to="/production" className={navClass}>
            Production
          </NavLink>
          <NavLink to="/tags" className={navClass}>
            Tags
          </NavLink>
          {admin && (
            <NavLink to="/devices" className={navClass}>
              Automates
            </NavLink>
          )}
          {admin && (
            <NavLink to="/admin" className={navClass}>
              Admin
            </NavLink>
          )}
          <NavLink to="/settings" className={navClass}>
            Paramètres
          </NavLink>
        </nav>
        <div className="user-box">
          <span className="user-name">{user?.display_name ?? user?.username}</span>
          <Button variant="outline" size="sm" onClick={() => logout()}>
            Déconnexion
          </Button>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
}

import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./Layout";
import { HomeView } from "./HomeView";
import { LiveView } from "./LiveView";
import { DashboardsView } from "./DashboardsView";
import { DashboardView } from "./DashboardView";
import { AlarmsView } from "./AlarmsView";
import { TagsView } from "./TagsView";
import { ProductionView } from "./ProductionView";
import { AdminView } from "./AdminView";
import { DevicesView } from "./DevicesView";
import { SettingsView } from "./SettingsView";
import { LoginView } from "./LoginView";
import { RequireAdmin } from "./RequireAdmin";
import { useAuth } from "./auth";

export function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        Chargement…
      </div>
    );
  }
  if (!user) {
    return <LoginView />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomeView />} />
          <Route path="explorer" element={<LiveView />} />
          <Route path="dashboards" element={<DashboardsView />} />
          <Route path="dashboards/:id" element={<DashboardView />} />
          <Route path="alarms" element={<AlarmsView />} />
          {/* Ancien chemin -> nouveau (compat liens existants) */}
          <Route path="live" element={<Navigate to="/explorer" replace />} />
          <Route path="production" element={<ProductionView />} />
          <Route path="tags" element={<TagsView />} />
          <Route path="settings" element={<SettingsView />} />
          <Route
            path="devices"
            element={
              <RequireAdmin>
                <DevicesView />
              </RequireAdmin>
            }
          />
          <Route
            path="admin"
            element={
              <RequireAdmin>
                <AdminView />
              </RequireAdmin>
            }
          />
          {/* Toute URL inconnue -> accueil */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

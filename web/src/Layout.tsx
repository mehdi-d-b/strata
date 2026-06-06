import { Outlet } from "react-router-dom";
import { Sidebar } from "@/components/Sidebar";
import { Toaster } from "@/components/ui/sonner";

/** Coquille de l'application : sidebar de navigation + zone de contenu (Outlet). */
export function Layout() {
  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <main>
          <Outlet />
        </main>
      </div>
      <Toaster />
    </div>
  );
}

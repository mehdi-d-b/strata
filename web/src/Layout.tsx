import { useState } from "react";
import { Outlet, Link } from "react-router-dom";
import { TriangleAlert } from "lucide-react";
import { Sidebar } from "@/components/Sidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { Toaster } from "@/components/ui/sonner";
import { AlarmsProvider, useAlarms } from "./alarms";

/** Bandeau réservé aux alarmes critiques non acquittées (sinon rien). */
function CriticalBanner() {
  const { counts } = useAlarms();
  if (counts.critical === 0) return null;
  return (
    <Link
      to="/alarms"
      className="flex items-center gap-2 bg-bad px-4 py-2 text-sm font-medium text-bad-foreground"
    >
      <TriangleAlert className="size-4" />
      {counts.critical} alarme{counts.critical > 1 ? "s" : ""} critique
      {counts.critical > 1 ? "s" : ""} non acquittée{counts.critical > 1 ? "s" : ""} — voir les alarmes
    </Link>
  );
}

/** Coquille de l'application : sidebar de navigation + zone de contenu (Outlet). */
export function Layout() {
  const [paletteOpen, setPaletteOpen] = useState(false);

  return (
    <AlarmsProvider>
      <div className="flex min-h-screen bg-background">
        <Sidebar onSearch={() => setPaletteOpen(true)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <CriticalBanner />
          <main>
            <Outlet />
          </main>
        </div>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <Toaster />
      </div>
    </AlarmsProvider>
  );
}

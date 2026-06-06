import { useState } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "@/components/Sidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { Toaster } from "@/components/ui/sonner";

/** Coquille de l'application : sidebar de navigation + zone de contenu (Outlet). */
export function Layout() {
  const [paletteOpen, setPaletteOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar onSearch={() => setPaletteOpen(true)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <main>
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <Toaster />
    </div>
  );
}

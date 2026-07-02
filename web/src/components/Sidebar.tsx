import { useCallback, useState, type ComponentType, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import {
  Bell,
  Bot,
  Cpu,
  Factory,
  FlaskConical,
  Gauge,
  LayoutDashboard,
  LayoutGrid,
  LineChart,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  ShieldCheck,
  Tags,
} from "lucide-react";
import { useAuth } from "@/auth";
import { userIsAdmin } from "@/api";
import { useAlarms } from "@/alarms";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/theme";

type NavItem = {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  admin?: boolean;
};

type NavGroup = { label: string; items: NavItem[] };

const NAV: NavGroup[] = [
  {
    label: "Supervision",
    items: [
      { to: "/", label: "Accueil", icon: LayoutDashboard, end: true },
      { to: "/assistant", label: "Assistant", icon: Bot },
      { to: "/explorer", label: "Explorer", icon: LineChart },
      { to: "/dashboards", label: "Dashboards", icon: LayoutGrid },
      { to: "/alarms", label: "Alarmes", icon: Bell },
      { to: "/production", label: "Production", icon: Factory },
      { to: "/batches", label: "Batches", icon: FlaskConical },
      { to: "/oee", label: "OEE", icon: Gauge },
    ],
  },
  {
    label: "Configuration",
    items: [
      { to: "/tags", label: "Tags", icon: Tags },
      { to: "/devices", label: "Automates", icon: Cpu, admin: true },
    ],
  },
  {
    label: "Système",
    items: [
      { to: "/admin", label: "Administration", icon: ShieldCheck, admin: true },
      { to: "/settings", label: "Paramètres", icon: Settings },
    ],
  },
];

const STORAGE_KEY = "strata-sidebar-collapsed";

/** Barre latérale de navigation : marque, sections groupées, pied utilisateur. */
export function Sidebar({ onSearch }: { onSearch: () => void }) {
  const { user, logout } = useAuth();
  const admin = userIsAdmin(user);
  const { counts, unacked } = useAlarms();

  // Badge de comptage sur l'entrée Alarmes (rouge si critique, sinon ambre).
  const alarmBadge: ReactNode =
    unacked > 0 ? (
      <span
        className={cn(
          "ml-auto rounded-full px-1.5 text-[10px] font-semibold text-white",
          counts.critical > 0 ? "bg-bad" : "bg-warn",
        )}
      >
        {unacked}
      </span>
    ) : null;

  const [collapsed, setCollapsed] = useState(
    () => typeof window !== "undefined" && localStorage.getItem(STORAGE_KEY) === "1",
  );
  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  return (
    <aside
      className={cn(
        "sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-card transition-[width] duration-200",
        collapsed ? "w-[68px]" : "w-60",
      )}
    >
      {/* Marque */}
      <div className="flex h-16 items-center gap-2.5 px-4">
        <div className="grid size-8 shrink-0 place-items-center rounded-md bg-primary font-bold text-primary-foreground">
          S
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-wide text-foreground">STRATA</div>
            <div className="truncate text-xs text-muted-foreground">
              Industrial data streaming
            </div>
          </div>
        )}
      </div>

      {/* Recherche / palette de commandes */}
      <div className="px-3 pb-1">
        <button
          onClick={onSearch}
          title="Rechercher (⌘K)"
          className={cn(
            "flex w-full items-center gap-2 rounded-md border border-border bg-background px-2 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground",
            collapsed && "justify-center",
          )}
        >
          <Search className="size-4 shrink-0" />
          {!collapsed && (
            <>
              <span>Rechercher…</span>
              <kbd className="ml-auto rounded border border-border px-1.5 text-[10px]">⌘K</kbd>
            </>
          )}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-2">
        {NAV.map((group) => {
          const items = group.items.filter((it) => !it.admin || admin);
          if (items.length === 0) return null;
          return (
            <div key={group.label} className="space-y-1">
              {!collapsed && (
                <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </div>
              )}
              {items.map((it) => (
                <SidebarLink
                  key={it.to}
                  item={it}
                  collapsed={collapsed}
                  badge={it.to === "/alarms" ? alarmBadge : undefined}
                />
              ))}
            </div>
          );
        })}
      </nav>

      {/* Pied : utilisateur + actions */}
      <div className="space-y-2 border-t border-border p-3">
        <div
          className={cn(
            "flex items-center gap-2",
            collapsed ? "justify-center" : "justify-between",
          )}
        >
          {!collapsed && (
            <span className="min-w-0 truncate text-sm text-foreground">
              {user?.display_name ?? user?.username}
            </span>
          )}
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => logout()}
              aria-label="Déconnexion"
              title="Déconnexion"
            >
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleCollapsed}
          className="w-full justify-start text-muted-foreground"
          aria-label={collapsed ? "Déplier le menu" : "Replier le menu"}
          title={collapsed ? "Déplier le menu" : "Replier le menu"}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" />
          ) : (
            <>
              <PanelLeftClose className="size-4" />
              <span>Replier</span>
            </>
          )}
        </Button>
      </div>
    </aside>
  );
}

function SidebarLink({
  item,
  collapsed,
  badge,
}: {
  item: NavItem;
  collapsed: boolean;
  badge?: ReactNode;
}) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors",
          collapsed && "justify-center",
          isActive
            ? "bg-accent font-medium text-accent-foreground"
            : "text-muted-foreground hover:bg-secondary hover:text-foreground",
        )
      }
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {!collapsed && badge}
    </NavLink>
  );
}

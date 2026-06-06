import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useNavigate } from "react-router-dom";
import {
  Cpu,
  Factory,
  LayoutDashboard,
  LineChart,
  Moon,
  Settings,
  ShieldCheck,
  Sun,
  Tags as TagsIcon,
  Rows3,
} from "lucide-react";
import { useAuth } from "@/auth";
import { userIsAdmin } from "@/api";
import { useTheme } from "@/theme";
import { useDensity } from "@/density";
import { cn } from "@/lib/utils";

type Item = {
  id: string;
  label: string;
  group: string;
  icon: ComponentType<{ className?: string }>;
  run: () => void;
  keywords?: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Palette de commandes (⌘K / Ctrl+K) : navigation + actions rapides. */
export function CommandPalette({ open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const admin = userIsAdmin(user);
  const { theme, toggle } = useTheme();
  const { density, setDensity } = useDensity();

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Raccourci global ⌘K / Ctrl+K.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      } else if (e.key === "Escape" && open) {
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  // À l'ouverture : reset + focus.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => {
      navigate(to);
      onOpenChange(false);
    };
    const nav: Item[] = [
      { id: "home", label: "Accueil", group: "Aller à", icon: LayoutDashboard, run: go("/") },
      { id: "explorer", label: "Explorer", group: "Aller à", icon: LineChart, run: go("/explorer") },
      { id: "prod", label: "Production", group: "Aller à", icon: Factory, run: go("/production") },
      { id: "tags", label: "Tags", group: "Aller à", icon: TagsIcon, run: go("/tags") },
    ];
    if (admin) {
      nav.push(
        { id: "devices", label: "Automates", group: "Aller à", icon: Cpu, run: go("/devices") },
        { id: "admin", label: "Administration", group: "Aller à", icon: ShieldCheck, run: go("/admin") },
      );
    }
    nav.push({ id: "settings", label: "Paramètres", group: "Aller à", icon: Settings, run: go("/settings") });

    const actions: Item[] = [
      {
        id: "theme",
        label: theme === "dark" ? "Thème clair" : "Thème sombre",
        group: "Actions",
        icon: theme === "dark" ? Sun : Moon,
        keywords: "thème dark light couleur",
        run: () => {
          toggle();
          onOpenChange(false);
        },
      },
      {
        id: "density",
        label: density === "compact" ? "Densité confortable" : "Densité compacte",
        group: "Actions",
        icon: Rows3,
        keywords: "densité compact espacement",
        run: () => {
          setDensity(density === "compact" ? "comfortable" : "compact");
          onOpenChange(false);
        },
      },
    ];
    return [...nav, ...actions];
  }, [admin, theme, density, navigate, onOpenChange, toggle, setDensity]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        (it.keywords ?? "").toLowerCase().includes(q),
    );
  }, [items, query]);

  // Clamp l'index actif quand la liste filtrée change.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(1, filtered.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + filtered.length) % Math.max(1, filtered.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[active]?.run();
    }
  };

  let lastGroup = "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={() => onOpenChange(false)}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Rechercher une page ou une action…"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="max-h-80 overflow-y-auto p-2">
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              Aucun résultat.
            </div>
          )}
          {filtered.map((it, i) => {
            const Icon = it.icon;
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {header && (
                  <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {header}
                  </div>
                )}
                <button
                  onMouseEnter={() => setActive(i)}
                  onClick={() => it.run()}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm",
                    i === active ? "bg-accent text-accent-foreground" : "text-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  {it.label}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

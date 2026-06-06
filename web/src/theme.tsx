import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Thème visuel de l'appli. Pilote la classe `.dark` sur <html>. */
export type Theme = "light" | "dark";

const STORAGE_KEY = "strata-theme";

type ThemeState = {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeState | null>(null);

/** Lit le thème persistant (ou retombe sur sombre, charte historique de Strata). */
function readInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const saved = window.localStorage.getItem(STORAGE_KEY);
  return saved === "light" || saved === "dark" ? saved : "dark";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

function persist(theme: Theme) {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* localStorage indisponible : tant pis, on garde juste le thème en mémoire. */
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);

  // Applique le thème initial au montage (réconcilie avec le script anti-flash).
  useEffect(() => {
    applyTheme(theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On applique la classe .dark SYNCHRONIQUEMENT dans le handler (pas dans un
  // effet) : ainsi, au toggle, le DOM est à jour avant tout effet enfant qui
  // lirait les tokens calculés (cas des graphes uPlot via getComputedStyle).
  const setTheme = useCallback((t: Theme) => {
    applyTheme(t);
    persist(t);
    setThemeState(t);
  }, []);
  const toggle = useCallback(() => {
    setThemeState((t) => {
      const next: Theme = t === "dark" ? "light" : "dark";
      applyTheme(next);
      persist(next);
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme doit être utilisé dans <ThemeProvider>");
  return ctx;
}

/** Bouton bascule clair/sombre, à poser dans la barre de navigation. */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";
  return (
    <Button
      variant="outline"
      size="icon"
      onClick={toggle}
      aria-label={isDark ? "Passer en thème clair" : "Passer en thème sombre"}
      title={isDark ? "Thème clair" : "Thème sombre"}
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

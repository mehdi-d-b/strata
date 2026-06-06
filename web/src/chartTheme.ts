/**
 * Pont entre les tokens CSS (clair/sombre) et uPlot, qui dessine sur un <canvas>
 * et exige donc des couleurs CONCRÈTES (pas de var()). On lit ici les valeurs
 * calculées des variables de thème au moment de l'appel. À rappeler quand le
 * thème change (les couleurs renvoyées suivent alors le thème actif).
 */

const CHART_KEYS = [
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-6",
  "--chart-7",
  "--chart-8",
] as const;

/** Lit une variable CSS sur <html> (chaîne vide hors navigateur). */
function readVar(name: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Palette de séries (8 teintes), résolue dans le thème courant. */
export function chartPalette(): string[] {
  return CHART_KEYS.map((k) => readVar(k));
}

/** Couleurs des axes et de la grille, dans le thème courant. */
export function chartAxisTheme(): { stroke: string; grid: string } {
  return {
    stroke: readVar("--muted-foreground"),
    grid: readVar("--border"),
  };
}

/** Préférences locales (ce navigateur uniquement). */
const PREF_KEY = "strata.prefs";

export type Density = "comfortable" | "compact";

export type Prefs = {
  /** Fenêtre temps réel par défaut de l'Explorer, en secondes. */
  defaultWindowSec: number;
  /** Densité d'affichage (espacements). */
  density: Density;
};

const DEFAULTS: Prefs = { defaultWindowSec: 300, density: "comfortable" };

export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Fusionne et persiste (préserve les autres préférences). */
export function savePrefs(p: Partial<Prefs>) {
  localStorage.setItem(PREF_KEY, JSON.stringify({ ...loadPrefs(), ...p }));
}

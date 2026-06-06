/** Préférences locales (ce navigateur uniquement). */
const PREF_KEY = "strata.prefs";

export type Prefs = {
  /** Fenêtre temps réel par défaut de l'Explorer, en secondes. */
  defaultWindowSec: number;
};

const DEFAULTS: Prefs = { defaultWindowSec: 300 };

export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREF_KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(p: Prefs) {
  localStorage.setItem(PREF_KEY, JSON.stringify(p));
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { loadPrefs, savePrefs, type Density } from "./prefs";

type DensityState = {
  density: Density;
  setDensity: (d: Density) => void;
};

const DensityContext = createContext<DensityState | null>(null);

function apply(density: Density) {
  if (density === "compact") document.documentElement.dataset.density = "compact";
  else delete document.documentElement.dataset.density;
}

export function DensityProvider({ children }: { children: ReactNode }) {
  const [density, setState] = useState<Density>(() => loadPrefs().density);

  useEffect(() => {
    apply(density);
  }, [density]);

  const setDensity = useCallback((d: Density) => {
    apply(d);
    savePrefs({ density: d });
    setState(d);
  }, []);

  return (
    <DensityContext.Provider value={{ density, setDensity }}>
      {children}
    </DensityContext.Provider>
  );
}

export function useDensity(): DensityState {
  const ctx = useContext(DensityContext);
  if (!ctx) throw new Error("useDensity doit être utilisé dans <DensityProvider>");
  return ctx;
}

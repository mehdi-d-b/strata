import { cn } from "@/lib/utils";

type TabItem<T extends string> = { id: T; label: string };

type TabBarProps<T extends string> = {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
};

/** Sous-navigation en onglets (segmenté), calée sur les tokens. */
export function TabBar<T extends string>({ tabs, value, onChange }: TabBarProps<T>) {
  return (
    <div className="flex flex-wrap gap-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "rounded-md border px-3 py-1.5 text-sm transition-colors",
            value === t.id
              ? "border-primary bg-card text-foreground"
              : "border-border bg-secondary text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

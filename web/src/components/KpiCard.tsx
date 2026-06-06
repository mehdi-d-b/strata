import type { ComponentType, ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Tone = "default" | "good" | "warn" | "bad";

const toneClass: Record<Tone, string> = {
  default: "text-foreground",
  good: "text-good",
  warn: "text-warn",
  bad: "text-bad",
};

type KpiCardProps = {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** Couleur de la valeur (sémantique métier). */
  tone?: Tone;
  /** Icône lucide optionnelle, en haut à droite. */
  icon?: ComponentType<{ className?: string }>;
};

/** Tuile d'indicateur clé : libellé, valeur (chiffres alignés), indice, ton. */
export function KpiCard({ label, value, hint, tone = "default", icon: Icon }: KpiCardProps) {
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start justify-between px-5 py-4">
        <div className="min-w-0 space-y-2">
          <div className="text-sm text-muted-foreground">{label}</div>
          <div
            className={cn(
              "text-3xl font-semibold leading-none tabular-nums",
              toneClass[tone],
            )}
          >
            {value}
          </div>
          {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
        </div>
        {Icon && <Icon className="size-5 shrink-0 text-muted-foreground" />}
      </div>
    </Card>
  );
}

import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";

type SectionProps = {
  title: string;
  /** Action alignée à droite du titre (bouton…). */
  action?: ReactNode;
  children: ReactNode;
  /** Indice/aide affiché sous le contenu. */
  hint?: ReactNode;
};

/** Bloc encarté homogène : titre + action + contenu + indice. */
export function Section({ title, action, children, hint }: SectionProps) {
  return (
    <Card className="gap-4 py-5">
      <div className="flex items-center justify-between px-6">
        <h2 className="text-base font-semibold">{title}</h2>
        {action}
      </div>
      <CardContent className="px-6">{children}</CardContent>
      {hint && <p className="px-6 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

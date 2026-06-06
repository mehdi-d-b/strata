import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type PageHeaderProps = {
  /** Titre de la page. */
  title: ReactNode;
  /** Sous-titre / description courte (optionnel). */
  description?: ReactNode;
  /** Actions alignées à droite (boutons, sélecteurs…). */
  actions?: ReactNode;
  className?: string;
};

/**
 * En-tête de page cohérent, partagé par toutes les vues : titre + description
 * à gauche, actions à droite. Pose un rythme vertical homogène d'une page à l'autre.
 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

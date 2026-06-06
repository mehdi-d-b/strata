import { useState } from "react";
import { toast } from "sonner";
import { ApiError, canWrite, sendCommand } from "./api";
import { useAuth } from "./auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Widget d'écriture de consigne pour un tag. Ne s'affiche que si l'utilisateur
 * a le droit `write` sur ce tag (le backend revérifie de toute façon).
 */
export function CommandBox({ tag, unit }: { tag: string; unit?: string }) {
  const { user } = useAuth();
  const [value, setValue] = useState("");

  if (!canWrite(user, tag)) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = Number(value);
    if (Number.isNaN(v)) {
      toast.error("Valeur invalide.");
      return;
    }
    try {
      await sendCommand(tag, v);
      toast.success(`Consigne ${v}${unit ? " " + unit : ""} envoyée.`);
      setValue("");
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 403
          ? "Non autorisé."
          : "Échec de l'envoi.",
      );
    }
  };

  return (
    <form className="flex items-center gap-2" onSubmit={submit}>
      <span className="text-sm text-muted-foreground">Consigne :</span>
      <Input
        type="number"
        step="any"
        placeholder="valeur"
        className="w-32"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      <Button type="submit" size="sm" disabled={value === ""}>
        Écrire
      </Button>
    </form>
  );
}

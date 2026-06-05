import { useState } from "react";
import { ApiError, canWrite, sendCommand } from "./api";
import { useAuth } from "./auth";

/**
 * Widget d'écriture de consigne pour un tag. Ne s'affiche que si l'utilisateur
 * a le droit `write` sur ce tag (le backend revérifie de toute façon).
 */
export function CommandBox({ tag, unit }: { tag: string; unit?: string }) {
  const { user } = useAuth();
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (!canWrite(user, tag)) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const v = Number(value);
    if (Number.isNaN(v)) {
      setMsg({ ok: false, text: "valeur invalide" });
      return;
    }
    try {
      await sendCommand(tag, v);
      setMsg({ ok: true, text: `consigne ${v}${unit ? " " + unit : ""} envoyée` });
      setValue("");
    } catch (err) {
      setMsg({
        ok: false,
        text:
          err instanceof ApiError && err.status === 403
            ? "non autorisé"
            : "échec de l'envoi",
      });
    }
  };

  return (
    <form className="cmdbox" onSubmit={submit}>
      <span className="cmdbox-label">Consigne :</span>
      <input
        type="number"
        step="any"
        placeholder="valeur"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {unit && <span className="cmdbox-unit">{unit}</span>}
      <button type="submit" disabled={value === ""}>
        Écrire
      </button>
      {msg && (
        <span className={`cmdbox-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</span>
      )}
    </form>
  );
}

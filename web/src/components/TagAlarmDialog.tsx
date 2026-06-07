import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  ALARM_OPERATORS,
  deleteAlarmRule,
  fetchAlarmRules,
  saveAlarmRule,
  type AlarmOperator,
  type AlarmRule,
  type Severity,
} from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Une règle booléenne « tout-ou-rien » = operator == et threshold 1. */
const isDigital = (r: AlarmRule) => r.operator === "==" && r.threshold === 1;

/**
 * Panneau « Alarmes » contextuel d'un tag (réflexe Ignition) : toggle booléen
 * (crée/supprime une règle == 1 en coulisse) + seuils analogiques. S'appuie sur
 * la seule table alarm_rules — aucun flag séparé.
 */
export function TagAlarmDialog({ tag, onClose }: { tag: string; onClose: () => void }) {
  const [rules, setRules] = useState<AlarmRule[]>([]);
  const [pendingSev, setPendingSev] = useState<Severity>("critical");
  const [nt, setNt] = useState({
    operator: ">" as AlarmOperator,
    threshold: 0,
    severity: "warning" as Severity,
    message: "",
  });

  const load = () =>
    fetchAlarmRules()
      .then((rs) => setRules(rs.filter((r) => r.tag === tag)))
      .catch(() => toast.error("Règles indisponibles."));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag]);

  const digital = rules.find(isDigital);
  const thresholds = rules.filter((r) => !isDigital(r));

  const toggleDigital = async () => {
    try {
      if (digital) await deleteAlarmRule(digital.id);
      else
        await saveAlarmRule({
          tag,
          operator: "==",
          threshold: 1,
          severity: pendingSev,
          message: null,
          enabled: true,
        });
      load();
    } catch {
      toast.error("Action impossible.");
    }
  };

  const setDigitalSev = async (severity: Severity) => {
    if (!digital) {
      setPendingSev(severity);
      return;
    }
    await saveAlarmRule({ ...digital, severity });
    load();
  };

  const addThreshold = async () => {
    try {
      await saveAlarmRule({
        tag,
        operator: nt.operator,
        threshold: nt.threshold,
        severity: nt.severity,
        message: nt.message || null,
        enabled: true,
      });
      setNt({ operator: ">", threshold: 0, severity: "warning", message: "" });
      load();
    } catch {
      toast.error("Ajout impossible.");
    }
  };

  const remove = async (id: string) => {
    await deleteAlarmRule(id);
    load();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[8vh]"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-5 py-4">
          <div className="text-sm text-muted-foreground">Alarmes du tag</div>
          <div className="font-mono text-sm text-[var(--chart-2)]">{tag}</div>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {/* Alarme tout-ou-rien */}
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Alarme tout-ou-rien
            </div>
            <div className="flex items-center gap-3 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={!!digital} onChange={toggleDigital} />
                Ce tag est une alarme (valeur = 1)
              </label>
              <select
                value={digital?.severity ?? pendingSev}
                onChange={(e) => setDigitalSev(e.target.value as Severity)}
              >
                <option value="critical">Critique</option>
                <option value="warning">Warning</option>
                <option value="info">Info</option>
              </select>
            </div>
          </div>

          {/* Seuils */}
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Seuils
            </div>
            {thresholds.length === 0 ? (
              <div className="mb-2 text-sm text-muted-foreground">Aucun seuil.</div>
            ) : (
              <div className="mb-2 space-y-1">
                {thresholds.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm"
                  >
                    <span className="font-mono">
                      {r.operator} {r.threshold}
                    </span>
                    <span className="text-muted-foreground">· {r.severity}</span>
                    {r.message && <span className="truncate text-muted-foreground">· {r.message}</span>}
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="ml-auto text-destructive hover:text-destructive"
                      title="Supprimer"
                      onClick={() => remove(r.id)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={nt.operator}
                onChange={(e) => setNt({ ...nt, operator: e.target.value as AlarmOperator })}
              >
                {ALARM_OPERATORS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
              <Input
                type="number"
                step="any"
                className="w-24"
                placeholder="seuil"
                value={nt.threshold}
                onChange={(e) => setNt({ ...nt, threshold: Number(e.target.value) })}
              />
              <select
                value={nt.severity}
                onChange={(e) => setNt({ ...nt, severity: e.target.value as Severity })}
              >
                <option value="critical">Critique</option>
                <option value="warning">Warning</option>
                <option value="info">Info</option>
              </select>
              <Input
                className="w-44"
                placeholder="message (optionnel)"
                value={nt.message}
                onChange={(e) => setNt({ ...nt, message: e.target.value })}
              />
              <Button size="sm" variant="outline" onClick={addThreshold}>
                <Plus />
                Seuil
              </Button>
            </div>
          </div>
        </div>

        <div className="flex justify-end border-t border-border p-4">
          <Button size="sm" onClick={onClose}>
            Fermer
          </Button>
        </div>
      </div>
    </div>
  );
}

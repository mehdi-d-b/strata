import { ALARM_OPERATORS, type AlarmOperator, type Severity } from "./api";

export type NewRule = {
  tag: string;
  operator: AlarmOperator;
  threshold: number;
  severity: Severity;
  message: string | null;
  enabled: boolean;
};

/** Découpe une ligne CSV en gérant les guillemets (et "" échappés). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += c;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else if (c === '"') {
      q = true;
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map(parseCsvLine);
}

/**
 * Mappe des lignes brutes vers des règles. Colonnes :
 * `tag, opérateur, seuil, sévérité, message`.
 * Opérateur/seuil absents => alarme booléenne `== 1`. Sévérité par défaut `warning`.
 * Une 1ʳᵉ ligne d'en-tête (`tag,...`) est ignorée.
 */
export function rowsToRules(rows: string[][]): NewRule[] {
  const out: NewRule[] = [];
  for (const cols of rows) {
    const tag = (cols[0] ?? "").trim();
    if (!tag || tag.toLowerCase() === "tag") continue;
    let operator = (cols[1] ?? "").trim() as AlarmOperator;
    let threshold =
      cols[2] !== undefined && String(cols[2]).trim() !== "" ? Number(cols[2]) : NaN;
    if (!ALARM_OPERATORS.includes(operator)) {
      operator = "==";
      if (Number.isNaN(threshold)) threshold = 1;
    }
    if (Number.isNaN(threshold)) threshold = 1;
    const sev = (cols[3] ?? "").trim().toLowerCase();
    const severity = (["critical", "warning", "info"].includes(sev) ? sev : "warning") as Severity;
    const message = (cols[4] ?? "").toString().trim() || null;
    out.push({ tag, operator, threshold, severity, message, enabled: true });
  }
  return out;
}

/** Lit un fichier CSV ou Excel (.xlsx) en lignes de chaînes (SheetJS à la demande). */
export async function readSpreadsheet(file: File): Promise<string[][]> {
  if (/\.csv$/i.test(file.name) || file.type.startsWith("text/")) {
    return parseCsv(await file.text());
  }
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false });
  return rows.map((r) => r.map((c) => (c == null ? "" : String(c))));
}

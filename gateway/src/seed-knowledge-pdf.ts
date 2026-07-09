/**
 * Ingestion PDF -> base de connaissances (RAG). Usage : npx tsx src/seed-knowledge-pdf.ts
 *
 * Lit tous les PDF de knowledge-pdfs/, extrait le texte (pdfjs-dist — pas pdf-parse,
 * dont la version interne de pdf.js échoue sur certains PDF valides, cf. docs/
 * llm-integration.md), découpe en chunks (RecursiveCharacterTextSplitter,
 * @langchain/textsplitters — seul morceau de LangChain.js utilisé ici : @langchain/
 * community, qui porte PDFLoader, est déprécié), embedde chaque chunk via
 * nomic-embed-text et upsert dans `knowledge` (même table que seed-knowledge.ts,
 * catégorie 'manuel'). Idempotent (ON CONFLICT sur category+title, qui encode le
 * numéro de chunk).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
// pdfjs-dist ne type pas bien son export "legacy" ; import dynamique simple.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs") as any;

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";
const PG_DSN =
  process.env.PG_DSN ?? "postgres://strata:change-me-en-prod@localhost:5432/strata";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDF_DIR = path.join(__dirname, "..", "knowledge-pdfs");

async function extractText(filePath: string): Promise<string> {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await getDocument({ data }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    text += content.items.map((it: any) => it.str).join(" ") + "\n";
  }
  return text;
}

async function embedText(text: string): Promise<number[]> {
  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!resp.ok) throw new Error(`embed error ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as { embeddings: number[][] };
  return data.embeddings[0];
}

async function main() {
  const pool = new pg.Pool({ connectionString: PG_DSN });
  await pool
    .query(
      `ALTER TABLE knowledge ADD CONSTRAINT IF NOT EXISTS knowledge_category_title_key UNIQUE (category, title)`,
    )
    .catch(() => {});

  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 150 });

  const files = fs.existsSync(PDF_DIR)
    ? fs.readdirSync(PDF_DIR).filter((f) => f.toLowerCase().endsWith(".pdf"))
    : [];
  if (files.length === 0) {
    console.log(`Aucun PDF trouvé dans ${PDF_DIR}.`);
    await pool.end();
    return;
  }

  let inserted = 0;
  for (const file of files) {
    const base = path.basename(file, ".pdf");
    const text = await extractText(path.join(PDF_DIR, file));
    const chunks = await splitter.splitText(text);
    console.log(`${file}: ${chunks.length} chunk(s)`);
    for (let i = 0; i < chunks.length; i++) {
      const title = `${base} — chunk ${i + 1}/${chunks.length}`;
      process.stdout.write(`  Embedding "${title}"... `);
      const vec = await embedText(chunks[i]);
      await pool.query(
        `INSERT INTO knowledge (category, title, body, embedding)
         VALUES ('manuel', $1, $2, $3::vector)
         ON CONFLICT (category, title) DO UPDATE
           SET body = EXCLUDED.body, embedding = EXCLUDED.embedding, updated_at = now()`,
        [title, chunks[i], `[${vec.join(",")}]`],
      );
      console.log("OK");
      inserted++;
    }
  }

  console.log(`\nTerminé : ${inserted} chunk(s) inséré(s)/mis à jour depuis ${files.length} PDF.`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

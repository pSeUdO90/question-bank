import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const memoryDir = path.resolve(appDir, "..");
const workspaceDir = path.resolve(memoryDir, "..");
const publicDir = path.join(appDir, "public");
const db = new DatabaseSync(path.join(memoryDir, "question_bank.sqlite3"), { readOnly: true });
const batch = db.prepare("SELECT * FROM batches ORDER BY created_at DESC LIMIT 1").get();
batch.qa_summary = JSON.parse(batch.qa_summary_json || "{}");
delete batch.qa_summary_json;
const questions = db.prepare("SELECT * FROM questions WHERE batch_id=? ORDER BY source_page, CAST(SUBSTR(source_block,2) AS INTEGER)").all(batch.batch_id).map((row) => {
  const question = { ...row };
  for (const column of ["options_json", "media_json", "answer_json", "qa_json"]) {
    const key = column.replace("_json", ""); question[key] = question[column] ? JSON.parse(question[column]) : null; delete question[column];
  }
  question.review_status = question.qa?.review?.status || "pending";
  return question;
});
const revisions = {};
for (const question of questions) {
  revisions[question.question_id] = db.prepare("SELECT * FROM revisions WHERE question_id=? ORDER BY revision_number DESC").all(question.question_id).map((row) => ({
    ...row,
    changed_fields: JSON.parse(row.changed_fields_json),
    prior_values: row.prior_values_json ? JSON.parse(row.prior_values_json) : null,
    new_values: row.new_values_json ? JSON.parse(row.new_values_json) : null,
  }));
}
const taxonomy = db.prepare("SELECT * FROM taxonomy WHERE active=1 ORDER BY exam,subject,chapter,topic").all().map((row) => ({ ...row, aliases: JSON.parse(row.aliases_json || "[]") }));
const sources = {};
for (const filename of [batch.source_question_pdf, batch.source_answer_file].filter(Boolean)) {
  const bytes = await fs.readFile(path.join(workspaceDir, "user_files", filename));
  sources[filename] = `data:application/pdf;base64,${bytes.toString("base64")}`;
}

const seed = { batch, questions, revisions, taxonomy, sources };
const [html, css, icons, adapter, app] = await Promise.all([
  fs.readFile(path.join(publicDir, "index.html"), "utf8"),
  fs.readFile(path.join(publicDir, "styles.css"), "utf8"),
  fs.readFile(path.join(publicDir, "vendor", "lucide.min.js"), "utf8"),
  fs.readFile(path.join(publicDir, "offline-adapter.js"), "utf8"),
  fs.readFile(path.join(publicDir, "app.js"), "utf8"),
]);
const safeScript = (text) => text.replaceAll("</script", "<\\/script").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
const seedScript = `window.__OFFLINE_SEED__=${safeScript(JSON.stringify(seed))};`;
let output = html
  .replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`)
  .replace('<script src="/vendor/lucide.min.js"></script>', `<script>${safeScript(icons)}</script>`)
  .replace('<script type="module" src="/app.js"></script>', `<script>${seedScript}</script><script>${safeScript(adapter)}</script><script>${safeScript(app)}</script>`);
const outputDir = path.join(workspaceDir, "output");
await fs.mkdir(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "question-bank-review-offline.html");
await fs.writeFile(outputPath, output);
console.log(JSON.stringify({ outputPath, bytes: Buffer.byteLength(output), batch_id: batch.batch_id, questions: questions.length, embedded_sources: Object.keys(sources).length }));


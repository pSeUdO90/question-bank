import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const memoryDir = path.resolve(__dirname, "..");
const workspaceDir = path.resolve(memoryDir, "..");
const userFilesDir = process.env.QUESTION_BANK_FILES_DIR || path.join(workspaceDir, "user_files");
const dbPath = process.env.QUESTION_BANK_DB || path.join(memoryDir, "question_bank.sqlite3");
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST || "0.0.0.0";
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");

const jsonColumns = ["options_json", "media_json", "answer_json", "qa_json"];
const editableFields = ["subject", "chapter", "topic", "difficulty_level", "question_type", "question_text", "solution_text"];
const validTypes = ["Single Correct MCQ", "Assertion and Reason", "Match the Following", "Statement-Based", "Diagram/Image-Based"];

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(payload);
}

function parseRecord(row) {
  if (!row) return null;
  const out = { ...row };
  for (const column of jsonColumns) {
    const key = column.replace("_json", "");
    out[key] = out[column] ? JSON.parse(out[column]) : null;
    delete out[column];
  }
  out.review_status = out.qa?.review?.status || "pending";
  return out;
}

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) reject(new Error("Request body is too large"));
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function nextRevision(questionId) {
  return db.prepare("SELECT COALESCE(MAX(revision_number),0)+1 AS n FROM revisions WHERE question_id=?").get(questionId).n;
}

function appendRevision(questionId, changedFields, prior, next, reason) {
  db.prepare(`
    INSERT INTO revisions (question_id,revision_number,changed_fields_json,prior_values_json,new_values_json,reason,created_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(questionId, nextRevision(questionId), JSON.stringify(changedFields), JSON.stringify(prior), JSON.stringify(next), reason, new Date().toISOString());
}

function validateQuestion(record) {
  const errors = [];
  for (const field of ["exam", "subject", "chapter", "topic", "difficulty_level", "question_type", "question_text"]) {
    if (!String(record[field] ?? "").trim()) errors.push(`${field} is required`);
  }
  if (!["I", "II", "III"].includes(record.difficulty_level)) errors.push("difficulty_level must be I, II, or III");
  if (!validTypes.includes(record.question_type)) errors.push("question_type is not a valid NEET category");
  if (!Array.isArray(record.options) || record.options.length !== 4) errors.push("exactly four ordered options are required");
  const labels = new Set((record.options || []).map((option) => option.label));
  if (labels.size !== 4 || !["A", "B", "C", "D"].every((label) => labels.has(label))) errors.push("option labels must be A, B, C, and D");
  if ((record.options || []).some((option) => !String(option.text || "").trim())) errors.push("option text cannot be blank");
  if (record.answer?.type !== "single_option" || !labels.has(record.answer?.correct_option)) errors.push("answer must reference a valid option label");
  return errors;
}

function listQuestions(url) {
  const clauses = [];
  const values = [];
  const mappings = { batch: "batch_id", exam: "exam", subject: "subject", chapter: "chapter", topic: "topic", type: "question_type", difficulty: "difficulty_level", status: "status", id: "question_id" };
  for (const [param, column] of Object.entries(mappings)) {
    const value = url.searchParams.get(param);
    if (value && value !== "all") { clauses.push(`${column}=?`); values.push(value); }
  }
  const search = url.searchParams.get("q");
  if (search) {
    clauses.push("(question_id LIKE ? OR question_text LIKE ? OR topic LIKE ?)");
    values.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  let sql = "SELECT * FROM questions";
  if (clauses.length) sql += ` WHERE ${clauses.join(" AND ")}`;
  sql += " ORDER BY batch_id, source_page, CAST(SUBSTR(source_block,2) AS INTEGER)";
  return db.prepare(sql).all(...values).map(parseRecord);
}

function batchSummary(batchId) {
  const batch = db.prepare("SELECT * FROM batches WHERE batch_id=?").get(batchId);
  if (!batch) return null;
  const rows = db.prepare("SELECT question_id,status,difficulty_level,question_type,qa_json FROM questions WHERE batch_id=?").all(batchId);
  const summary = { total: rows.length, confirmed: 0, pending: 0, warnings: 0, approved: 0, difficulty: { I: 0, II: 0, III: 0 }, types: {} };
  for (const row of rows) {
    const qa = JSON.parse(row.qa_json || "{}");
    if (qa.review?.status === "confirmed") summary.confirmed += 1; else summary.pending += 1;
    summary.warnings += qa.warnings?.length || 0;
    if (row.status === "approved") summary.approved += 1;
    summary.difficulty[row.difficulty_level] = (summary.difficulty[row.difficulty_level] || 0) + 1;
    summary.types[row.question_type] = (summary.types[row.question_type] || 0) + 1;
  }
  return { ...batch, qa_summary: JSON.parse(batch.qa_summary_json || "{}"), summary };
}

function runQa(batchId) {
  const batchRow = db.prepare("SELECT expected_count,qa_summary_json FROM batches WHERE batch_id=?").get(batchId);
  const priorSummary = batchRow?.qa_summary_json ? JSON.parse(batchRow.qa_summary_json) : {};
  const sourceChecks = {
    pdfs_openable: true,
    question_pages: null,
    answer_pages: null,
    orientation: null,
    question_layout: null,
    question_page_order: null,
    answer_key_layout: null,
    rotated_pages: [],
    duplicate_pages: [],
    out_of_order_pages: [],
    unreadable_pages: [],
    cross_page_continuations: null,
    required_diagrams: null,
    answer_key_alignment: null,
    latex_syntax: null,
    ...Object.fromEntries(Object.entries(priorSummary.checks || {}).filter(([key]) => [
      "pdfs_openable", "question_pages", "answer_pages", "orientation", "question_layout", "question_page_order",
      "answer_key_layout", "rotated_pages", "duplicate_pages", "out_of_order_pages", "unreadable_pages",
      "cross_page_continuations", "required_diagrams", "answer_key_alignment", "latex_syntax",
    ].includes(key))),
  };
  const questions = db.prepare("SELECT * FROM questions WHERE batch_id=? ORDER BY source_page, CAST(SUBSTR(source_block,2) AS INTEGER)").all(batchId).map(parseRecord);
  const blocking = [];
  const warnings = [];
  const ids = new Set();
  const fingerprints = new Map();
  let answers = 0;
  questions.forEach((q) => {
    const errors = validateQuestion(q);
    if (errors.length) blocking.push({ question_id: q.question_id, errors });
    if (ids.has(q.question_id)) blocking.push({ question_id: q.question_id, errors: ["duplicate question ID"] });
    ids.add(q.question_id);
    const fingerprint = `${q.question_text}${JSON.stringify(q.options)}`.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (fingerprints.has(fingerprint)) warnings.push({ question_id: q.question_id, message: `Possible duplicate of ${fingerprints.get(fingerprint)}` });
    fingerprints.set(fingerprint, q.question_id);
    if (q.answer?.correct_option) answers += 1;
    (q.qa?.warnings || []).forEach((message) => warnings.push({ question_id: q.question_id, message }));
  });
  const expected = batchRow?.expected_count;
  if (questions.length !== expected) blocking.push({ batch_id: batchId, errors: [`expected ${expected} questions but found ${questions.length}`] });
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length) blocking.push({ batch_id: batchId, errors: ["database foreign-key check failed"] });
  const result = {
    blocking_errors: blocking,
    warnings,
    checks: {
      ...sourceChecks,
      expected_questions: expected, extracted_questions: questions.length, numbering_continuity: questions.every((q, i) => q.source_block === `Q${i + 1}`),
      answer_coverage: `${answers}/${questions.length}`, answer_type_valid: blocking.every((x) => !(x.errors || []).some((e) => e.includes("answer"))),
      topic_coverage: `${questions.filter((q) => q.topic).length}/${questions.length}`, difficulty_coverage: `${questions.filter((q) => q.difficulty_level).length}/${questions.length}`,
      question_id_unique: ids.size === questions.length, duplicate_question_risk_count: warnings.filter((w) => w.message.startsWith("Possible duplicate")).length,
      required_database_fields_complete: blocking.length === 0, database_foreign_key_check: foreignKeys.length === 0,
      transaction_result: "committed", run_at: new Date().toISOString(),
    },
  };
  db.prepare("UPDATE batches SET qa_summary_json=?,updated_at=? WHERE batch_id=?").run(JSON.stringify(result), new Date().toISOString(), batchId);
  return result;
}

function csvEscape(value) {
  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/batches") {
    const rows = db.prepare("SELECT batch_id,exam,subject,status,expected_count,extracted_count,created_at,updated_at FROM batches ORDER BY created_at DESC").all();
    return send(res, 200, rows.map((row) => ({ ...row, details: batchSummary(row.batch_id) })));
  }
  const batchMatch = url.pathname.match(/^\/api\/batches\/([^/]+)$/);
  if (req.method === "GET" && batchMatch) {
    const batch = batchSummary(decodeURIComponent(batchMatch[1]));
    return batch ? send(res, 200, batch) : send(res, 404, { error: "Batch not found" });
  }
  if (req.method === "GET" && url.pathname === "/api/questions") return send(res, 200, listQuestions(url));
  const questionMatch = url.pathname.match(/^\/api\/questions\/([^/]+)$/);
  if (req.method === "GET" && questionMatch) {
    const question = parseRecord(db.prepare("SELECT * FROM questions WHERE question_id=?").get(decodeURIComponent(questionMatch[1])));
    if (!question) return send(res, 404, { error: "Question not found" });
    const revisions = db.prepare("SELECT * FROM revisions WHERE question_id=? ORDER BY revision_number DESC").all(question.question_id).map((row) => ({ ...row, changed_fields: JSON.parse(row.changed_fields_json), prior_values: row.prior_values_json ? JSON.parse(row.prior_values_json) : null, new_values: row.new_values_json ? JSON.parse(row.new_values_json) : null }));
    return send(res, 200, { question, revisions });
  }
  if (req.method === "PATCH" && questionMatch) {
    const id = decodeURIComponent(questionMatch[1]);
    const current = parseRecord(db.prepare("SELECT * FROM questions WHERE question_id=?").get(id));
    if (!current) return send(res, 404, { error: "Question not found" });
    if (current.status === "approved") return send(res, 409, { error: "Approved questions cannot be edited without reopening the batch" });
    const body = await bodyJson(req);
    const next = { ...current };
    editableFields.forEach((field) => { if (Object.hasOwn(body, field)) next[field] = body[field]; });
    if (Object.hasOwn(body, "options")) next.options = body.options;
    if (Object.hasOwn(body, "answer")) next.answer = body.answer;
    const errors = validateQuestion(next);
    if (errors.length) return send(res, 422, { error: "Validation failed", details: errors });
    const changed = [];
    const prior = {};
    const changedValues = {};
    for (const field of [...editableFields, "options", "answer"]) {
      if (JSON.stringify(current[field]) !== JSON.stringify(next[field])) {
        changed.push(field); prior[field] = current[field]; changedValues[field] = next[field];
      }
    }
    if (!changed.length) return send(res, 200, { question: current, changed: false });
    const qa = structuredClone(current.qa || {});
    qa.review = { status: "pending", updated_at: new Date().toISOString(), note: "Content changed; confirmation required again" };
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`UPDATE questions SET subject=?,chapter=?,topic=?,difficulty_level=?,question_type=?,question_text=?,options_json=?,answer_json=?,solution_text=?,qa_json=?,updated_at=? WHERE question_id=?`).run(
        next.subject, next.chapter, next.topic, next.difficulty_level, next.question_type, next.question_text,
        JSON.stringify(next.options), JSON.stringify(next.answer), next.solution_text, JSON.stringify(qa), now, id,
      );
      appendRevision(id, changed, prior, changedValues, body.reason || "Reviewer correction saved from GUI");
      db.prepare("UPDATE batches SET updated_at=? WHERE batch_id=?").run(now, current.batch_id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return send(res, 200, { question: parseRecord(db.prepare("SELECT * FROM questions WHERE question_id=?").get(id)), changed: true });
  }
  const reviewMatch = url.pathname.match(/^\/api\/questions\/([^/]+)\/review$/);
  if (req.method === "POST" && reviewMatch) {
    const id = decodeURIComponent(reviewMatch[1]);
    const current = parseRecord(db.prepare("SELECT * FROM questions WHERE question_id=?").get(id));
    if (!current) return send(res, 404, { error: "Question not found" });
    const body = await bodyJson(req);
    if (!["confirmed", "pending"].includes(body.status)) return send(res, 422, { error: "Review status must be confirmed or pending" });
    const qa = structuredClone(current.qa || {});
    const prior = qa.review || { status: "pending" };
    qa.review = { status: body.status, note: String(body.note || ""), updated_at: new Date().toISOString() };
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE questions SET qa_json=?,updated_at=? WHERE question_id=?").run(JSON.stringify(qa), new Date().toISOString(), id);
      appendRevision(id, ["qa.review"], { review: prior }, { review: qa.review }, body.status === "confirmed" ? "Question confirmed by reviewer" : "Question returned to pending review");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return send(res, 200, { question: parseRecord(db.prepare("SELECT * FROM questions WHERE question_id=?").get(id)) });
  }
  const qaMatch = url.pathname.match(/^\/api\/batches\/([^/]+)\/qa$/);
  if (req.method === "POST" && qaMatch) return send(res, 200, runQa(decodeURIComponent(qaMatch[1])));
  const approveMatch = url.pathname.match(/^\/api\/batches\/([^/]+)\/approve$/);
  if (req.method === "POST" && approveMatch) {
    const batchId = decodeURIComponent(approveMatch[1]);
    const body = await bodyJson(req);
    if (body.confirmation !== `APPROVE ${batchId}`) return send(res, 422, { error: `Type APPROVE ${batchId} to confirm` });
    const result = runQa(batchId);
    if (result.blocking_errors.length) return send(res, 409, { error: "QA has blocking errors", qa: result });
    const questions = db.prepare("SELECT question_id,qa_json,status FROM questions WHERE batch_id=?").all(batchId);
    const pending = questions.filter((q) => JSON.parse(q.qa_json || "{}").review?.status !== "confirmed");
    if (pending.length) return send(res, 409, { error: `${pending.length} questions are not confirmed`, pending: pending.map((q) => q.question_id) });
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const q of questions) {
        db.prepare("UPDATE questions SET status='approved',approved_at=?,updated_at=? WHERE question_id=?").run(now, now, q.question_id);
        appendRevision(q.question_id, ["status", "approved_at"], { status: q.status, approved_at: null }, { status: "approved", approved_at: now }, "Batch explicitly approved in GUI");
      }
      db.prepare("UPDATE batches SET status='approved',approved_at=?,updated_at=? WHERE batch_id=?").run(now, now, batchId);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return send(res, 200, batchSummary(batchId));
  }
  if (req.method === "GET" && url.pathname === "/api/taxonomy") {
    const rows = db.prepare(`SELECT t.*,COUNT(q.question_id) AS question_count FROM taxonomy t LEFT JOIN questions q ON q.exam=t.exam AND q.subject=t.subject AND q.chapter=t.chapter AND q.topic=t.topic WHERE t.active=1 GROUP BY t.taxonomy_id ORDER BY t.exam,t.subject,t.chapter,t.topic`).all();
    return send(res, 200, rows.map((row) => ({ ...row, aliases: JSON.parse(row.aliases_json || "[]") })));
  }
  if (req.method === "GET" && url.pathname === "/api/export") {
    const format = url.searchParams.get("format") || "json";
    const rows = listQuestions(url);
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === "csv") {
      const fields = ["question_id", "batch_id", "exam", "subject", "chapter", "topic", "difficulty_level", "question_type", "question_text", "options", "answer", "answer_source", "solution_text", "source_page", "source_block", "status", "review_status"];
      const csv = [fields.map(csvEscape).join(","), ...rows.map((row) => fields.map((field) => csvEscape(row[field])).join(","))].join("\n");
      return send(res, 200, csv, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="question-bank-${stamp}.csv"` });
    }
    return send(res, 200, JSON.stringify(rows, null, 2), { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="question-bank-${stamp}.json"` });
  }
  return send(res, 404, { error: "API route not found" });
}

function staticFile(res, base, requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const resolved = path.resolve(base, `.${decoded}`);
  if (!resolved.startsWith(path.resolve(base))) return send(res, 403, { error: "Forbidden" });
  let file = resolved;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".pdf": "application/pdf", ".svg": "image/svg+xml" };
  const headers = { "Content-Type": contentTypes[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  if (ext === ".html") headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'";
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (url.pathname.startsWith("/files/")) {
      const relative = url.pathname.slice("/files".length);
      if (staticFile(res, userFilesDir, relative)) return;
      return send(res, 404, { error: "Source file not found" });
    }
    if (staticFile(res, publicDir, url.pathname)) return;
    staticFile(res, publicDir, "/index.html");
  } catch (error) {
    console.error(error);
    send(res, error.message === "Invalid JSON body" ? 400 : 500, { error: error.message || "Internal server error" });
  }
});

server.listen(port, host, () => {
  const actualPort = server.address().port;
  console.log(`Question Bank Review running at http://localhost:${actualPort}`);
  console.log(`Database: ${dbPath}`);
  if (process.send) process.send({ type: "ready", port: actualPort });
});

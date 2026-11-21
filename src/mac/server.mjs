// The app's window (src/mac/ui) served on localhost, on macOS and Windows alike, running the tool's PowerShell code.
// Application calls go to one long-lived PowerShell (rpc.ps1); a run is run-images.ps1.
import "../../core/setup/session-env.mjs"; // FIRST: fixes PR_SESSION / PR_WORKSPACE before core/platform.mjs copies the environment
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFile, mkdir, copyFile, rm, stat, appendFile, readFile } from "node:fs/promises";
import { createReadStream, existsSync, mkdirSync, openSync, renameSync, statSync, appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, extname, resolve, sep, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { createConfigApi } from "../../core/setup/config-api.mjs";
import { createAgentRunner, buildPrompt, newRunId } from "../../core/setup/agent-run.mjs";
import { readFlowBrowser, saveFlowBrowser, localChromeProfiles } from "../../core/setup/flow-browser.mjs";
import { currentSession, sessionLabel, sessionWorkspace, sharedWorkspace, registerSession, updateSession, unregisterSession, listSessions, lockHolder, releaseLocks, peekGroup, sessionTitle, profileLabelOf, SESSION_RE } from "../../core/setup/session.mjs";
import { createFlowLogin, profileDirOf, profileGoogleAccounts, findChrome } from "../../core/setup/flow-login.mjs";
import { PWSH, toolEnv, psFile, psCommand, killTree, appWindow, chooseFiles } from "../../core/platform.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
// Each install gets its own port (from its folder), so two copies on one Mac never share data.
// A session (several windows from one source, core/setup/session.mjs) hashes its name in too; the default session keeps the old port.
const session = currentSession();
const BASE_PORT = Number(process.env.PR_PORT || 47000 + (parseInt(createHash("sha1").update(resolve(here, "..", "..") + (session ? "|" + session : "")).digest("hex").slice(0, 6), 16) % 1000));
let PORT = BASE_PORT;
// workspace = this session's own state (queue, runs, logs, output, tmp); sharedWs = the shared one (config, projects, source photos, Chrome profile).
const sharedWs = sharedWorkspace(root);
const workspace = sessionWorkspace(root, session);
const logs = join(workspace, "logs");
const uploads = join(workspace, "temp", "mac-uploads");
const configApi = createConfigApi({ hubRoot: root, pwsh: PWSH, env: toolEnv });
// Agent mode: Claude Code drives Google Flow and writes the reviews (core/setup/agent-run.mjs, docs/agent-prompt.md).
const agent = createAgentRunner({ toolRoot: root, workspace, profileDir: profileDirOf(sharedWs), getBrowser: () => readFlowBrowser(sharedWs), session });
// Quét web: the project of a run is the one whose session.json names the run (src/scan.ps1 start -Run); older scans keep a scan.json.
// Paths use "/" for the window.
const readJsonFile = (p) => JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
const csvRows = (csv) => (existsSync(csv) ? Math.max(0, readFileSync(csv, "utf8").split(/\r?\n/).filter((l) => l.trim()).length - 1) : 0);
function scanOfRun(runId) {
  if (!runId) return null;
  for (const folder of ["projects", "scans"]) {
    const base = join(sharedWs, folder);
    let names = [];
    try { names = readdirSync(base); } catch { continue; }
    for (const name of names) {
      try {
        const dir = join(base, name), csv = join(dir, "products.csv");
        if (folder === "projects") {
          const session = readJsonFile(join(dir, "session.json")), info = readJsonFile(join(dir, "project.json"));
          if (session.run !== runId) continue;
          const added = Object.values(session.added || {}).reduce((n, v) => n + Number(v || 0), 0);
          return { id: info.id || name, project: info.id || name, dir: dir.replace(/\\/g, "/"), csv: csv.replace(/\\/g, "/"), rows: csvRows(csv), site: info.site || "", max: session.max || info.max_per_collection || 0,
            added, already_known: Number(session.duplicates || 0), finished: !!(info.last_scan && info.last_scan >= (session.started || "")) };
        }
        const info = readJsonFile(join(dir, "scan.json"));
        if (info.run !== runId) continue;
        return { id: info.id || name, dir: dir.replace(/\\/g, "/"), csv: csv.replace(/\\/g, "/"), rows: csvRows(csv), site: info.site || "", max: info.max_per_collection || 0, finished: !!info.finished };
      } catch { /* not a scan folder */ }
    }
  }
  return null;
}
// The agent's own Chrome profile (workspace/chrome-profile): the person signs in to Google Flow there by hand, never in their real Chrome.
const flowLogin = createFlowLogin({ workspace: sharedWs, runActive: () => agent.isActive() });
// Errors from the window, this server and PowerShell go to workspace/logs (app-errors.log as Write-AppError
// writes it, mac-rpc.err.log), past 1 MB rolled over to *.old.log; Báo lỗi reads them.
mkdirSync(logs, { recursive: true });
function logFile(name) {
  const file = join(logs, name);
  try { if (statSync(file).size > 1024 * 1024) renameSync(file, file.replace(/\.log$/, ".old.log")); } catch {}
  return file;
}
function logError(where, text) {
  try { appendFileSync(logFile("app-errors.log"), `[${new Date().toISOString()}] ${where}\n  ${String(text).trim().replace(/\n/g, "\n  ")}\n\n`); } catch {}
}
process.on("uncaughtException", (e) => { logError("Máy chủ Mac", e.stack || e); process.exit(1); });
process.on("unhandledRejection", (e) => logError("Máy chủ Mac", e?.stack || e));

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon" };

// ----- PowerShell application calls -----
let rpcProc = null;
const waiting = new Map();
function startRpc() {
  rpcProc = spawn(PWSH, psFile(join(here, "rpc.ps1")), { cwd: root, env: toolEnv, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  createInterface({ input: rpcProc.stdout }).on("line", (line) => {
    if (!line.startsWith("@@RPC ")) return;
    const answer = JSON.parse(line.slice(6));
    const job = waiting.get(answer.id);
    if (!job) return;
    waiting.delete(answer.id);
    answer.ok ? job.resolve(answer.result) : job.reject(new Error(answer.error));
  });
  rpcProc.stderr.on("data", (d) => { try { appendFileSync(logFile("mac-rpc.err.log"), d); } catch {} });
  rpcProc.on("exit", () => {
    for (const job of waiting.values()) job.reject(new Error("PowerShell đã dừng."));
    waiting.clear();
    rpcProc = null;
  });
}
function rpc(cmd, args = {}) {
  if (!rpcProc) startRpc();
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    rpcProc.stdin.write(JSON.stringify({ id, cmd, args }) + "\n");
  });
}

// ----- Batch run (src/run-images.ps1) -----
const run = { proc: null, events: [], index: 0, stopped: false, exitCode: null, resultFolder: "", logFile: "", errFile: "", done: false };
async function receive(line) {
  const event = await rpc("event", { line, index: run.index }).catch(() => null);
  if (!event) return;
  if (event.Kind === "Item") run.index = event.Index;
  if (event.Kind === "Output") run.resultFolder = event.Path;
  run.events.push(event);
}
async function startRun({ threads = 1, backend = "codex", text = "codex" }) {
  if (run.proc || agent.isActive()) throw new Error("Đang chạy.");
  await mkdir(logs, { recursive: true });
  const stamp = Date.now();
  Object.assign(run, { events: [], index: 0, stopped: false, exitCode: null, resultFolder: "", done: false,
    logFile: join(logs, `image-batch-mac-${stamp}.log`), errFile: join(logs, `image-batch-mac-${stamp}.err.log`) });
  const args = ["-ThrottleLimit", String(threads)];
  // Tạo ảnh: Codex only here (Claude (Flow) runs through /api/agent/*).
  // Viết review: Codex, the Antigravity CLI or the Claude CLI, for every text step.
  if (["antigravity", "claude"].includes(text)) args.push("-TextBackend", text);
  const map = join(workspace, "reference-inputs", "references.json");
  if (existsSync(map)) args.push("-ReferenceMapFile", map);
  // Own process group (macOS), so Dừng stops codex and every other child too.
  const proc = spawn(PWSH, psFile(join(root, "src", "run-images.ps1"), args), { cwd: root, env: toolEnv, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  run.proc = proc;
  let chain = Promise.resolve();
  for (const [stream, file] of [[proc.stdout, run.logFile], [proc.stderr, run.errFile]]) {
    createInterface({ input: stream }).on("line", (line) => {
      chain = chain.then(() => appendFile(file, line + "\n")).then(() => receive(line));
    });
  }
  proc.on("exit", (code) => {
    chain = chain.then(async () => {
      run.exitCode = code;
      // Keep the full run log inside its batch, as the Windows app does.
      if (run.resultFolder && existsSync(run.resultFolder)) {
        const batchLogs = join(run.resultFolder, "logs");
        await mkdir(batchLogs, { recursive: true });
        for (const [from, name] of [[run.logFile, "run.log"], [run.errFile, "run.err.log"]]) {
          if (existsSync(from) && (await stat(from)).size) await copyFile(from, join(batchLogs, name));
          await rm(from, { force: true });
        }
      }
      run.proc = null;
      run.done = true;
    });
  });
}
function stopRun() {
  if (!run.proc) return;
  run.stopped = true;
  killTree(run.proc);
}

// ----- Tải về máy in the background (src/sync-source.ps1, as on Windows); the window polls its status file -----
const sync = { proc: null, statusFile: join(logs, "sync-status-mac.json") };
async function startSync(groups) {
  if (sync.proc) return false;
  await rm(sync.statusFile, { force: true });
  const out = openSync(logFile("mac-sync.log"), "a");
  sync.proc = spawn(PWSH, psFile(join(root, "src", "sync-source.ps1"), ["-Group", groups.join("|"), "-StatusFile", sync.statusFile]), { cwd: root, env: toolEnv, windowsHide: true, stdio: ["ignore", out, out] });
  sync.proc.on("exit", () => { sync.proc = null; });
  return true;
}
async function syncState() {
  const status = await readFile(sync.statusFile, "utf8").then(JSON.parse).catch(() => null);
  return { running: !!sync.proc, status };
}

// ----- Nhập hàng loạt in the background (src/import-batch.ps1, as on Windows); the dialog polls its status file -----
const imports = { proc: null, statusFile: join(logs, "import-status-mac.json"), inputFile: join(logs, "import-input-mac.csv") };
async function startImport(text, folder) {
  if (imports.proc) return false;
  await rm(imports.statusFile, { force: true });
  await writeFile(imports.inputFile, text, "utf8");
  const out = openSync(logFile("mac-import.log"), "a");
  imports.proc = spawn(PWSH, psFile(join(root, "src", "import-batch.ps1"), ["-File", imports.inputFile, "-Folder", folder, "-StatusFile", imports.statusFile]), { cwd: root, env: toolEnv, windowsHide: true, stdio: ["ignore", out, out] });
  imports.proc.on("exit", () => { imports.proc = null; rm(imports.inputFile, { force: true }).catch(() => {}); });
  return true;
}

// ----- Báo lỗi: src/support-report.mjs in its own process (Codex may take 2 minutes); its output lines are the progress -----
const errorsSend = { proc: null, outFile: join(logs, "send-errors-mac.out") };
async function startSendErrors() {
  if (errorsSend.proc) return false;
  await rm(errorsSend.outFile, { force: true });
  const out = openSync(errorsSend.outFile, "a");
  errorsSend.proc = spawn(process.execPath, [join(root, "src", "support-report.mjs")], { cwd: root, env: toolEnv, windowsHide: true, stdio: ["ignore", out, out] });
  errorsSend.proc.on("error", (error) => { appendFileSync(errorsSend.outFile, `error|${error.message.replace(/[\r\n|]/g, " ")}\n`); errorsSend.proc = null; });
  errorsSend.proc.on("close", () => { errorsSend.proc = null; });
  return true;
}

// ----- HTTP -----
const allowedFile = (p) => {
  const full = resolve(p);
  return [root + sep, resolve(tmpdir()) + sep].some((base) => full.startsWith(base)) && TYPES[extname(full).toLowerCase()]?.startsWith("image/");
};
const body = async (req) => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); };
const send = (res, status, data) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  if (path === "/api/root") return send(res, 200, { root, service: "product-review", protocol: 1, pid: process.pid, session, stt: self?.stt || 0 });
  // Sessions: this window (number, session, Chrome profile, next Chrome tab group) and the other open windows.
  if (path === "/api/session" && req.method === "GET") return send(res, 200, sessionInfo());
  if (path === "/api/sessions" && req.method === "GET") return send(res, 200, { current: session, sessions: sessionRows() });
  if (path === "/api/sessions/open" && req.method === "POST") {
    const b = JSON.parse((await body(req)).toString("utf8") || "{}");
    const name = String(b.name ?? "").trim().toLowerCase();
    if (name && !SESSION_RE.test(name)) return send(res, 400, { error: "Tên phiên chỉ gồm chữ thường, số và dấu gạch ngang (tối đa 30 ký tự)." });
    return send(res, 200, openSessionWindow(name));
  }
  // Errors in the window (app.js), kept like the Windows window's.
  if (path === "/api/client-error" && req.method === "POST") {
    const { message = "", stack = "" } = JSON.parse((await body(req)).toString("utf8") || "{}");
    logError("Giao diện Mac", [message, stack].filter(Boolean).join("\n").slice(0, 4000));
    return send(res, 200, { ok: true });
  }
  // Menu bar star: Mở cửa sổ / Thoát.
  if (path === "/api/open" && req.method === "POST") { openWindow(); return send(res, 200, { ok: true }); }
  if (path === "/api/quit" && req.method === "POST") {
    send(res, 200, { ok: true });
    stopRun();
    sync.proc?.kill();
    rpcProc?.kill();
    setTimeout(() => process.exit(0), 200);
    return;
  }
  if (path === "/api/rpc" && req.method === "POST") {
    const { cmd, args } = JSON.parse((await body(req)).toString("utf8"));
    try { return send(res, 200, { result: await rpc(cmd, args) }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (path === "/api/upload" && req.method === "POST") {
    // Pasted, dropped or picked images become local files the PowerShell code can snapshot.
    const name = (url.searchParams.get("name") || "image.png").replace(/[^\w.-]/g, "_");
    const ext = extname(name).toLowerCase();
    if (![".png", ".jpg", ".jpeg"].includes(ext) && !([".zip", ".rar", ".7z"].includes(ext) && url.searchParams.get("import"))) return send(res, 400, { error: "Chọn ảnh PNG hoặc JPEG." });
    // import=<id>: an image of a dropped import folder, kept by its own name in <uploads>/import-<id>/images.
    const id = (url.searchParams.get("import") || "").replace(/[^\w]/g, "");
    const dir = id ? join(uploads, `import-${id}`, "images") : uploads;
    await mkdir(dir, { recursive: true });
    const file = join(dir, id ? basename(url.searchParams.get("name") || "") : `${randomUUID().replace(/-/g, "")}${ext}`);
    await writeFile(file, await body(req));
    return send(res, 200, { path: file, folder: id ? dirname(dir) : "" });
  }
  if (path === "/api/sync" && req.method === "POST") {
    const { groups = [] } = JSON.parse((await body(req)).toString("utf8") || "{}");
    const names = groups.map(String).filter((g) => /^[\p{L}\p{N}][\p{L}\p{N} -]{0,59}$/u.test(g));
    if (!names.length) return send(res, 400, { error: "Chưa chọn danh mục." });
    return (await startSync(names)) ? send(res, 200, { ok: true }) : send(res, 409, { error: "Đang có một lượt tải về máy." });
  }
  if (path === "/api/sync" && req.method === "GET") return send(res, 200, await syncState());
  if (path === "/api/import" && req.method === "POST") {
    const { text = "", folder = "" } = JSON.parse((await body(req)).toString("utf8") || "{}");
    return (await startImport(String(text), String(folder))) ? send(res, 200, { ok: true }) : send(res, 409, { error: "Đang có một lượt nhập." });
  }
  if (path === "/api/import" && req.method === "GET") {
    const status = await readFile(imports.statusFile, "utf8").then(JSON.parse).catch(() => null);
    return send(res, 200, { running: !!imports.proc, status });
  }
  if (path === "/api/send-errors" && req.method === "POST") return (await startSendErrors()) ? send(res, 200, { ok: true }) : send(res, 409, { error: "Đang tạo báo cáo lỗi." });
  if (path === "/api/send-errors" && req.method === "GET") {
    const lines = (await readFile(errorsSend.outFile, "utf8").catch(() => "")).split("\n").map((l) => l.trim()).filter((l) => /^(step|sent|saved|error)\|/.test(l));
    return send(res, 200, { running: !!errorsSend.proc, last: lines.at(-1) || "" });
  }
  if (path === "/api/import" && req.method === "DELETE") { try { imports.proc?.kill("SIGKILL"); } catch {} return send(res, 200, { ok: true }); }
  if (path === "/api/run" && req.method === "POST") {
    try { await startRun(JSON.parse((await body(req)).toString("utf8") || "{}")); return send(res, 200, { ok: true }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (path === "/api/run" && req.method === "GET") {
    const since = Number(url.searchParams.get("since") || 0);
    return send(res, 200, { running: !!run.proc, done: run.done, exitCode: run.exitCode, stopped: run.stopped, resultFolder: run.resultFolder, events: run.events.slice(since), next: run.events.length });
  }
  // What the run pickers hold (Luồng, Viết review, Tạo ảnh), kept in workspace/config/run-settings.json so it survives a restart,
  // another window or port and a cleared browser.
  if (path === "/api/run-settings") {
    const file = join(sharedWs, "config", "run-settings.json");
    if (req.method === "GET") { try { const s = JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, "")); if (s.imageBackend && !["codex", "agent"].includes(s.imageBackend)) s.imageBackend = "codex"; if (s.textBackend && !["codex", "antigravity", "claude"].includes(s.textBackend)) s.textBackend = "codex"; delete s.runMode; s.flowAccounts = flowAccountsFor(readFlowBrowser(sharedWs)); return send(res, 200, s); } catch { return send(res, 200, { flowAccounts: flowAccountsFor(readFlowBrowser(sharedWs)) }); } }
    if (req.method === "POST") {
      const given = JSON.parse((await body(req)).toString("utf8") || "{}"), saved = {};
      try { Object.assign(saved, JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, ""))); } catch {}
      if (Number.isInteger(given.threads) && given.threads >= 1 && given.threads <= 4) saved.threads = given.threads;
      if (["codex", "antigravity", "claude"].includes(given.textBackend)) saved.textBackend = given.textBackend;
      if (["codex", "agent"].includes(given.imageBackend)) saved.imageBackend = given.imageBackend;
      if (typeof given.flowAccount === "string") { const v = given.flowAccount.trim(); if (!v) delete saved.flowAccount; else if (v.length <= 120 && /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/.test(v)) saved.flowAccount = v; }
      delete saved.runMode;
      await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(saved, null, 2));
      return send(res, 200, saved);
    }
  }

  if (path === "/api/stop" && req.method === "POST") { stopRun(); return send(res, 200, { ok: true }); }
  // Agent mode: prompt (filled), start, status (short sanitized progress), stop.
  if (path === "/api/agent/prompt" && req.method === "GET") {
    try { const runId = url.searchParams.get("run") || newRunId(); return send(res, 200, { run: runId, prompt: buildPrompt({ toolRoot: root, run: runId }) }); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (path === "/api/agent/run" && req.method === "POST") {
    if (run.proc) return send(res, 409, { error: "Đang chạy." });
    const given = JSON.parse((await body(req)).toString("utf8") || "{}");
    if (agent.isActive()) return send(res, 409, { error: "Đã có một lượt Claude đang chạy." });
    const login = readFlowBrowser(sharedWs).mode === "own" ? await flowLogin.status() : { state: "logged_in" };
    if (login.state !== "logged_in") return send(res, 409, { error: login.state === "logged_out" ? "Chưa đăng nhập Google Flow trong Chrome riêng: bấm Mở Chrome để đăng nhập, đăng nhập xong đóng cửa sổ đó rồi Kiểm tra lại." : "Chưa chạy được Claude: " + login.detail });
    const r = agent.start({ run: given.run || undefined });
    return send(res, r.status, r.ok ? { ok: true, run: r.run_id, started: r.started } : { error: r.error });
  }
  if (path === "/api/agent/status" && req.method === "GET") {
    const st = agent.status(), dir = st.run_id ? join(workspace, "output", st.run_id) : "";
    return send(res, 200, { ...st, result_folder: dir && existsSync(dir) ? dir : "" });
  }
  // Quét web: Claude scans a shop website (docs/scan-prompt.md) through the same runner; one agent run at a time (one Chrome profile).
  if (path === "/api/scan/run" && req.method === "POST") {
    const given = JSON.parse((await body(req)).toString("utf8") || "{}");
    let site = String(given.site || "").trim();
    if (site && !/^https?:\/\//i.test(site)) site = "https://" + site;
    let host = "";
    try { const u = new URL(site); if (/^https?:$/.test(u.protocol) && u.hostname.includes(".")) host = u.hostname; } catch { /* below */ }
    if (!host) return send(res, 400, { error: "Dán link trang chủ của web cần quét, ví dụ https://shop.com." });
    const max = Math.min(200, Math.max(1, Math.round(Number(given.max)) || 20));
    if (run.proc) return send(res, 409, { error: "Đang chạy." });
    if (agent.isActive()) return send(res, 409, { error: "Đã có một lượt Claude đang chạy (Flow hoặc quét). Chờ xong hoặc bấm Dừng." });
    const r = agent.start({ run: "scan-" + newRunId().slice(6), mode: "scan", site, max });
    return send(res, r.status, r.ok ? { ok: true, run: r.run_id, started: r.started } : { error: r.error });
  }
  if (path === "/api/scan/status" && req.method === "GET") {
    const st = agent.status();
    if (st.mode !== "scan") return send(res, 200, { mode: st.mode, scan_run: false, other_active: st.active, active: false, status: "idle", tail: [] });
    return send(res, 200, { ...st, scan_run: true, other_active: false, scan: scanOfRun(st.run_id) });
  }
  if (path === "/api/scan/stop" && req.method === "POST") {
    if (agent.status().mode !== "scan") return send(res, 409, { error: "Không có lượt quét nào đang chạy." });
    const r = agent.stop(); return send(res, r.status, r.ok ? { ok: true } : { error: r.error });
  }
  // Dự án: read the review number each product page of a project shows (docs/reviews-count-prompt.md), READ ONLY, through the same runner.
  // One agent run at a time (one Chrome profile), like Flow and Quét web.
  if (path === "/api/project/reviews/run" && req.method === "POST") {
    const given = JSON.parse((await body(req)).toString("utf8") || "{}");
    const id = String(given.project || "").trim();
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(id) || !existsSync(join(sharedWs, "projects", id, "project.json"))) return send(res, 400, { error: "Chọn một dự án có sẵn." });
    if (run.proc) return send(res, 409, { error: "Đang chạy." });
    if (agent.isActive()) return send(res, 409, { error: "Đã có một lượt Claude đang chạy (Flow, quét hoặc cập nhật review). Chờ xong hoặc bấm Dừng." });
    const r = agent.start({ run: "reviews-" + newRunId().slice(6), mode: "reviews", project: id });
    return send(res, r.status, r.ok ? { ok: true, run: r.run_id, started: r.started } : { error: r.error });
  }
  if (path === "/api/project/reviews/status" && req.method === "GET") {
    const st = agent.status();
    if (st.mode !== "reviews") return send(res, 200, { mode: st.mode, reviews_run: false, other_active: st.active, active: false, status: "idle", tail: [] });
    return send(res, 200, { ...st, reviews_run: true, other_active: false });
  }
  if (path === "/api/project/reviews/stop" && req.method === "POST") {
    if (agent.status().mode !== "reviews") return send(res, 409, { error: "Không có lượt cập nhật review nào đang chạy." });
    const r = agent.stop(); return send(res, r.status, r.ok ? { ok: true } : { error: r.error });
  }
  // Dự án: put products of a project into the run queue (urls.txt + references.json) with 2 library scenes each chosen by Claude
  // (docs/queue-prompt.md). Prepares only: no image creation, no review text. One agent run at a time, like the other modes.
  if (path === "/api/project/queue/run" && req.method === "POST") {
    const given = JSON.parse((await body(req)).toString("utf8") || "{}");
    const id = String(given.project || "").trim();
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(id) || !existsSync(join(sharedWs, "projects", id, "project.json"))) return send(res, 400, { error: "Chọn một dự án có sẵn." });
    const count = Math.min(200, Math.max(1, Math.round(Number(given.count)) || 10));
    const scenes = Math.min(4, Math.max(1, Math.round(Number(given.scenes)) || 2));
    const category = String(given.category || "").replace(/[\r\n"]+/g, " ").trim().slice(0, 120);
    if (run.proc) return send(res, 409, { error: "Đang chạy." });
    if (agent.isActive()) return send(res, 409, { error: "Đã có một lượt Claude đang chạy (Flow, quét hoặc cập nhật). Chờ xong hoặc bấm Dừng." });
    const options = `category: ${category ? `"${category}"` : "(all categories)"}; only unused (used = F): ${given.unused_only ? "T" : "F"}; products to queue: ${count}; scenes per product: ${scenes}`;
    const r = agent.start({ run: "queue-" + newRunId().slice(6), mode: "queue", project: id, options });
    return send(res, r.status, r.ok ? { ok: true, run: r.run_id, started: r.started } : { error: r.error });
  }
  // Scenes box = 0: no Claude run. The first N products in table order (category / only-unused filter) go into the queue with only their link and
  // project photo (src/scan.ps1 queue-direct, the same writer as queue-add).
  if (path === "/api/project/queue/direct" && req.method === "POST") {
    const given = JSON.parse((await body(req)).toString("utf8") || "{}");
    const id = String(given.project || "").trim();
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(id) || !existsSync(join(sharedWs, "projects", id, "project.json"))) return send(res, 400, { error: "Chọn một dự án có sẵn." });
    const count = Math.min(200, Math.max(1, Math.round(Number(given.count)) || 10));
    const args = ["queue-direct", "-Project", id, "-Limit", String(count), ...(String(given.category || "").trim() ? ["-Collection", String(given.category).trim()] : []), ...(given.unused_only ? ["-UnusedOnly"] : [])];
    return execFile(PWSH, psFile(join(root, "src", "scan.ps1"), args), { cwd: root, env: toolEnv, timeout: 120000, windowsHide: true, encoding: "utf8" }, (err, out) => {
      let r = null; try { r = JSON.parse(String(out || "").trim().split(String.fromCharCode(10)).pop()); } catch { /* below */ }
      if (r?.ok) return send(res, 200, { ok: true, added: r.added });
      send(res, 500, { error: r?.error || (err && err.message) || "Chưa thêm vào hàng chờ được." });
    });
  }
  if (path === "/api/project/queue/status" && req.method === "GET") {
    const st = agent.status();
    if (st.mode !== "queue") return send(res, 200, { mode: st.mode, queue_run: false, other_active: st.active, active: false, status: "idle", tail: [] });
    return send(res, 200, { ...st, queue_run: true, other_active: false });
  }
  if (path === "/api/project/queue/stop" && req.method === "POST") {
    if (agent.status().mode !== "queue") return send(res, 409, { error: "Không có lượt thêm vào hàng chờ nào đang chạy." });
    const r = agent.stop(); return send(res, r.status, r.ok ? { ok: true } : { error: r.error });
  }
  // Own Chrome sign-in for Claude (Flow): status (short headless check), open (normal Chrome window for the person to sign in).
  // Which browser Claude (Flow) drives: everyday Chrome (a profile chosen from this machine) or the tool's own Chrome.
  if (path === "/api/flow-browser" && req.method === "GET") return send(res, 200, { ...readFlowBrowser(sharedWs), ...localChromeProfiles() });
  // Opens the Chrome Web Store page of the Playwright MCP Bridge in THE CHOSEN profile; the person clicks "Add to Chrome" (nothing is installed for them).
  if (path === "/api/flow-browser/install-extension" && req.method === "POST") {
    try {
      const b = JSON.parse((await body(req)).toString("utf8") || "{}"), folder = String(b.profile || "");
      if (!/^(Default|Profile \d{1,3})$/.test(folder)) return send(res, 400, { error: "Profile không hợp lệ." });
      if (!localChromeProfiles().profiles.some((p) => p.folder === folder)) return send(res, 400, { error: "Profile này không có trên máy." });
      const chrome = findChrome();
      if (!chrome) return send(res, 400, { error: "Không tìm thấy Google Chrome (đặt PR_CHROME_PATH nếu cài ở chỗ khác)." });
      const child = spawn(chrome, ["--profile-directory=" + folder, "https://chromewebstore.google.com/detail/playwright-mcp-bridge/mmlmfjhmonkocbjadbfplnigmagldckm"], { detached: true, stdio: "ignore" });
      child.on("error", () => {}); child.unref();
      return send(res, 200, { ok: true, profile: folder });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (path === "/api/flow-browser" && req.method === "POST") { try { const b = JSON.parse((await body(req)).toString("utf8") || "{}"); const saved = saveFlowBrowser(sharedWs, b); alignFlowAccount(saved); return send(res, 200, saved); } catch (e) { return send(res, 400, { error: e.message }); } }
  if (path === "/api/flow-login/status" && req.method === "GET") return send(res, 200, await flowLogin.status({ fresh: url.searchParams.get("fresh") === "1" }));
  if (path === "/api/flow-login/open" && req.method === "POST") { const h = lockHolder(root, "chrome", "own", session); if (h) return send(res, 409, { error: "Chrome riêng của tool đang được phiên \"" + sessionLabel(h.session) + "\" dùng: đóng nó trước." }); const r = flowLogin.open(); return send(res, r.status, r.ok ? { ok: true } : { error: r.error }); }
  if (path === "/api/agent/stop" && req.method === "POST") { const r = agent.stop(); return send(res, r.status, r.ok ? { ok: true } : { error: r.error }); }
  // Cấu hình (core/setup/config-api.mjs).
  if (await configApi(req, res, path)) return;
  if (path === "/api/choose-images" && req.method === "POST") {
    // The system file dialog: opens the app's own folder and returns real paths (no copy through the browser).
    // table: a CSV or ZIP / RAR / 7Z archive for Nhập hàng loạt instead of images.
    const { folder = "", table = false } = JSON.parse((await body(req)).toString("utf8") || "{}");
    chooseFiles({ folder, table }, (paths) => send(res, 200, { paths }));
    return;
  }
  if (path === "/api/reload" && req.method === "POST") {
    // Tải lại: a fresh server on the files as they are now; the page reloads once it answers again. Not mid-run.
    if (run.proc || agent.isActive()) return send(res, 409, { error: "Đang chạy. Dừng hoặc chờ xong rồi tải lại." });
    send(res, 200, { ok: true });
    setTimeout(() => {
      const out = openSync(logFile("mac-server.log"), "a");
      server.close();
      spawn(process.execPath, [join(here, "server.mjs"), "--no-open"], { cwd: root, detached: true, windowsHide: true, stdio: ["ignore", out, out], env: { ...process.env, PR_WAIT_PORT: "1" } }).unref();
      rpcProc?.kill();
      setTimeout(() => process.exit(0), 300);
    }, 300);
    return;
  }
  if (path === "/api/update" && req.method === "POST") {
    // Update the files, then start a fresh server on the new code; the page reloads itself.
    execFile(PWSH, psCommand(`. '${join(root, "core", "update.ps1").replace(/'/g, "''")}' -NoRun; Update-App '${root.replace(/'/g, "''")}'`), { cwd: root, env: toolEnv, timeout: 300000, windowsHide: true }, (err) => {
      if (err) return send(res, 500, { error: err.message });
      send(res, 200, { ok: true });
      setTimeout(() => {
        const out = openSync(logFile("mac-server.log"), "a");
        spawn(process.execPath, [join(here, "server.mjs"), "--no-open"], { cwd: root, detached: true, windowsHide: true, stdio: ["ignore", out, out], env: { ...process.env, PR_WAIT_PORT: "1" } }).unref();
        rpcProc?.kill();
        setTimeout(() => process.exit(0), 300);
      }, 300);
    });
    return;
  }
  if (path === "/file") {
    const file = url.searchParams.get("path") || "";
    if (!allowedFile(file) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()], "cache-control": "no-store" });
    return createReadStream(file).pipe(res);
  }
  const rel = path === "/" ? "index.html" : path.slice(1);
  const file = resolve(here, "ui", rel);
  if (!file.startsWith(resolve(here, "ui") + sep) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-store" });
  createReadStream(file).pipe(res);
}

// A star in the macOS menu bar while the app runs (src/mac/menubar.js); it goes away with the server.
let menuBar = null;
function startMenuBar() {
  if (process.platform !== "darwin" || process.env.PR_NO_MENUBAR) return;
  menuBar = spawn("osascript", ["-l", "JavaScript", join(here, "menubar.js")], { env: { ...process.env, PR_PORT: String(PORT) }, stdio: "ignore" });
  menuBar.on("error", () => { menuBar = null; });
}
process.on("exit", () => { try { menuBar?.kill(); } catch {} try { agent.shutdown(); } catch {} try { releaseLocks(root, session); unregisterSession(root, session); } catch {} });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));

// The Google accounts the Flow account combo may list: those signed in in the chosen Chrome profile (extension mode), or in the tool's own Chrome.
function flowAccountsFor(browser) {
  if (!browser || browser.mode === "own") return profileGoogleAccounts(profileDirOf(sharedWs));
  const p = localChromeProfiles().profiles.find((x) => x.folder === browser.profile);
  return p ? p.accounts : [];
}
// After the Chrome profile changed: the saved Flow account must belong to it; else it becomes the profile's primary account (or none).
function alignFlowAccount(browser) {
  if (!browser || browser.mode === "own") return;
  const file = join(sharedWs, "config", "run-settings.json");
  let saved = {}; try { saved = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch {}
  const accounts = flowAccountsFor(browser), cur = String(saved.flowAccount || "").toLowerCase();
  if (cur && accounts.includes(cur)) return;
  if (accounts[0]) saved.flowAccount = accounts[0]; else delete saved.flowAccount;
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(saved, null, 2));
}
// ----- Sessions (several windows from one source) -----
let self = null; // this window's registry entry, once the server listens
function profileLabel() { try { const b = readFlowBrowser(sharedWs); return profileLabelOf(b, localChromeProfiles().profiles); } catch { return ""; } }
function sessionInfo() {
  const label = profileLabel();
  const group = peekGroup(workspace, session);
  return { session, label: sessionLabel(session), stt: self?.stt || 0, port: PORT, pid: process.pid, profile_label: label, running: agent.isActive(),
    next_group: group, title: sessionTitle({ stt: self?.stt, session, profileLabel: label }) };
}
function sessionRows() {
  return listSessions(root).map((e) => ({ stt: e.stt, session: e.session, label: sessionLabel(e.session), port: e.port, pid: e.pid, profile_label: e.profile_label || "", running: !!e.running, project: e.project || "", current: e.pid === process.pid }));
}
function syncRegistry() { try { if (self) updateSession(root, session, process.pid, { profile_label: profileLabel(), running: agent.isActive() }); } catch {} }
// Opens (or refocuses, when it already runs) the window of a session: the launcher does it, so macOS and Windows behave alike.
function openSessionWindow(name) {
  try {
    const windows = process.platform === "win32";
    const cmd = windows ? "powershell.exe" : "bash";
    const args = windows ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", join(root, "core", "launch.ps1"), "-Session", name] : [join(root, "start-app.command"), name];
    const child = spawn(cmd, args, { cwd: root, detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return { ok: true, session: name, label: sessionLabel(name) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Its own window on macOS (core/platform.mjs); on Windows the launcher's app window shows it.
const openWindow = () => appWindow(`http://127.0.0.1:${PORT}/`);

const server = createServer((req, res) => handle(req, res).catch((e) => send(res, 500, { error: e.message })));
function listen(attempt = 0) {
  server.once("error", (e) => {
    // Already running (or the old server is still closing after an update).
    if (e.code === "EADDRINUSE" && process.env.PR_WAIT_PORT && attempt < 50) return setTimeout(() => listen(attempt + 1), 200);
    if (e.code === "EADDRINUSE") {
      // Already running for this folder: just show its window. Another program on the port: try the next one.
      return fetch(`http://127.0.0.1:${PORT}/api/root`).then((r) => r.json()).then((body) => {
        if (body.root !== root) throw new Error("other");
        if (!process.argv.includes("--no-open")) openWindow();
        process.exit(0);
      }).catch(() => {
        if (PORT - BASE_PORT >= 20) throw e;
        PORT++;
        listen(attempt);
      });
    }
    throw e;
  });
  server.listen(PORT, "127.0.0.1", () => { try { self = registerSession(root, { session, port: PORT, extra: { profile_label: profileLabel(), running: false } }); setInterval(syncRegistry, 5000).unref(); } catch (e) { logError("Sessions", e.message); } startMenuBar(); if (!process.argv.includes("--no-open")) openWindow(); });
}
startRpc();
listen();

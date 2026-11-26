// The app's window (src/mac/ui) served on localhost, on macOS and Windows alike, running the tool's PowerShell code.
// Application calls go to one long-lived PowerShell (rpc.ps1); a run is run-images.ps1.
import "../../core/setup/session-env.mjs"; // FIRST: fixes PR_SESSION / PR_WORKSPACE before core/platform.mjs copies the environment
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFile, mkdir, copyFile, rm, stat, appendFile, readFile } from "node:fs/promises";
import { createReadStream, rmSync, existsSync, mkdirSync, openSync, renameSync, statSync, appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname, extname, resolve, sep, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { createConfigApi } from "../../core/setup/config-api.mjs";
import { createAgentRunner, checkExtensionProfile, buildPrompt, newRunId, readFlowAccount, FEATURE, CLAUDE_MODEL_GROUPS, CLAUDE_DEFAULT_MODEL, isClaudeModel, CLAUDE_EFFORTS, AGENT_BACKENDS, AGENT_TASK_KEY, AGY_EFFORTS, isAgyModel, listAgyModels, readAgentSettings } from "../../core/setup/agent-run.mjs";
import { readFlowBrowser, saveFlowBrowser, localChromeProfiles, tokenProfiles, saveExtensionToken, followFlowAccount } from "../../core/setup/flow-browser.mjs";
import { currentSession, sessionLabel, sessionWorkspace, sharedWorkspace, registerSession, updateSession, unregisterSession, listSessions, lockHolder, releaseLocks, peekGroup, sessionTitle, profileLabelOf, projectBusyBy, setSessionProject, claimProjectFocus, readSeededJson, updateJsonLocked, SESSION_RE } from "../../core/setup/session.mjs";
import { createFlowLogin, profileDirOf, profileGoogleAccounts, findChrome, flowOpenUrl, WINDOW_ARGS } from "../../core/setup/flow-login.mjs";
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
const agentRunner = createAgentRunner({ toolRoot: root, workspace, profileDir: profileDirOf(sharedWs), getBrowser: () => readFlowBrowser(workspace, sharedWs), session, kind: "main" });
// The light runner: queue and prep runs (no browser, no Chrome profile, own state files runs/prep-run.*): they go on while Bắt đầu runs.
// Luồng N (Dự án popup): up to 4 light runs at once, each on its own disjoint slice of the work (own state / log files prep-run[-k].*). `light` keeps the
// one-runner API (start / stop / status / isActive / shutdown) over the pool, so every route and the queue order treat the shards as one run.
const lightPool = [0, 1, 2, 3].map((slot) => createAgentRunner({ toolRoot: root, workspace, profileDir: profileDirOf(sharedWs), session, kind: "light", slot }));
const light = {
  isActive: () => lightPool.some((r) => r.isActive()),
  start: (opts) => lightPool[0].start(opts),
  stop: () => { let res = null; for (const r of lightPool) if (r.isActive()) res = r.stop(); return res || { ok: false, status: 409, error: "No run is active." }; },
  shutdown: () => { for (const r of lightPool) { try { r.shutdown(); } catch {} } },
  status: () => {
    const act = lightPool.filter((r) => r.isActive()).map((r) => r.status());
    if (!act.length) cleanShardFiles();
    if (act.length) { const st = { ...act[0] }; if (act.length > 1) { st.shards = act.length; st.turns = act.reduce((a, x) => a + (x.turns || 0), 0); } return st; }
    const all = lightPool.map((r) => r.status()).filter((x) => x.started).sort((a, b) => String(b.updated || b.started).localeCompare(String(a.updated || a.started)));
    return all.find((x) => x.status === "failed") || all[0] || lightPool[0].status();
  },
};
// A 409 for the light runner: when the image job's workers hold it, say so.
const lightBusyText = (base) => (jobActive() ? "Lượt tạo ảnh nhiều pha đang dùng các worker nhẹ (ngữ cảnh / review): chờ worker xong rồi chạy." : base);
const clampThreads = (v, fallback = 1) => { const n = Math.round(Number(v)); return Number.isInteger(n) ? Math.min(4, Math.max(1, n)) : fallback; };
const savedThreads = () => { try { return clampThreads(readSeededJson(join(workspace, "config", "run-settings.json"), join(sharedWs, "config", "run-settings.json"), {}).threads, 1); } catch { return 1; } };
// ----- Image + review run in PHASES when Luồng N > 1 -----
// Everything that needs no browser runs N at a time; the browser step stays what it is:
//   A  context + sign wording + custom-logo flags: N "ctx" workers on disjoint slices of the items (no browser)
//   B  the pictures: ONE main run (Google Flow for Claude / Antigravity (Flow): sequential with the pacing rules; Antigravity's own images: its N-parallel groups)
//   C  review writing: N "rev" workers on disjoint slices (the write-review quality gate runs inside the CLI under a lock)
//   F  finish (results upload) one item at a time by the app itself, no AI.
// Luồng 1 = no job: one run does everything, exactly as before. Chạy tiếp re-enters the phases and every phase skips what already exists on disk.
let imgJob = null, jobFinal = null, jobTimer = null;
const jobActive = () => !!imgJob;
const runDirOf = (run) => join(workspace, "output", run);
const jobIds = (run) => { try { const j = JSON.parse(readFileSync(join(runDirOf(run), "agent-items.json"), "utf8").replace(/^\uFEFF/, "")); return (Array.isArray(j) ? j : j.items || []).map((x) => x && x.id).filter(Boolean); } catch { return []; } };
const hasCtx = (run, id) => existsSync(join(runDirOf(run), "logs", id + "-context.json"));
const hasImg = (run, id) => existsSync(join(runDirOf(run), "images", id + ".png"));
const hasRev = (run, id) => existsSync(join(runDirOf(run), "logs", id + "-review.txt"));
function doneRows(run) { try { const r = JSON.parse(readFileSync(join(runDirOf(run), "results.json"), "utf8").replace(/^\uFEFF/, "")); return (Array.isArray(r) ? r : []).map((x) => String(x.photo_path || "").replace(/\\/g, "/").split("/").pop().replace(/\.[^.]+$/, "")); } catch { return []; } }
const normLink = (u) => String(u || "").trim().replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();
function linkStates() {
  const st = agent.status();
  let run = st.run_id && existsSync(join(runDirOf(st.run_id), "agent-items.json")) ? st.run_id : "";
  if (!run) { try { run = readdirSync(join(workspace, "output"), { withFileTypes: true }).filter((e) => e.isDirectory() && /^agent-/.test(e.name) && existsSync(join(runDirOf(e.name), "agent-items.json"))).map((e) => e.name).sort().pop() || ""; } catch {} }
  if (!run) return { run: "", active: false, links: {} };
  let items = [];
  try { const j = JSON.parse(readFileSync(join(runDirOf(run), "agent-items.json"), "utf8").replace(/^﻿/, "")); items = Array.isArray(j) ? j : j.items || []; } catch {}
  const fin = new Set(doneRows(run)), active = !!(st.active && st.run_id === run) || !!(imgJob && imgJob.run === run), links = {};
  for (const it of items) {
    if (!it || !it.id) continue;
    const l = (links[normLink(it.url)] ||= { total: 0, img: 0, rev: 0, done: 0, fail: 0 });
    l.total++;
    const img = hasImg(run, it.id);
    if (img) l.img++;
    if (hasRev(run, it.id)) l.rev++;
    if (fin.has(it.id)) l.done++; else if (!img && existsSync(join(runDirOf(run), "logs", it.id + "-agent-error.txt"))) l.fail++;
  }
  for (const l of Object.values(links)) l.state = l.done >= l.total ? "done" : active ? "running" : l.fail ? "failed" : (l.img || l.rev) ? "partial" : "todo";
  return { run, active, links };
}
function jobLog(j, text) { j.lines.push(new Date().toTimeString().slice(0, 8) + " [Tạo ảnh & review] " + text); if (j.lines.length > 200) j.lines.shift(); j.text = text; }
function runAgentCli(args, timeout = 240000) {
  return new Promise((resolveCli) => execFile(PWSH, psFile(join(root, "src", "agent.ps1"), args), { cwd: root, env: toolEnv, timeout, windowsHide: true, encoding: "utf8" }, (err, out, stderr) => {
    let r = null; try { r = JSON.parse(String(out || "").trim().split(String.fromCharCode(10)).pop()); } catch { /* below */ }
    resolveCli(r || { ok: false, error: cliFailure(err, stderr, timeout, "Lệnh của lượt (agent.ps1 " + String(args[0] || "") + ")") });
  }));
}
// Viết review: auto = the image agent writes the reviews itself (and Codex is the text AI of the Codex run); an explicit AI writes them AFTER the images exist, run by the app.
const reviewAiOf = () => { try { const s = readSeededJson(join(workspace, "config", "run-settings.json"), join(sharedWs, "config", "run-settings.json"), {}); return ["codex", "claude", "antigravity"].includes(s.reviewAi) ? s.reviewAi : "auto"; } catch { return "auto"; } };
const REVIEW_AI_NAME = { codex: "Codex", claude: "Claude", antigravity: "Antigravity" };
function startImgJob(run, threads, agentName, labelAi = agentName, reviewAi = "auto") {
  imgJob = { run, n: clampThreads(threads), phase: "prepare", started: Date.now(), lines: [], text: "Đang chuẩn bị…", agent: agentName, label_ai: labelAi, reviewAi, stopped: false, busy: false,
    claimed: new Set(), revTries: {}, active: 0, finTried: new Set(), finNext: {}, finTries: {}, finBusy: false, finFailed: 0, workerBatch: null, launches: 0, noProgress: 0, lastHave: 0, imagesDone: false, fatal: "", imageError: "", imageIssue: "" };
  jobFinal = null;
  jobLog(imgJob, "Chia việc " + imgJob.n + " luồng: ngữ cảnh → tạo ảnh (review và hoàn tất chạy song song ngay khi có ảnh)");
  jobTimer = jobTimer || setInterval(() => { jobTick().catch(() => {}); }, 2000);
  setImmediate(() => jobTick().catch(() => {}));
}
function finishJob(status, error = "") {
  const j = imgJob; if (!j) return;
  const base = agentRunner.status();
  jobFinal = { run_id: j.run, status, error, tail: [...(base.run_id === j.run ? base.tail || [] : []), ...j.lines].slice(-30) };
  imgJob = null;
  try { agentRunner.setFinal(j.run, { status, error, mode: "flow", agent: j.agent, label_ai: j.label_ai }); } catch {}
  if (jobTimer) { clearInterval(jobTimer); jobTimer = null; }
  cleanShardFiles();
}
// N workers of one phase on contiguous disjoint slices of ids; each is a light run (own slot, own temp prompt dir, the run's AI).
function startPhaseWorkers(j, mode, ids) {
  const n = Math.min(j.n, ids.length), chunk = Math.ceil(ids.length / n), stamp = newRunId().slice(6), started = [];
  for (let k = 1; k <= n; k++) {
    const part = ids.slice((k - 1) * chunk, k * chunk);
    if (!part.length) continue;
    const file = join(workspace, "tmp", "items-" + stamp + "-" + mode + k + ".json"); shardFiles.push(file);
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(part)); } catch (e) { for (const r of started) r.stop(); return { ok: false, error: e.message }; }
    const runner = lightPool[k - 1], r = runner.start({ run: mode + "-" + stamp + "-s" + k, mode, project: "", options: "items file: " + file + "; items: " + part.length + "; image run: " + j.run, shard: k + "/" + n, targetRun: j.run });
    if (!r.ok) { for (const x of started) x.stop(); return r; }
    started.push(runner);
  }
  return { ok: true, workers: started.length };
}
// An item the image agent explicitly gave up on ([CAUSE:REFUSED] ...) has an error file and no image: it is not "missing", the run does not wait for it.
const hasGaveUp = (run, id) => { try { return /CAUSE:(REFUSED|QUOTA)/.test(readFileSync(join(runDirOf(run), "logs", id + "-agent-error.txt"), "utf8")) && !hasImg(run, id); } catch { return false; } };
// A CLI command that met the per-run lock another worker holds (LOCK_BUSY): wait a moment and ask again (bounded), logged ONCE per item as an amber note; never a failed attempt.
async function runCliPatient(j, args, short, timeout) {
  let noted = false, r;
  for (let i = 0; i < 8 && !j.stopped; i++) {
    r = await runAgentCli(args, timeout);
    if (r.ok || !(r.cause === "LOCK_BUSY" || /LOCK_BUSY|worker khác/.test(String(r.error || "")))) return r;
    if (!noted) { noted = true; jobLog(j, "⚠ Mục " + short + ": đợi worker khác ghi, thử lại"); }
    await new Promise((x) => setTimeout(x, 1500 + Math.random() * 2500));
  }
  return r;
}
// One review by an explicit text AI: review-brief -> ai-draft (that AI + the image) -> write-review (quality gate under the run lock; up to 3 repairs naming the problem; the 4th
// draft is kept, an item is never dropped for its wording). CLI text calls, no browser.
async function autoReviewItem(j, id) {
  const ai = j.reviewAi, name = REVIEW_AI_NAME[ai], short = (id.match(/^\d+/) || [id])[0];
  const b = await runCliPatient(j, ["review-brief", "-Run", j.run, "-Item", id], short);
  if (!b.ok) { jobLog(j, "Mục " + short + ": chưa lập được đề review (" + String(b.error || "").slice(0, 100) + ")"); return; }
  let extra = "";
  for (let attempt = 1; attempt <= 4 && !j.fatal && !j.stopped; attempt++) {
    const out = join(workspace, "tmp", "rv-" + j.run + "-" + id + ".txt"); shardFiles.push(out);
    const d = await runAgentCli(["ai-draft", "-Run", j.run, "-Item", id, "-Backend", ai, "-File", out, ...(extra ? ["-Text", extra] : [])], 900000);
    if (!d.ok) {
      if (/QUOTA|AUTH/.test(String(d.cause || "")) || /quota|exhausted|sign in/i.test(String(d.error || ""))) { j.fatal = name + " không viết được (" + String(d.cause || d.error || "").slice(0, 120) + "). Chọn AI khác cho Viết review rồi Chạy tiếp."; jobLog(j, j.fatal); }
      else jobLog(j, "Mục " + short + ": " + name + " lỗi (" + String(d.error || d.cause || "").slice(0, 100) + ")");
      return;
    }
    const w = await runCliPatient(j, ["write-review", "-Run", j.run, "-Item", id, "-File", out], short);
    if (w.ok) return;
    extra = "Your previous draft was rejected: " + [].concat(w.problems || w.error || "").join(" ") + " Rewrite it fixing only that, keep the observations about the photo.";
  }
}
// Reviews start AS SOON AS an item has its image (while the image agent keeps working): an explicit AI = a pool of up to N items at a time; the agent AI = rev workers on the items
// that are ready (a batch of at least N while images are still coming, anything once they are done). Items are claimed in memory (one orchestrator), each tried twice at most.
function pumpReviews(j, draining) {
  const ids = jobIds(j.run);
  if (j.workerBatch && !lightPool.some((r) => r.isActive())) { for (const id of j.workerBatch) j.claimed.delete(id); j.workerBatch = null; }
  const ready = ids.filter((id) => hasImg(j.run, id) && !hasRev(j.run, id) && !j.claimed.has(id) && (j.revTries[id] || 0) < 2);
  if (!ready.length || j.fatal) return;
  if (j.reviewAi !== "auto") {
    while (j.active < j.n && ready.length) {
      const id = ready.shift(); j.claimed.add(id); j.revTries[id] = (j.revTries[id] || 0) + 1; j.active++;
      if (!j.reviewLogged) { j.reviewLogged = true; jobLog(j, "Review bằng " + REVIEW_AI_NAME[j.reviewAi] + ": bắt đầu ngay khi có ảnh, " + j.n + " luồng"); }
      autoReviewItem(j, id).catch(() => {}).finally(() => { j.active--; j.claimed.delete(id); });
    }
  } else if (!lightPool.some((r) => r.isActive()) && (draining || ready.length >= Math.max(2, j.n))) {
    const r = startPhaseWorkers(j, "rev", ready);
    if (!r.ok) { jobLog(j, "Chưa khởi động được worker review: " + String(r.error || "").slice(0, 100)); for (const id of ready) j.revTries[id] = 9; return; }
    for (const id of ready) { j.claimed.add(id); j.revTries[id] = (j.revTries[id] || 0) + 1; }
    j.workerBatch = ready.slice();
    jobLog(j, "Review: " + ready.length + " mục chia " + r.workers + " luồng (song song với tạo ảnh)");
  }
}
// finish (the results upload) per item as soon as image + review exist: one at a time, never blocking the tick.
// A failed results upload (network down for a moment: HTTP 0 ...) is retried with a growing wait before it counts as a failure.
const FIN_WAITS = String(process.env.PR_FIN_WAITS || "").split(",").map(Number).filter((n) => n > 0).length ? String(process.env.PR_FIN_WAITS).split(",").map(Number) : [10000, 30000, 120000, 300000]; // PR_FIN_WAITS only for tests
async function pumpFinish(j) {
  if (j.finBusy) return;
  const done = new Set(doneRows(j.run));
  const need = jobIds(j.run).filter((id) => hasImg(j.run, id) && hasRev(j.run, id) && !done.has(id) && !j.finTried.has(id) && !(j.finNext[id] > Date.now()));
  if (!need.length) return;
  j.finBusy = true;
  try {
    for (const id of need) {
      if (j.stopped) break;
      const short = (id.match(/^\d+/) || [id])[0];
      const r = await runCliPatient(j, ["finish", "-Run", j.run, "-Item", id], short);
      if (r.ok) { j.finTried.add(id); continue; }
      const transient = r.cause === "RESULT_UPLOAD" || /HTTP 0|network|timed? ?out|ECONN|fetch failed|connection/i.test(String(r.error || ""));
      const n = (j.finTries[id] || 0) + 1; j.finTries[id] = n;
      if (transient && n <= FIN_WAITS.length) { const wait = FIN_WAITS[n - 1]; j.finNext[id] = Date.now() + wait; jobLog(j, "⚠ Mục " + short + ": tải kết quả lên kho chưa được (mạng?), tự thử lại lần " + n + "/" + FIN_WAITS.length + " sau " + Math.round(wait / 1000) + " giây"); }
      else { j.finTried.add(id); j.finFailed++; jobLog(j, "Mục " + short + " chưa tải lên kho: " + String(r.error || r.cause || "").slice(0, 160)); }
    }
  } finally { j.finBusy = false; }
}
async function jobTick() {
  const j = imgJob;
  if (!j || j.busy) return;
  j.busy = true;
  try {
    if (j.stopped) return finishJob("stopped");
    if (j.phase === "prepare") {
      const r = await runAgentCli(["prepare", "-Run", j.run]);
      if (!r.ok) return finishJob("failed", r.error || "Chưa lập được danh sách mục của lượt.");
      j.phase = j.n > 1 ? "ctx-next" : "images";  // Luồng 1: the image agent does the context itself
    }
    if (j.phase === "context") {
      if (lightPool.some((r) => r.isActive())) return;
      j.phase = "images";
    }
    if (j.phase === "ctx-next") {
      const need = jobIds(j.run).filter((id) => !hasCtx(j.run, id) && !hasImg(j.run, id));
      if (!need.length) j.phase = "images";
      else { const r = startPhaseWorkers(j, "ctx", need); if (!r.ok) return finishJob("failed", r.error); j.phase = "context"; jobLog(j, "Ngữ cảnh: " + need.length + " mục chia " + r.workers + " luồng"); return; }
    }
    if (j.phase === "images") {
      // reviews and finish follow the images live
      pumpReviews(j, false); pumpFinish(j).catch(() => {});
      if (agentRunner.isActive()) return;
      const ids = jobIds(j.run), have = ids.filter((id) => hasImg(j.run, id)).length;
      const missing = ids.filter((id) => !hasImg(j.run, id) && !hasGaveUp(j.run, id)).length;
      if (j.launches > 0) {
        // the image agent has exited: stopped, a real error, or "done": done with images still missing means it quit early (e.g. after one group) -> run it again for the rest
        const st = agentRunner.status();
        if (st.status === "stopped") return finishJob("stopped");
        // "0/N mục hoàn tất: không có ảnh nào được tạo" is the agent giving up WITHOUT a real error (e.g. it believed the list was empty): relaunch it like an early exit
        if (st.status === "failed" && !/^\d+\/\d+ mục hoàn tất/.test(String(st.error || ""))) { j.imageError = st.error || "Lượt tạo ảnh lỗi"; j.imagesDone = true; }
        else {
          j.noProgress = have > j.lastHave ? 0 : j.noProgress + 1;
          if (!missing) j.imagesDone = true;
          else if (j.noProgress >= 2 || j.launches >= 6) { j.imageIssue = missing + " mục chưa có ảnh (đã chạy lại " + (j.launches - 1) + " lần)"; j.imagesDone = true; }
        }
      } else if (!missing) j.imagesDone = true;
      if (!j.imagesDone) {
        const r = agentRunner.start({ run: j.run, mode: "flow", phased: j.n > 1 ? true : "review" });
        if (!r.ok) return finishJob("failed", r.error);
        j.launches++; j.lastHave = have;
        jobLog(j, j.launches === 1 ? "Tạo ảnh" : "Tạo ảnh: còn " + missing + " mục, chạy tiếp (lần " + j.launches + ")");
        return;
      }
      j.phase = "drain";
    }
    if (j.phase === "drain") {
      pumpReviews(j, true); pumpFinish(j).catch(() => {});
      if (j.active > 0 || j.finBusy || j.workerBatch || lightPool.some((r) => r.isActive())) return;
      const ids = jobIds(j.run), done = new Set(doneRows(j.run));
      const reviewsLeft = ids.filter((id) => hasImg(j.run, id) && !hasRev(j.run, id) && (j.revTries[id] || 0) < 2).length;
      const finishLeft = ids.filter((id) => hasImg(j.run, id) && hasRev(j.run, id) && !done.has(id) && !j.finTried.has(id)).length;
      if (reviewsLeft || finishLeft) return;
      const gaveUp = ids.filter((id) => hasGaveUp(j.run, id)).length;
      const open = ids.filter((id) => !hasGaveUp(j.run, id) && !(hasImg(j.run, id) && hasRev(j.run, id) && done.has(id))).length;
      if (j.fatal) return finishJob("failed", j.fatal);
      if (j.imageError) return finishJob("failed", j.imageError);
      if (j.imageIssue) return finishJob("failed", j.imageIssue);
      const uploadPending = ids.filter((id) => !hasGaveUp(j.run, id) && hasImg(j.run, id) && hasRev(j.run, id) && !done.has(id)).length;
      if (open && open === uploadPending) return finishJob("done", "Xong, nhưng " + uploadPending + " mục chưa tải lên kho: bấm Chạy tiếp");
      if (open) return finishJob("failed", open + " mục chưa hoàn tất (xem log)");
      return finishJob("done", gaveUp ? gaveUp + " mục không tạo được ảnh (bị từ chối hoặc lỗi)" : "");
    }
  } finally { j.busy = false; }
}
// Everything of the run is there on disk (every item: image, review, result row): the run is done, whatever an older failure in the state file says (e.g. after a restart).
function runComplete(run) {
  const ids = jobIds(run); if (!ids.length) return false;
  const rows = new Set(doneRows(run));
  return ids.every((id) => hasImg(run, id) && hasRev(run, id) && rows.has(id));
}
function reconcile(base) {
  if (!base || base.active || base.mode !== "flow" || !base.run_id || (base.status !== "failed" && base.status !== "stopped")) return base;
  if (!runComplete(base.run_id)) return base;
  try { agentRunner.setFinal(base.run_id, { status: "done", error: "" }); } catch {}
  return { ...base, status: "done", error: "", quota_reset: "", quota_raw: "" };
}
function jobStatus() {
  const j = imgJob, base0 = agentRunner.status(), base = j ? base0 : reconcile(base0);
  if (!j) return jobFinal && base.run_id === jobFinal.run_id ? { ...base, status: jobFinal.status, error: jobFinal.error || base.error, active: false, tail: jobFinal.tail || base.tail } : base;
  const workers = lightPool.map((r) => r.status()).filter((x) => x.active), imagesNow = j.phase === "images" && base.run_id === j.run;
  const tail = [...j.lines.slice(-4), ...(imagesNow ? base.tail || [] : workers.flatMap((x) => (x.tail || []).slice(-8)))].slice(-30);
  const el = Math.round((Date.now() - j.started) / 1000);
  return { active: true, status: "running", run_id: j.run, mode: "flow", project: "", started: new Date(j.started).toISOString(), elapsed_s: el, model_in_use: imagesNow ? base.model_in_use || "" : "", agent: j.agent, label_ai: j.label_ai, last_text: imagesNow ? base.last_text || j.text : j.text, turns: imagesNow ? base.turns || 0 : 0, error: "", updated: new Date().toISOString(), tail, phase: j.phase };
}
// `agent` = the main runner as every route knows it, made job-aware (an image job counts as an active agent run, Dừng stops the whole job).
const agent = {
  isActive: () => agentRunner.isActive() || jobActive(),
  status: () => jobStatus(),
  start: (o) => agentRunner.start(o),
  stop: () => {
    if (imgJob) { imgJob.stopped = true; for (const r of lightPool) if (r.isActive()) r.stop(); if (agentRunner.isActive()) agentRunner.stop(); return { ok: true, status: 200, run_id: imgJob.run }; }
    return agentRunner.stop();
  },
  shutdown: () => { try { agentRunner.shutdown(); } catch {} },
};

// Starts the light shards of one action. urls = the products of the run in order (queue / prep): split into contiguous disjoint parts, one shard file
// (JSON array of links) each, handed to the agent as "shard file:" (queue-todo / prep-todo -OnlyFile), so no two shards ever hold the same product.
// urls = null (index): the shards split the library photos by a stable hash (-Shard k/n). threads 1 = exactly the old single run.
function startLightShards({ mode, project, options, threads = 1, urls = null, tag = "" }) {
  let n = clampThreads(threads);
  if (urls && !urls.length) return { ok: false, status: 409, error: "Không còn sản phẩm nào để xử lý (đã thêm, đã chuẩn bị hoặc không khớp bộ lọc)." };
  if (urls) n = Math.min(n, urls.length);
  const stamp = newRunId().slice(6);
  if (n <= 1 || lightPool.some((r) => r.isActive())) return lightPool[0].start({ run: (tag || mode) + "-" + stamp, mode, project, options });
  const chunk = urls ? Math.ceil(urls.length / n) : 0, started = [];
  for (let k = 1; k <= n; k++) {
    let opt = options + "; shard: " + k + "/" + n;
    if (urls) {
      const part = urls.slice((k - 1) * chunk, k * chunk);
      if (!part.length) continue;
      const file = join(workspace, "tmp", "shard-" + stamp + "-" + k + ".json"); shardFiles.push(file);
      try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(part)); } catch (e) { for (const r of started) r.stop(); return { ok: false, status: 500, error: e.message }; }
      opt = opt.replace(/(products to (?:queue|prepare): )[^;]+/, "$1" + part.length) + "; shard file: " + file;
    }
    const runner = lightPool[k - 1], r = runner.start({ run: (tag || mode) + "-" + stamp + "-s" + k, mode, project, options: opt, shard: k + "/" + n });
    if (!r.ok) { for (const x of started) x.stop(); return r; }
    started.push(runner); if (!started.first) started.first = r;
  }
  return started.first || { ok: false, status: 409, error: "Không còn sản phẩm nào để xử lý." };
}
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
  run.proc = proc; run.startedAt = Date.now();
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

// ----- Thêm vào hàng chờ order (ONE per session): the products still missing after the prepared stock are never dropped. While a prep run is
// active the order pulls the new prepared rows (each time prepared.csv changes, at least every 15 s); when the light runner is free it starts the
// Claude queue run for exactly the remaining count. Dừng cancels it.
let queueOrder = null, queueOrderTimer = null;
const urlKey = (u) => { try { const x = new URL(String(u).trim()); return x.protocol + "//" + x.host.toLowerCase() + x.pathname.replace(/\/+$/, "") + x.search; } catch { return String(u).trim(); } };
// links of project id in THIS session's queue (urls.txt)
function queuedCountOf(id) {
  const inQueue = new Set();
  try { for (const l of readFileSync(join(workspace, "urls.txt"), "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) { const t = l.trim(); if (t && !t.startsWith("#")) inQueue.add(urlKey(t)); } } catch {}
  let n = 0;
  try { const lines = readFileSync(join(sharedWs, "projects", id, "products.csv"), "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim()).slice(1); for (const l of lines) if (inQueue.has(urlKey(csvCells(l)[0]))) n++; } catch {}
  return n;
}
async function productsLeft(id, scenes, filters) {
  const a = await runScan(["queue-todo", "-Project", id, "-Limit", "1", ...filters], 60000);
  if (a.ok && a.count > 0) return true;
  const b = await runScan(["queue-todo", "-Project", id, "-TopUp", "-SceneCount", String(scenes), "-Limit", "1", ...filters], 60000);
  return !!(b.ok && b.count > 0);
}
function orderAdded() { return queueOrder ? Math.max(0, queuedCountOf(queueOrder.project) - queueOrder.base) : 0; }
const queueAiName = () => { try { return readAgentSettings(workspace, sharedWs, "queue").backend === "antigravity" ? "Antigravity" : "Claude"; } catch { return "Claude"; } };
function orderStatus() {
  if (!queueOrder) return { active: false };
  const added = orderAdded(), o2 = queueOrder;
  return { active: o2.active, project: o2.project, total: o2.total, added, from_prepared: o2.fromPrepared, claude_choosing: o2.active && o2.state === "claude" ? Math.max(0, o2.total - added) : 0,
    waiting: o2.active && o2.state === "waiting", state: o2.state, message: o2.message, line: orderLine() };
}
function orderLine() {
  if (!queueOrder) return "";
  const added = orderAdded(), o2 = queueOrder, rest = Math.max(0, o2.total - added);
  return "Hàng chờ: đã thêm " + added + "/" + o2.total + " (" + o2.fromPrepared + " từ kho chuẩn bị" + (o2.state === "claude" ? ", " + rest + " " + queueAiName() + " đang chọn thêm" : o2.state === "waiting" ? ", " + rest + " đợi lượt Chuẩn bị trước thêm vào kho" : "") + ")";
}
function finishOrder(state, message = "") {
  if (!queueOrder) return;
  queueOrder.state = state; queueOrder.active = false; queueOrder.message = message || (state === "done" ? "Đã thêm đủ." : "");
  if (queueOrderTimer) { clearInterval(queueOrderTimer); queueOrderTimer = null; }
}
async function startOrderClaude(need) {
  const o2 = queueOrder;
  const options = `category: ${o2.category ? `"${o2.category}"` : "(all categories)"}; only unused (used = F): ${o2.unused_only ? "T" : "F"}; products to queue: ${need}; scenes per product: ${o2.scenes}`;
  // Luồng N: the first `need` products to handle (top-ups of ready rows first, then new products, table order) are split between the shards.
  let urls = null;
  if (o2.threads > 1) {
    const top = await runScan(["queue-todo", "-Project", o2.project, "-TopUp", "-SceneCount", String(o2.scenes), "-Limit", String(need), ...o2.filters], 90000);
    const fresh = await runScan(["queue-todo", "-Project", o2.project, "-Limit", String(need), ...o2.filters], 90000);
    const list = [...(top.ok ? top.products || [] : []), ...(fresh.ok ? fresh.products || [] : [])].map((x) => x.url);
    urls = [...new Set(list)].slice(0, need);
  }
  const r = startLightShards({ mode: "queue", project: o2.project, options, threads: o2.threads, urls });
  if (r.ok) { o2.state = "claude"; o2.claudeNeed = need; }
  return r;
}
async function orderTick() {
  const o2 = queueOrder;
  if (!o2 || !o2.active || o2.busy) return;
  o2.busy = true;
  try {
    if (orderAdded() >= o2.total) return finishOrder("done");
    if (o2.state === "waiting") {
      // a prep run is adding rows: take them as they come
      let mtime = 0; try { mtime = statSync(join(sharedWs, "projects", o2.project, "prepared.csv")).mtimeMs; } catch {}
      if (mtime !== o2.lastMtime || Date.now() - o2.lastPull > 15000) {
        o2.lastMtime = mtime; o2.lastPull = Date.now();
        const rest = o2.total - orderAdded();
        const r = await runScan(["queue-from-prepared", "-Project", o2.project, "-Limit", String(rest), "-SceneCount", String(o2.scenes), ...o2.filters]);
        if (r.ok) o2.fromPrepared += Number(r.queued) || 0;
      }
      if (orderAdded() >= o2.total) return finishOrder("done");
      if (!light.isActive()) {
        // the prep run ended: whatever is still missing goes to Claude now (or the order ends when nothing is left to queue)
        const rest = o2.total - orderAdded();
        if (!(await productsLeft(o2.project, o2.scenes, o2.filters))) return finishOrder("done", "Không còn sản phẩm nào để thêm: đã thêm " + orderAdded() + "/" + o2.total + ".");
        const r = await startOrderClaude(rest);
        if (!r.ok) return finishOrder("stopped", r.error || "Chưa chạy được " + queueAiName() + ".");
      }
    } else if (o2.state === "claude" && !light.isActive()) {
      return finishOrder(orderAdded() >= o2.total ? "done" : "stopped", orderAdded() >= o2.total ? "" : "Lượt " + queueAiName() + " kết thúc khi còn thiếu " + (o2.total - orderAdded()) + " sản phẩm.");
    }
  } finally { o2.busy = false; }
}

// ----- Progress of a run, counted from FACTS ON DISK (never from the model's text): { done, total, label }. total 0 = unknown (the bar moves, the label counts). -----
const clock = (sec) => String(Math.floor(sec / 60)).padStart(2, "0") + ":" + String(sec % 60).padStart(2, "0");
const rj = (f) => { try { return readJsonFile(f); } catch { return {}; } };
const stampMs = (t) => { const x = Date.parse(String(t || "")); return Number.isFinite(x) ? x : 0; };
const eta = (st, done, total) => { const el = st.elapsed_s || 0; if (done < 3 || total <= done || el < 30) return ""; const min = Math.max(1, Math.round(((total - done) * (el / done)) / 60)); return " · còn ~" + min + " phút"; };
let prepMeta = null, indexMeta = null, shardFiles = [];
function productRows(id) {
  const out = [];
  try {
    const lines = readFileSync(join(sharedWs, "projects", id, "products.csv"), "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
    const head = csvCells(lines[0]), at = head.indexOf("reviews_checked_at");
    for (const l of lines.slice(1)) { const c = csvCells(l); out.push({ url: c[0], checked: at >= 0 ? c[at] : "" }); }
  } catch {}
  return out;
}
function progressOf(st) {
  if (!st || !st.mode || !st.run_id) return null;
  const t = clock(st.elapsed_s || 0), shards = st.shards > 1 ? " · " + st.shards + " luồng" : "", started = stampMs(st.started);
  try {
    if (st.mode === "flow") {
      const dir = join(workspace, "output", st.run_id), j = rj(join(dir, "agent-items.json"));
      const ids = (Array.isArray(j) ? j : j.items || []).map((x) => x && x.id).filter(Boolean), n = ids.length;
      if (!n) return { done: 0, total: 0, label: "" };
      const has = (f) => existsSync(f);
      const img = ids.filter((id) => has(join(dir, "images", id + ".png"))).length;
      const ctxN = ids.filter((id) => has(join(dir, "logs", id + "-context.json"))).length;
      const rev = ids.filter((id) => has(join(dir, "logs", id + "-review.txt")) || has(join(dir, "logs", id + "-agent-review.json"))).length;
      const res = rj(join(dir, "results.json")), rows = Array.isArray(res) ? res : [];
      const fin = ids.filter((id) => rows.some((r) => String(r.photo_path || "").replace(/\\/g, "/").split("/").pop().replace(/\.[^.]+$/, "") === id)).length;
      const cur = ids.find((id) => !has(join(dir, "images", id + ".png"))) || ids.find((id) => !has(join(dir, "logs", id + "-review.txt")) && !has(join(dir, "logs", id + "-agent-review.json")));
      const curText = cur && st.active ? " · Mục " + (String(cur).match(/^\d+/) || [cur])[0] : "";
      return { nums: { img, rev, fin, n, ctx: ctxN }, done: ctxN + img + rev, total: 3 * n, label: "Ngữ cảnh " + ctxN + "/" + n + " · Ảnh " + img + "/" + n + " · Review" + (reviewAiOf() !== "auto" ? " (" + REVIEW_AI_NAME[reviewAiOf()] + ")" : "") + " " + rev + "/" + n + " · Hoàn tất " + fin + "/" + n + " · " + t + curText + eta(st, fin, n) };
    }
    if (st.mode === "scan") {
      const sc = scanOfRun(st.run_id);
      if (!sc) return { done: 0, total: 0, label: "" };
      let total = 0;
      try { const mf = join(sc.dir, "menu.json"); if (statSync(mf).mtimeMs >= started - 3000) { const m = rj(mf); total = Array.isArray(m) ? m.length : 0; } } catch {}
      const session = rj(join(sc.dir, "session.json")), done = Object.keys(session.added || {}).length;
      return { nums: { done, total, found: sc.added || 0 }, done, total, label: total ? "Danh mục " + Math.min(done, total) + "/" + total + " · " + (sc.added || 0) + " sản phẩm · " + t + eta(st, done, total) : "Đang đọc menu · " + t };
    }
    if (st.mode === "reviews") {
      const rows = productRows(st.project), total = rows.length, done = rows.filter((r) => stampMs(r.checked) >= started - 1000).length;
      return { nums: { done, total }, done, total, label: "Đã kiểm tra " + done + "/" + total + " link · " + t + eta(st, done, total) };
    }
    if (st.mode === "queue" && queueOrder && queueOrder.project === st.project) {
      const done = orderAdded();
      return { nums: { done, total: queueOrder.total }, done, total: queueOrder.total, label: "Hàng chờ: đã thêm " + done + "/" + queueOrder.total + shards + " · " + t + eta(st, done, queueOrder.total) };
    }
    if (st.mode === "prep" && prepMeta && prepMeta.project === st.project) {
      let done = 0;
      try { const lines = readFileSync(join(sharedWs, "projects", st.project, "prepared.csv"), "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim()); const head = csvCells(lines[0]), at = head.indexOf("prepared_at"); for (const l of lines.slice(1)) if (at >= 0 && stampMs(csvCells(l)[at]) >= prepMeta.startedMs - 1000) done++; } catch {}
      return { nums: { done, total: prepMeta.total }, done, total: prepMeta.total, label: "Chuẩn bị trước: " + done + (prepMeta.total ? "/" + prepMeta.total : " sản phẩm") + shards + " · " + t + (prepMeta.total ? eta(st, done, prepMeta.total) : "") };
    }
    if (st.mode === "index" && indexMeta) {
      let n = 0; try { n = Object.keys(rj(join(sharedWs, "source-photos", "scene-index.json"))).length; } catch {}
      const done = Math.max(0, n - indexMeta.base);
      return { nums: { done }, done, total: 0, label: "Gắn nhãn kho ảnh: +" + done + " ảnh" + shards + " · " + t };
    }
  } catch {}
  return null;
}
// The ONE result line of a finished run (any run type): { level: ok | warn | error, text, name, key }. Numbers come from the same facts on disk as the progress.
// ----- a human label for every run, from facts on disk: 'forteraapparel.com · 25/11 15:17 · 20 link / 40 mục' (+ the window when it is not the default) -----
const hostOf = (u) => { try { return new URL(String(u).trim()).hostname.replace(/^www\./, ""); } catch { return ""; } };
const pad2 = (n) => String(n).padStart(2, "0");
const dmHm = (d) => pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
function startOfRun(name, dir) {
  const a = name.match(/^agent-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/), b = name.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})h(\d{2})m(\d{2})s/);
  const m = a || b;
  if (m) { const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]); if (!Number.isNaN(d.getTime())) return d; }
  try { const t = rj(join(dir, "agent-run.json")).started; if (t && !Number.isNaN(Date.parse(t))) return new Date(t); } catch {}
  try { return statSync(dir).birthtime; } catch { return null; }
}
function runInfo(name) {
  const dir = runDirOf(name), info = { id: name, label: name, where: "", host: "", links: 0, items: 0, handles: [], day: "", started: "" };
  const j = rj(join(dir, "agent-items.json")), items = (Array.isArray(j) ? j : j.items || []).filter((x) => x && x.id);
  const urls = items.map((x) => x.url).filter(Boolean), counts = {};
  for (const u of urls) { const h = hostOf(u); if (h) counts[h] = (counts[h] || 0) + 1; }
  const hosts = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  info.host = hosts[0] ? hosts[0] + (hosts.length > 1 ? " +" + (hosts.length - 1) + " site khác" : "") : "";
  info.links = new Set(urls).size; info.items = items.length;
  info.handles = [...new Set(items.map((x) => x.handle || String(x.url || "").split("/").filter(Boolean).pop()).filter(Boolean))].slice(0, 3);
  const d = startOfRun(name, dir);
  if (d) { info.started = d.toISOString(); info.day = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  const sess = session && self && self.stt ? "Phiên #" + self.stt : "";
  const parts = [info.host || name, d ? dmHm(d) : "", info.items ? info.links + " link / " + info.items + " mục" : "", sess].filter(Boolean);
  info.label = info.host || d ? parts.join(" · ") : name;
  info.where = [info.host, info.links ? info.links + " link" : ""].filter(Boolean).join(" · ");
  return info;
}
// where a run happens, for the result line and the status: the site (image run, scan) or the project, plus the link count
function runWhere(st) {
  try {
    if (st.mode === "flow" && st.run_id) return runInfo(st.run_id).where;
    if (st.mode === "scan") { const sc = scanOfRun(st.run_id); return sc ? (hostOf(sc.site) || sc.project) : ""; }
    if (st.project) return projectNameOf(st.project);
  } catch {}
  return "";
}
const humanError = (e) => String(e || "").replace(/\[CAUSE:[A-Z_]+\]\s*/g, "").replace(/\s+/g, " ").trim();
function resultOf(st) {
  if (!st || !st.status || st.status === "idle" || st.status === "running" || st.active) return null;
  const pr = progressOf(st), nm = (pr && pr.nums) || {}, sec = st.elapsed_s || 0;
  const dur = sec < 90 ? Math.max(1, sec) + " giây" : Math.round(sec / 60) + " phút";
  let level = st.status === "done" ? "ok" : st.status === "stopped" ? "warn" : "error", body = "";
  switch (st.mode) {
    case "flow": body = nm.n ? (level === "ok" ? nm.img + "/" + nm.n + " ảnh · " + nm.rev + " review" : "ảnh " + nm.img + "/" + nm.n + " · review " + nm.rev + "/" + nm.n) : ""; if (level === "ok" && nm.n && nm.img < nm.n) level = "warn"; break;
    case "scan": body = nm.total !== undefined ? (level === "ok" ? "Quét: " + nm.found + " sản phẩm / " + nm.done + " danh mục" : "Quét " + nm.done + "/" + nm.total + " danh mục") : ""; break;
    case "reviews": body = nm.total !== undefined ? (level === "ok" ? "Review: " + nm.done + " link đã kiểm tra" : "Review " + nm.done + "/" + nm.total) : ""; break;
    case "queue": body = nm.total !== undefined ? "Thêm vào hàng chờ " + nm.done + "/" + nm.total : "Thêm vào hàng chờ"; if (level === "ok" && nm.total && nm.done < nm.total) level = "warn"; break;
    case "prep": body = nm.done !== undefined ? "Chuẩn bị " + nm.done + (nm.total && level !== "ok" ? "/" + nm.total : "") + " sản phẩm" : "Chuẩn bị trước"; break;
    case "index": body = nm.done !== undefined ? "Gắn nhãn +" + nm.done + " ảnh" : "Gắn nhãn kho ảnh"; break;
    default: body = "";
  }
  if (st.status === "done" && /chưa tải lên kho/.test(String(st.error || ""))) return { level: "warn", text: humanError(st.error), where: runWhere(st), name: FEATURE[st.mode] || st.mode, key: st.run_id + "|" + (st.updated || st.started || "") };
  let text;
  if (st.status === "failed") {
    const err = humanError(st.error);
    const cause = /CAUSE:QUOTA/.test(st.error || "") ? "Antigravity báo model quá tải" + (st.quota_reset ? ", thử lại lúc " + new Date(st.quota_reset).toTimeString().slice(0, 5) : "") : err.slice(0, 140) || "không rõ nguyên nhân";
    text = "Lỗi · " + cause + (body ? " · " + body : "");
  } else if (level === "warn" && st.status === "stopped") text = "Đã dừng" + (body ? " · " + body : "");
  else text = (level === "warn" ? "Xong một phần · " : "Xong · ") + (body ? body + " · " : "") + dur;
  return { level, text, where: runWhere(st), name: FEATURE[st.mode] || st.mode, key: st.run_id + "|" + (st.updated || st.started || "") };
}
const withProgress = (st) => ({ ...st, progress: progressOf(st), where: st.active ? runWhere(st) : "" });
// The shard files of a sharded run are removed when no light run is active any more (only the ones this server wrote).
function cleanShardFiles() { if (!shardFiles.length || light.isActive()) return; for (const f of shardFiles.splice(0)) { try { rmSync(f, { force: true }); } catch {} } }

// Runs src/scan.ps1 in this session (PR_WORKSPACE) and returns its one JSON line.
// What the person reads when a command gives no result: the reason in Vietnamese (timeout / the last stderr line), never the raw command line.
const cliFailure = (err, stderr, timeout, what) => {
  if (err && (err.killed || err.signal || /timed? ?out|ETIMEDOUT/i.test(err.code || ""))) return "Quá thời gian: " + what + " chạy quá " + Math.round(timeout / 1000) + " giây. Thử lại sau, hoặc chạy ít sản phẩm hơn.";
  const line = String(stderr || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  return line ? what + " báo lỗi: " + line.slice(0, 240) : what + " không trả về kết quả.";
};
function runScan(args, timeout = 180000) {
  return new Promise((resolveScan) => execFile(PWSH, psFile(join(root, "src", "scan.ps1"), args), { cwd: root, env: toolEnv, timeout, windowsHide: true, encoding: "utf8" }, (err, out, stderr) => {
    let r = null; try { r = JSON.parse(String(out || "").trim().split(String.fromCharCode(10)).pop()); } catch { /* below */ }
    resolveScan(r || { ok: false, error: cliFailure(err, stderr, timeout, "Lệnh quét / hàng chờ (scan.ps1 " + String(args[0] || "") + ")") });
  }));
}
const projectArgs = (given) => [...(String(given.category || "").trim() ? ["-Collection", String(given.category).trim()] : []), ...(given.unused_only ? ["-UnusedOnly"] : [])];

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  if (path === "/api/root") return send(res, 200, { root, service: "product-review", protocol: 1, pid: process.pid, session, stt: self?.stt || 0 });
  // Sessions: this window (number, session, Chrome profile, next Chrome tab group) and the other open windows.
  if (path === "/api/session" && req.method === "GET") return send(res, 200, sessionInfo());
  if (path === "/api/sessions" && req.method === "GET") return send(res, 200, { current: session, sessions: sessionRows(await liveSessions()) });
  if (path === "/api/sessions/open" && req.method === "POST") {
    const b = JSON.parse((await body(req)).toString("utf8") || "{}");
    const name = String(b.name ?? "").trim().toLowerCase();
    if (name && !SESSION_RE.test(name)) return send(res, 400, { error: "Tên phiên chỉ gồm chữ thường, số và dấu gạch ngang (tối đa 30 ký tự)." });
    // A window opened for a project is named after it; a project another live session uses is refused (nothing is opened).
    const project = String(b.project || "").trim().toLowerCase();
    if (project) {
      if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(project) || !existsSync(join(sharedWs, "projects", project, "project.json"))) return send(res, 400, { error: "Chọn một dự án có sẵn." });
      const busy = projectBusyBy(root, project, project);
      if (busy) return send(res, 409, { error: "Dự án " + project + " đang được phiên \"" + sessionLabel(busy.session) + "\" dùng. Chọn dự án khác hoặc đóng phiên đó trước." });
      touchRecent(project);
      return send(res, 200, openSessionWindow(project, project));
    }
    return send(res, 200, openSessionWindow(name));
  }
  if (path === "/api/project/counts" && req.method === "GET") { const id = String(url.searchParams.get("project") || ""); return send(res, projectExists(id) ? 200 : 400, projectExists(id) ? { project: id, ...projectCounts(id) } : { error: "Chọn một dự án có sẵn." }); }
  if (path === "/api/sessions/projects" && req.method === "GET") return send(res, 200, { projects: projectChoices(await liveSessions()) });
  // The project selected in this window's Dự án popup is the one this window uses: another live session cannot take it.
  if (path === "/api/session/project" && req.method === "POST") {
    const b = JSON.parse((await body(req)).toString("utf8") || "{}");
    let project = String(b.project || "").trim().toLowerCase();
    if (agent.isActive() || light.isActive()) return send(res, 409, { error: "Đang có một lượt chạy trong cửa sổ này: chờ xong hoặc bấm Dừng rồi đổi dự án." });
    if (lockedProject && project !== lockedProject) return send(res, 409, { error: "Cửa sổ này dành riêng cho dự án " + lockedProject + ". Mở cửa sổ khác từ Các phiên để làm dự án khác." });
    if (project && !projectExists(project)) return send(res, 400, { error: "Chọn một dự án có sẵn." });
    // one atomic step under the registry lock: the old focus is released and the new one taken, or nothing changes
    const claimed = claimProjectFocus(root, session, process.pid, project);
    if (!claimed.ok) return send(res, 409, { error: claimed.notRegistered ? "Cửa sổ chưa đăng ký xong, thử lại sau vài giây." : "Dự án " + project + " đang được phiên \"" + sessionLabel(claimed.holder) + "\" dùng. Chọn dự án khác hoặc đóng phiên đó trước." });
    if (project) touchRecent(project);
    return send(res, 200, { ok: true, project, name: project ? projectNameOf(project) : "", title: sessionInfo().title });
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
    // PER SESSION (each window has its own pickers, Luồng and Flow account): this session's workspace/config/run-settings.json, created from the default
    // session's file the first time. Written under a lock through a temp file + rename.
    const file = join(workspace, "config", "run-settings.json"), seedFile = join(sharedWs, "config", "run-settings.json");
    if (req.method === "GET") {
      const s2 = readSeededJson(file, seedFile, {});
      if (s2.imageBackend && !["codex", "agent"].includes(s2.imageBackend)) s2.imageBackend = "codex";
      if (!["auto", "codex", "claude", "antigravity"].includes(s2.reviewAi)) s2.reviewAi = s2.imageBackend === "agent" ? "auto" : ["codex", "antigravity", "claude"].includes(s2.textBackend) ? s2.textBackend : "auto"; // who writes the reviews: auto = the image agent (agent runs) / Codex
      if (s2.textBackend && !["codex", "antigravity", "claude"].includes(s2.textBackend)) s2.textBackend = "codex";
      delete s2.runMode;
      if (!isClaudeModel(s2.claudeModel)) s2.claudeModel = CLAUDE_DEFAULT_MODEL;
      s2.claudeModelGroups = CLAUDE_MODEL_GROUPS;
      if (!AGENT_BACKENDS.includes(s2.agentBackend)) s2.agentBackend = "claude";
      for (const k of ["scanAgent", "reviewsAgent", "queueAgent"]) if (!AGENT_BACKENDS.includes(s2[k])) s2[k] = s2.agentBackend; // older windows: the old single agent
      if (s2.agyModel && !isAgyModel(s2.agyModel)) delete s2.agyModel;
      if (s2.agyImages !== "flow") s2.agyImages = "self";
      s2.threadsSaved = Number.isInteger(s2.threads) && s2.threads >= 1 && s2.threads <= 4;
      if (!s2.threadsSaved) s2.threads = 1;
      s2.codexThreads = s2.threadsSaved ? s2.threads : 2; // the Codex run always started 2 links at once until the person chose otherwise
      if (s2.agyEffort && !AGY_EFFORTS.includes(s2.agyEffort)) delete s2.agyEffort; // e.g. the old "max"
      s2.agyModelGroups = await listAgyModels();
      s2.flowAccounts = flowAccountsFor(readFlowBrowser(workspace, sharedWs));
      return send(res, 200, s2);
    }
    if (req.method === "POST") {
      const given = JSON.parse((await body(req)).toString("utf8") || "{}");
      readSeededJson(file, seedFile, {}); // make sure the seeded copy exists before the update
      const saved = updateJsonLocked(file, (cur) => {
        if (Number.isInteger(given.threads) && given.threads >= 1 && given.threads <= 4) cur.threads = given.threads;
        if (["codex", "antigravity", "claude"].includes(given.textBackend)) cur.textBackend = given.textBackend;
        if (["auto", "codex", "claude", "antigravity"].includes(given.reviewAi)) { cur.reviewAi = given.reviewAi; if (given.reviewAi !== "auto") cur.textBackend = given.reviewAi; }
        if (["codex", "agent"].includes(given.imageBackend)) cur.imageBackend = given.imageBackend;
        if (typeof given.claudeModel === "string") { if (!given.claudeModel) delete cur.claudeModel; else if (isClaudeModel(given.claudeModel)) cur.claudeModel = given.claudeModel; }
        if (typeof given.claudeEffort === "string") { if (!given.claudeEffort) delete cur.claudeEffort; else if (CLAUDE_EFFORTS.includes(given.claudeEffort)) cur.claudeEffort = given.claudeEffort; }
        if (AGENT_BACKENDS.includes(given.agentBackend)) cur.agentBackend = given.agentBackend;
        for (const k of ["scanAgent", "reviewsAgent", "queueAgent"]) if (AGENT_BACKENDS.includes(given[k])) cur[k] = given[k];
        if (typeof given.agyModel === "string") { if (!given.agyModel) delete cur.agyModel; else if (isAgyModel(given.agyModel)) cur.agyModel = given.agyModel; }
        if (given.agyImages === "self" || given.agyImages === "flow") cur.agyImages = given.agyImages;
        if (typeof given.agyEffort === "string") { if (!given.agyEffort) delete cur.agyEffort; else if (AGY_EFFORTS.includes(given.agyEffort)) cur.agyEffort = given.agyEffort; }
        if (typeof given.flowAccount === "string") { const v = given.flowAccount.trim(); if (!v) delete cur.flowAccount; else if (v.length <= 120 && /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/.test(v)) cur.flowAccount = v; }
        // the two separate pairs of the Dự án popup: Thêm vào hàng chờ (count 1-200, scenes 1-4) and Chuẩn bị trước (count 0-500, 0 = all; scenes 1-4)
        const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
        for (const [k, lo, hi] of [["queueCount", 1, 200], ["queueScenes", 1, 4], ["prepCount", 0, 500], ["prepScenes", 1, 4], ["projectThreads", 1, 4], ["scanThreads", 1, 4], ["scanMax", 1, 200]]) { const v = int(given[k], lo, hi); if (v !== undefined) cur[k] = v; }
        if (typeof given.prepRetrySkipped === "boolean") cur.prepRetrySkipped = given.prepRetrySkipped;
        // what the person picked in the Dự án / Quét web popups, per window: the project, its category, "Chỉ chưa dùng", the scan link / max / project
        if (typeof given.unusedOnly === "boolean") cur.unusedOnly = given.unusedOnly;
        if (typeof given.lastProject === "string" && (given.lastProject === "" || /^[a-z0-9][a-z0-9-]{1,60}$/.test(given.lastProject))) cur.lastProject = given.lastProject;
        if (typeof given.lastCategory === "string" && given.lastCategory.length <= 120) cur.lastCategory = given.lastCategory.replace(/[\r\n]+/g, " ");
        if (typeof given.scanSite === "string" && given.scanSite.length <= 300) cur.scanSite = given.scanSite.replace(/[\r\n]+/g, "").trim();
        if (typeof given.scanProject === "string" && (given.scanProject === "" || /^[a-z0-9][a-z0-9-]{1,60}$/.test(given.scanProject))) cur.scanProject = given.scanProject;
        delete cur.runMode;
        return cur;
      }, {});
      return send(res, 200, saved);
    }
  }

  if (path === "/api/stop" && req.method === "POST") { stopRun(); return send(res, 200, { ok: true }); }
  // Agent mode: prompt (filled), start, status (short sanitized progress), stop.
  if (path === "/api/agent/prompt" && req.method === "GET") {
    try { const runId = url.searchParams.get("run") || newRunId(); return send(res, 200, { run: runId, prompt: buildPrompt({ toolRoot: root, run: runId, workspace }) }); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (path === "/api/agent/run" && req.method === "POST") {
    if (run.proc) return send(res, 409, { error: "Đang chạy." });
    const given = JSON.parse((await body(req)).toString("utf8") || "{}");
    if (agent.isActive()) return send(res, 409, { error: "Đã có một lượt AI đang chạy." });
    // Antigravity makes the images itself: no Flow, no Chrome, so no Flow sign-in check.
    const agentNow = readAgentSettings(workspace, sharedWs), login = (agentNow.backend === "antigravity" && agentNow.agyImages !== "flow") || readFlowBrowser(workspace, sharedWs).mode !== "own" ? { state: "logged_in" } : await flowLogin.status();
    if (login.state !== "logged_in") return send(res, 409, { error: login.state === "logged_out" ? "Chưa đăng nhập Google Flow trong Chrome riêng: bấm Mở Chrome để đăng nhập, đăng nhập xong đóng cửa sổ đó rồi Kiểm tra lại." : "Chưa chạy được " + (agentNow.backend === "antigravity" ? "Antigravity" : "Claude") + ": " + login.detail });
    // given.run (Chạy tiếp): only an existing Claude run of this window (its folder is used as is).
    if (given.run && (!/^agent-[0-9a-z-]{6,60}$/i.test(String(given.run)) || !existsSync(join(workspace, "output", String(given.run), "agent-items.json")))) return send(res, 400, { error: "Không tìm thấy lượt để chạy tiếp." });
    // Luồng above 1 (and nothing else on the light runners): the no-browser steps run N at a time in phases; the profile / account preflight is done HERE, before any worker.
    const nowAgent = readAgentSettings(workspace, sharedWs), usesBrowser = nowAgent.backend === "claude" || nowAgent.agyImages === "flow", nThreads = savedThreads();
    const reviewAiNow = reviewAiOf();
    if ((nThreads > 1 || reviewAiNow !== "auto") && !light.isActive()) {
      const bc = readFlowBrowser(workspace, sharedWs);
      if (usesBrowser && bc.mode !== "own") { const chk = checkExtensionProfile(bc.profile, { account: readFlowAccount(workspace, sharedWs) }); if (!chk.ok) return send(res, 409, { error: chk.error }); }
      const runId = given.run || newRunId();
      startImgJob(runId, nThreads, nowAgent.backend, nowAgent.backend === "antigravity" ? (nowAgent.agyImages === "flow" ? "antigravity-flow" : "antigravity") : "claude", reviewAiNow);
      return send(res, 200, { ok: true, run: runId, started: new Date().toISOString() });
    }
    const r = agent.start({ run: given.run || undefined });
    return send(res, r.status, r.ok ? { ok: true, run: r.run_id, started: r.started } : { error: r.error });
  }
  // Chạy tiếp: the last Claude (Flow) run of this window, when it is over (stopped, failed, or done with items left) and still has
  // items without an image. Starting with its run id continues it: prepare keeps its items, and the steps skip what is already done.
  if (path === "/api/agent/resumable" && req.method === "GET") {
    const st = agent.status(), id = String(st.run_id || "");
    const none = () => send(res, 200, { resumable: false });
    if (st.active || (st.mode && st.mode !== "flow") || !/^agent-[0-9a-z-]+$/i.test(id)) return none();
    const dir = join(workspace, "output", id);
    let items = [];
    try { const j = JSON.parse(readFileSync(join(dir, "agent-items.json"), "utf8").replace(/^﻿/, "")); items = Array.isArray(j) ? j : (j.items || []); } catch { return none(); }
    const ids = items.filter((it) => it && it.id).map((it) => it.id), rows = new Set(doneRows(id));
    const left = ids.filter((x) => !hasImg(id, x)).length, leftReviews = ids.filter((x) => hasImg(id, x) && !hasRev(id, x)).length, leftFinish = ids.filter((x) => hasRev(id, x) && !rows.has(x)).length;
    if (!left && !leftReviews && !leftFinish) return none();
    return send(res, 200, { resumable: true, run: id, items: items.length, left, left_reviews: leftReviews, left_finish: leftFinish, status: st.status || "", updated: st.updated || st.started || "" });
  }
  if (path === "/api/agent/status" && req.method === "GET") {
    const st = agent.status(), dir = st.run_id ? join(workspace, "output", st.run_id) : "";
    return send(res, 200, { ...withProgress(st), result_folder: dir && existsSync(dir) ? dir : "" });
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
    if (agent.isActive()) return send(res, 409, { error: "Đã có một lượt AI đang chạy (tạo ảnh hoặc quét). Chờ xong hoặc bấm Dừng." });
    const r = agent.start({ run: "scan-" + newRunId().slice(6), mode: "scan", site, max });
    return send(res, r.status, r.ok ? { ok: true, run: r.run_id, started: r.started } : { error: r.error });
  }
  if (path === "/api/scan/status" && req.method === "GET") {
    const st = agent.status();
    if (st.mode !== "scan") return send(res, 200, { mode: st.mode, scan_run: false, other_active: st.active, active: false, status: "idle", tail: [] });
    return send(res, 200, { ...withProgress(st), scan_run: true, other_active: false, scan: scanOfRun(st.run_id) });
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
    { const fp = focusMismatch(id); if (fp) return send(res, 409, { error: fp }); }
    if (run.proc) return send(res, 409, { error: "Đang chạy." });
    if (agent.isActive()) return send(res, 409, { error: "Đã có một lượt AI đang chạy (tạo ảnh, quét hoặc cập nhật review). Chờ xong hoặc bấm Dừng." });
    const r = agent.start({ run: "reviews-" + newRunId().slice(6), mode: "reviews", project: id });
    return send(res, r.status, r.ok ? { ok: true, run: r.run_id, started: r.started } : { error: r.error });
  }
  if (path === "/api/project/reviews/status" && req.method === "GET") {
    const st = agent.status();
    if (st.mode !== "reviews") return send(res, 200, { mode: st.mode, reviews_run: false, other_active: st.active, active: false, status: "idle", tail: [] });
    return send(res, 200, { ...withProgress(st), reviews_run: true, other_active: false });
  }
  if (path === "/api/project/reviews/stop" && req.method === "POST") {
    if (agent.status().mode !== "reviews") return send(res, 409, { error: "Không có lượt cập nhật review nào đang chạy." });
    const r = agent.stop(); return send(res, r.status, r.ok ? { ok: true } : { error: r.error });
  }
  // Dự án: put products of a project into the run queue (urls.txt + references.json) with 2 library scenes each chosen by Claude
  // (docs/queue-prompt.md). Prepares only: no image creation, no review text. One agent run at a time, like the other modes.
  // "Thêm vào hàng chờ": first the READY rows of prepared.csv go into the queue instantly (src/scan.ps1 queue-from-prepared, no agent); only for the
  // shortfall a Claude queue run starts on the light runner (no browser, so it may run while Bắt đầu runs).
  if (path === "/api/project/queue/run" && req.method === "POST") {
    const given = JSON.parse((await body(req)).toString("utf8") || "{}");
    const id = String(given.project || "").trim();
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(id) || !existsSync(join(sharedWs, "projects", id, "project.json"))) return send(res, 400, { error: "Chọn một dự án có sẵn." });
    { const fp = focusMismatch(id); if (fp) return send(res, 409, { error: fp }); }
    if (queueOrder && queueOrder.active) return send(res, 409, { error: "Đang có một lệnh Thêm vào hàng chờ chưa xong (" + orderLine() + "). Chờ xong hoặc bấm Dừng." });
    const count = Math.min(200, Math.max(1, Math.round(Number(given.count)) || 10));
    const scenes = Math.min(4, Math.max(1, Math.round(Number(given.scenes)) || 2));
    const category = String(given.category || "").replace(/[\r\n"]+/g, " ").trim().slice(0, 120);
    const filters = projectArgs({ ...given, category });
    const base = queuedCountOf(id);
    // 1. the prepared stock first, instantly
    const fast = await runScan(["queue-from-prepared", "-Project", id, "-Limit", String(count), "-SceneCount", String(scenes), ...filters]);
    if (!fast.ok) return send(res, 500, { error: fast.error || "Chưa lấy được từ kho đã chuẩn bị." });
    const got = Number(fast.queued) || 0, need = count - got, dropped = fast.dropped || [];
    if (need <= 0) return send(res, 200, { ok: true, from_prepared: got, needs_claude: 0, dropped, finished: true });
    // 2. nothing left that Claude could queue: say so instead of starting it
    if (!(await productsLeft(id, scenes, filters))) return send(res, 200, { ok: true, from_prepared: got, needs_claude: 0, dropped, finished: true, message: got ? "Chỉ còn " + got + " sản phẩm để thêm: đã thêm hết (các sản phẩm khác đã dùng hoặc đã ở hàng chờ)." : "Không còn sản phẩm nào để thêm vào hàng chờ (đã dùng hoặc đã ở hàng chờ)." });
    // 3. the shortfall is NEVER dropped: an order of this session fills it (from the stock while a prep run adds rows, then Claude for the rest)
    queueOrder = { active: true, project: id, threads: clampThreads(given.threads, savedThreads()), total: count, scenes, category, unused_only: !!given.unused_only, filters, base, fromPrepared: got, state: "", message: "", lastMtime: 0, lastPull: 0, claudeNeed: 0, dropped };
    if (light.isActive()) queueOrder.state = "waiting";
    else { const r = await startOrderClaude(need); if (!r.ok) { queueOrder.active = false; return send(res, r.status || 500, { error: r.error, from_prepared: got, needs_claude: need }); } }
    queueOrderTimer = queueOrderTimer || setInterval(() => { orderTick().catch(() => {}); }, 3000);
    return send(res, 200, { ok: true, from_prepared: got, needs_claude: need, started: queueOrder.state === "claude", waiting: queueOrder.state === "waiting", order: orderStatus(), dropped });
  }
  // The live state of this session's Thêm vào hàng chờ order (the popup shows it).
  if (path === "/api/project/queue/order" && req.method === "GET") return send(res, 200, orderStatus());
  // "Chuẩn bị trước": Claude picks the scenes of every not-yet-prepared product and stores them in prepared.csv (docs/prep-prompt.md); no queue write.
  if (path === "/api/project/prep/run" && req.method === "POST") {
    const given = JSON.parse((await body(req)).toString("utf8") || "{}");
    const id = String(given.project || "").trim();
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(id) || !existsSync(join(sharedWs, "projects", id, "project.json"))) return send(res, 400, { error: "Chọn một dự án có sẵn." });
    { const fp = focusMismatch(id); if (fp) return send(res, 409, { error: fp }); }
    const scenes = Math.min(4, Math.max(1, Math.round(Number(given.scenes)) || 2));
    const category = String(given.category || "").replace(/[\r\n"]+/g, " ").trim().slice(0, 120);
    const limit = Math.min(500, Math.max(0, Math.round(Number(given.limit)) || 0));
    if (light.isActive()) return send(res, 409, { error: lightBusyText("Đã có một lượt chuẩn bị / thêm hàng chờ đang chạy. Chờ xong hoặc bấm Dừng.") });
    const options = `category: ${category ? `"${category}"` : "(all categories)"}; only unused (used = F): ${given.unused_only ? "T" : "F"}; products to prepare: ${limit || "all"}; scenes per product: ${scenes}; retry skipped (no-fit) products: ${given.retry_skipped ? "T" : "F"}`;
    let urls = null;
    const threads = clampThreads(given.threads, savedThreads());
    {
      const todo = await runScan(["prep-todo", "-Project", id, ...(limit ? ["-Limit", String(limit)] : []), ...projectArgs({ ...given, category }), ...(given.retry_skipped ? ["-RetrySkipped"] : [])], 120000);
      if (todo.ok) urls = (todo.products || []).map((x) => x.url);
    }
    prepMeta = { project: id, startedMs: Date.now(), total: urls ? urls.length : 0 };
    const r = startLightShards({ mode: "prep", project: id, options, threads, urls });
    return send(res, r.status, r.ok ? { ok: true, run: r.run_id, started: r.started } : { error: r.error });
  }
  // "Gắn nhãn kho ảnh": the scene library tag index (workspace/source-photos/scene-index.json, shared by every project and session).
  // GET = the counts the Dự án popup shows; run = Claude tags the untagged photos on the light runner (docs/index-prompt.md); stop = only an index run.
  if (path === "/api/library/index" && req.method === "GET") {
    const r = await runScan(["scene-index-status"], 90000);
    return send(res, r.ok ? 200 : 500, r.ok ? r : { error: r.error });
  }
  if (path === "/api/library/index/run" && req.method === "POST") {
    const given = JSON.parse((await body(req)).toString("utf8") || "{}");
    const group = String(given.group || "").replace(/[\r\n"]+/g, " ").trim().slice(0, 80);
    const limit = Math.min(5000, Math.max(0, Math.round(Number(given.limit)) || 0));
    if (light.isActive()) return send(res, 409, { error: lightBusyText("Đã có một lượt chuẩn bị / thêm hàng chờ / gắn nhãn đang chạy trong cửa sổ này. Chờ xong hoặc bấm Dừng.") });
    const options = `library group: ${group ? `"${group}"` : "(every group)"}; photos to tag: ${limit || "all"}`;
    { let n = 0; try { n = Object.keys(rj(join(sharedWs, "source-photos", "scene-index.json"))).length; } catch {} indexMeta = { base: n }; }
    const r = startLightShards({ mode: "index", project: "", options, threads: clampThreads(given.threads, savedThreads()) });
    return send(res, r.status, r.ok ? { ok: true, run: r.run_id, started: r.started } : { error: r.error });
  }
  if (path === "/api/library/index/stop" && req.method === "POST") {
    if (!light.isActive() || light.status().mode !== "index") return send(res, 409, { error: "Không có lượt gắn nhãn kho ảnh nào đang chạy." });
    const r = light.stop(); return send(res, r.status, r.ok ? { ok: true } : { error: r.error });
  }
  // "Đã chuẩn bị: X sẵn sàng / Y sản phẩm" for a project (and the category / only-unused filter of the popup).
  if (path === "/api/project/prepared" && req.method === "GET") {
    const id = String(url.searchParams.get("project") || "").trim();
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(id) || !existsSync(join(sharedWs, "projects", id, "project.json"))) return send(res, 400, { error: "Chọn một dự án có sẵn." });
    { const fp = focusMismatch(id); if (fp) return send(res, 409, { error: fp }); }
    const sc = Math.min(4, Math.max(0, Number(url.searchParams.get("scenes")) || 0));
    const r = await runScan(["prep-status", "-Project", id, ...(sc ? ["-SceneCount", String(sc)] : []), ...projectArgs({ category: url.searchParams.get("category"), unused_only: url.searchParams.get("unused_only") === "1" })], 60000);
    return send(res, r.ok ? 200 : 500, r.ok ? r : { error: r.error });
  }
  // Status of the light runner (queue and prep runs): its own file runs/prep-run.json.
  // ONE status for the run line of every view: what runs now (main runner, light runner, the Codex Bắt đầu run) and the last finished run.
  // Duyệt: a readable label for every run folder (newest first is the caller's job)
  // Per queue link: how far the newest agent run of this window got (images, reviews, finished), for the link list on the main screen.
  if (path === "/api/runs/links" && req.method === "GET") return send(res, 200, linkStates());
  if (path === "/api/runs/labels" && req.method === "GET") {
    const out = {};
    try { for (const e of readdirSync(join(workspace, "output"), { withFileTypes: true })) if (e.isDirectory()) out[e.name] = runInfo(e.name); } catch {}
    return send(res, 200, { runs: out });
  }
  if (path === "/api/runs/status" && req.method === "GET") {
    const view = (st, kind) => ({ kind, feature: FEATURE[st.mode] || st.mode, mode: st.mode, project: st.project ? projectNameOf(st.project) : "", active: !!st.active, elapsed_s: st.elapsed_s || 0,
      last_text: st.last_text || "", status: st.status, error: st.error || "", started: st.started || "", updated: st.updated || "", progress: progressOf(st), result: resultOf(st), where: runWhere(st) });
    const m = agent.status(), l = light.status(), running = [];
    if (run.proc) running.push({ kind: "codex", feature: FEATURE.flow, mode: "flow", project: selfProject() ? projectNameOf(selfProject()) : "", active: true, elapsed_s: Math.round((Date.now() - (run.startedAt || Date.now())) / 1000), last_text: "", status: "running", error: "" });
    if (m.active) running.push(view(m, "main"));
    if (l.active) running.push(view(l, "light"));
    const done = [[m, "main"], [l, "light"]].filter(([s]) => !s.active && s.started && s.status && s.status !== "idle" && s.mode !== "ctx" && s.mode !== "rev").map(([s, k]) => view(s, k)).sort((a, b) => String(b.updated || b.started).localeCompare(String(a.updated || a.started)));
    return send(res, 200, { running, last: done[0] || null });
  }
  if (path === "/api/light/status" && req.method === "GET") return send(res, 200, { ...withProgress(light.status()), light: true });
  if ((path === "/api/project/queue/stop" || path === "/api/project/prep/stop") && req.method === "POST") {
    const hadOrder = !!(queueOrder && queueOrder.active);
    if (hadOrder) finishOrder("cancelled", "Đã dừng lệnh Thêm vào hàng chờ.");
    if (!light.isActive()) return send(res, hadOrder ? 200 : 409, hadOrder ? { ok: true } : { error: "Không có lượt chuẩn bị / thêm vào hàng chờ nào đang chạy." });
    const r = light.stop(); return send(res, r.status, r.ok ? { ok: true } : { error: r.error });
  }
  // Scenes box = 0: no Claude run. The first N products in table order (category / only-unused filter) go into the queue with only their link and
  // project photo (src/scan.ps1 queue-direct, the same writer as queue-add).
  if (path === "/api/project/queue/direct" && req.method === "POST") {
    const given = JSON.parse((await body(req)).toString("utf8") || "{}");
    const id = String(given.project || "").trim();
    if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(id) || !existsSync(join(sharedWs, "projects", id, "project.json"))) return send(res, 400, { error: "Chọn một dự án có sẵn." });
    { const fp = focusMismatch(id); if (fp) return send(res, 409, { error: fp }); }
    const count = Math.min(200, Math.max(1, Math.round(Number(given.count)) || 10));
    const args = ["queue-direct", "-Project", id, "-Limit", String(count), ...(String(given.category || "").trim() ? ["-Collection", String(given.category).trim()] : []), ...(given.unused_only ? ["-UnusedOnly"] : [])];
    return execFile(PWSH, psFile(join(root, "src", "scan.ps1"), args), { cwd: root, env: toolEnv, timeout: 120000, windowsHide: true, encoding: "utf8" }, (err, out) => {
      let r = null; try { r = JSON.parse(String(out || "").trim().split(String.fromCharCode(10)).pop()); } catch { /* below */ }
      if (r?.ok) return send(res, 200, { ok: true, added: r.added });
      send(res, 500, { error: r?.error || (err && err.message) || "Chưa thêm vào hàng chờ được." });
    });
  }
  if (path === "/api/project/queue/status" && req.method === "GET") return send(res, 200, { ...withProgress(light.status()), light: true });
  // Own Chrome sign-in for Claude (Flow): status (short headless check), open (normal Chrome window for the person to sign in).
  // Which browser Claude (Flow) drives: everyday Chrome (a profile chosen from this machine) or the tool's own Chrome.
  // token_saved per profile (a bool only: the Playwright extension token itself never goes back to the page)
  if (path === "/api/flow-browser" && req.method === "GET") { const lp = localChromeProfiles(), withTok = new Set(tokenProfiles(sharedWs)); return send(res, 200, { ...readFlowBrowser(workspace, sharedWs), ...lp, profiles: (lp.profiles || []).map((p) => ({ ...p, token_saved: withTok.has(p.folder) })) }); }
  // Save (token) or clear (token "") the optional Playwright extension token of one Chrome profile: shared workspace/playwright-tokens.json.
  if (path === "/api/flow-browser/token" && req.method === "POST") { try { const b = JSON.parse((await body(req)).toString("utf8") || "{}"); return send(res, 200, saveExtensionToken(sharedWs, String(b.profile || ""), String(b.token || ""))); } catch (e) { return send(res, 400, { error: e.message }); } }
  // Opens the Chrome Web Store page of the Playwright MCP Bridge in THE CHOSEN profile; the person clicks "Add to Chrome" (nothing is installed for them).
  if (path === "/api/flow-browser/install-extension" && req.method === "POST") {
    try {
      const b = JSON.parse((await body(req)).toString("utf8") || "{}"), folder = String(b.profile || "");
      if (!/^(Default|Profile \d{1,3})$/.test(folder)) return send(res, 400, { error: "Profile không hợp lệ." });
      if (!localChromeProfiles().profiles.some((p) => p.folder === folder)) return send(res, 400, { error: "Profile này không có trên máy." });
      const chrome = findChrome();
      if (!chrome) return send(res, 400, { error: "Không tìm thấy Google Chrome (đặt PR_CHROME_PATH nếu cài ở chỗ khác)." });
      const child = spawn(chrome, ["--profile-directory=" + folder, ...WINDOW_ARGS, "https://chromewebstore.google.com/detail/playwright-mcp-bridge/mmlmfjhmonkocbjadbfplnigmagldckm"], { detached: true, stdio: "ignore" });
      child.on("error", () => {}); child.unref();
      return send(res, 200, { ok: true, profile: folder });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (path === "/api/flow-browser" && req.method === "POST") { try { const b = JSON.parse((await body(req)).toString("utf8") || "{}"); const saved = saveFlowBrowser(workspace, b, sharedWs); alignFlowAccount(saved); return send(res, 200, saved); } catch (e) { return send(res, 400, { error: e.message }); } }
  // Everyday-Chrome (extension) mode: nothing to probe in the tool's own profile; the button opens Flow in the CHOSEN profile instead.
  if (path === "/api/flow-login/status" && req.method === "GET") return send(res, 200, readFlowBrowser(workspace, sharedWs).mode === "own" ? await flowLogin.status({ fresh: url.searchParams.get("fresh") === "1" }) : { state: "extension", detail: "Chrome thật: không kiểm tra đăng nhập ở đây" });
  if (path === "/api/flow-login/open" && req.method === "POST" && readFlowBrowser(workspace, sharedWs).mode !== "own") return send(res, ...openEverydayChrome(readFlowBrowser(workspace, sharedWs)));
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
process.on("exit", () => { try { menuBar?.kill(); } catch {} try { agent.shutdown(); } catch {} try { light.shutdown(); } catch {} try { for (const f of shardFiles.splice(0)) rmSync(f, { force: true }); } catch {} try { releaseLocks(root, session); unregisterSession(root, session); } catch {} });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));

// The Google accounts the Flow account combo may list: those signed in in the chosen Chrome profile (extension mode), or in the tool's own Chrome.
function flowAccountsFor(browser) {
  if (!browser || browser.mode === "own") return profileGoogleAccounts(profileDirOf(sharedWs));
  const p = localChromeProfiles().profiles.find((x) => x.folder === browser.profile);
  return p ? p.accounts : [];
}
// After the Chrome profile changed: the Flow account follows it (followFlowAccount: the profile's only account; with several the current
// one if signed in there, else none and the UI warns). The person can still pick another account by hand afterwards.
function alignFlowAccount(browser) {
  if (!browser || browser.mode === "own") return;
  const file = join(workspace, "config", "run-settings.json");
  readSeededJson(file, join(sharedWs, "config", "run-settings.json"), {});
  const accounts = flowAccountsFor(browser);
  updateJsonLocked(file, (saved) => {
    const cur = String(saved.flowAccount || "").toLowerCase(), want = followFlowAccount(accounts, cur);
    if (want === cur) return undefined;
    if (want) saved.flowAccount = want; else delete saved.flowAccount;
    return saved;
  }, {});
}
// Everyday-Chrome mode: "Mở Chrome để đăng nhập" opens Flow in the chosen profile through Google's account chooser, pre-selecting this
// window's Flow account (run-settings.json of the session). Lost in the sessions audit (f6d0469) while its route still called it; restored.
let everydayOpened = 0;
function openEverydayChrome(browser) {
  const p = localChromeProfiles().profiles.find((x) => x.folder === browser.profile);
  if (!p) return [400, { error: "Profile Chrome \"" + browser.profile + "\" không có trên máy này. Chọn profile khác ở ô Chrome profile." }];
  const chrome = findChrome();
  if (!chrome) return [400, { error: "Không tìm thấy Google Chrome (đặt PR_CHROME_PATH nếu cài ở chỗ khác)." }];
  if (Date.now() - everydayOpened < 5000) return [429, { error: "Vừa mở xong, chờ vài giây." }];
  let account = "";
  try { account = String(readSeededJson(join(workspace, "config", "run-settings.json"), join(sharedWs, "config", "run-settings.json"), {}).flowAccount || ""); } catch {}
  if (account && p.accounts && p.accounts.length && !p.accounts.includes(account.toLowerCase())) account = "";
  try {
    const child = spawn(chrome, ["--profile-directory=" + p.folder, ...WINDOW_ARGS, flowOpenUrl(account)], { detached: true, stdio: "ignore" });
    child.on("error", () => {}); child.unref(); everydayOpened = Date.now();
    return [200, { ok: true, profile: p.folder, account }];
  } catch (e) { return [500, { error: String(e.message || e).slice(0, 200) }]; }
}
// ----- Sessions (several windows from one source) -----
let self = null; // this window's registry entry, once the server listens
function profileLabel() { try { const b = readFlowBrowser(workspace, sharedWs); return profileLabelOf(b, localChromeProfiles().profiles); } catch { return ""; } }
// ----- the project this window works on (registry field project): none at start ("mặc định", as before) until the person picks one in the Dự án popup;
// an empty project gives it back ("Bỏ chọn dự án"). A window opened for a project (session named after it) stays locked to it.
const lockedProject = /^[a-z0-9][a-z0-9-]{1,60}$/.test(process.env.PR_PROJECT || "") && process.env.PR_PROJECT === session ? process.env.PR_PROJECT : "";
const projectExists = (id) => /^[a-z0-9][a-z0-9-]{1,60}$/.test(id) && existsSync(join(sharedWs, "projects", id, "project.json"));
function projectNameOf(id) { try { return JSON.parse(readFileSync(join(sharedWs, "projects", id, "project.json"), "utf8").replace(/^\uFEFF/, "")).name || id; } catch { return id; } }
function initFocus() {
  // A window opened for a project keeps it; every other window (the default one, a free-name session) starts with NO project, as before.
  claimProjectFocus(root, session, process.pid, lockedProject || "");
}
// every project action of this window acts on the focused project: a request for another one is refused (no stale selection)
const focusMismatch = (id) => { const f = selfProject(); return f === id ? "" : f ? "Dự án đang chọn của cửa sổ này là " + f + ", không phải " + id + ". Chọn lại dự án trong cửa sổ Dự án." : "Cửa sổ này chưa chọn dự án. Chọn một dự án trong cửa sổ Dự án trước."; };
function selfProject() { try { return listSessions(root).find((e) => e.pid === process.pid)?.project || ""; } catch { return ""; } }
function sessionInfo() {
  const label = profileLabel();
  const group = peekGroup(workspace, session);
  const project = selfProject();
  return { session, label: sessionLabel(session), stt: self?.stt || 0, port: PORT, pid: process.pid, profile_label: label, running: agent.isActive() || light.isActive(), project,
    next_group: group, project_name: project ? projectNameOf(project) : "", loose: !project, locked: !!lockedProject, title: sessionTitle({ stt: self?.stt, session, profileLabel: label, projectName: project ? projectNameOf(project) : "" }) };
}
// Live data each time: the registry entries whose pid is alive AND whose port answers /api/root with that pid within ~1 s (a stale entry never shows).
async function liveSessions() {
  const alive = await Promise.all(listSessions(root).map(async (e) => {
    if (e.pid === process.pid) return e;
    try {
      const r = await fetch("http://127.0.0.1:" + e.port + "/api/root", { signal: AbortSignal.timeout(1000) });
      const j = await r.json();
      return j && j.service === "product-review" && j.pid === e.pid ? e : null;
    } catch { return null; }
  }));
  return alive.filter(Boolean);
}
function sessionRows(live) {
  return live.map((e) => ({ project_name: e.project ? projectNameOf(e.project) : "", stt: e.stt, session: e.session, label: sessionLabel(e.session), port: e.port, pid: e.pid, profile_label: e.profile_label || "", running: !!e.running, project: e.project || "", current: e.pid === process.pid }));
}
// The projects a new window can be opened for: every folder of workspace/projects with a project.json, and who uses it right now.
// products.csv: how many rows and how many are still unused (column "used" is not T / true / 1 / x / y / yes). Quoted cells may hold commas.
function csvCells(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out;
}
// The counts of a project, the ONLY place they are computed for the UI: { products, used, unused, scanned }.
function projectCounts(id) {
  try { const t = csvCounts(readFileSync(join(sharedWs, "projects", id, "products.csv"), "utf8")); return { products: t.products, used: t.products - t.unused, unused: t.unused, scanned: true }; }
  catch { return { products: 0, used: 0, unused: 0, scanned: false }; }
}
function csvCounts(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { products: 0, unused: 0 };
  const used = csvCells(lines[0]).map((c) => c.trim().toLowerCase()).indexOf("used");
  let unused = 0;
  for (const l of lines.slice(1)) { const v = used >= 0 ? (csvCells(l)[used] || "").trim().toLowerCase() : ""; if (!/^(t|true|1|x|y|yes)$/.test(v)) unused++; }
  return { products: lines.length - 1, unused };
}
// Which project was used last (a window opened for it or selected it): config/recent-projects.json, for the "recently used first" order.
const recentFile = join(sharedWs, "config", "recent-projects.json");
function readRecent() { try { return JSON.parse(readFileSync(recentFile, "utf8")); } catch { return {}; } }
function touchRecent(id) { try { updateJsonLocked(recentFile, (all) => { all[id] = new Date().toISOString(); return all; }, {}); } catch {} }
// ONE place decides who holds project n, for every endpoint: a live window whose focus (registry field project) is n, or a window named after n,
// else a run lock of another session. current = it is THIS window.
function projectHolder(live, n) {
  const w = live.find((e) => e.project === n) || live.find((e) => e.session === n);
  if (w) return { session: w.session, label: w.session || "mặc định", stt: w.stt, current: w.pid === process.pid, via: "window" };
  const h = lockHolder(root, "project", n, session);
  return h ? { session: h.session, label: h.session || "mặc định", stt: 0, current: false, via: "run" } : null;
}
function projectChoices(live) {
  const base = join(sharedWs, "projects");
  let names = []; try { names = readdirSync(base); } catch { return []; }
  return names.filter((n) => /^[a-z0-9][a-z0-9-]{1,60}$/.test(n) && existsSync(join(base, n, "project.json"))).map((n) => {
    let info = {}; try { info = JSON.parse(readFileSync(join(base, n, "project.json"), "utf8").replace(/^\uFEFF/, "")); } catch {}
    const h = projectHolder(live, n);
    const { products, unused, scanned } = projectCounts(n);
    const recent = readRecent()[n] || info.updated || info.last_scan || "";
    return { id: n, name: info.name || n, site: info.site || "", products, unused, used: products - unused, scanned, recent,
      window_open: !!h && h.via === "window", window_stt: h ? h.stt : 0, current: !!h && h.current, mine: !!h && h.current,
      busy: h && !h.current ? h.label : "", busy_via: h && !h.current ? h.via : "" };
  }).sort((a, b) => String(b.recent).localeCompare(String(a.recent)) || a.id.localeCompare(b.id));
}
function syncRegistry() { try { if (self) updateSession(root, session, process.pid, { profile_label: profileLabel(), running: agent.isActive() || light.isActive() }); } catch {} }
// Opens (or refocuses, when it already runs) the window of a session: the launcher does it, so macOS and Windows behave alike.
function openSessionWindow(name, project = "") {
  try {
    const windows = process.platform === "win32";
    // Windows: the launcher must be started through `cmd /c start`. Started straight from Node, powershell.exe either exits at once (detached) or runs with its window hidden (windowsHide), so the session server ran but no window ever showed (verified); `start` gives it a normal start and -WindowStyle Hidden hides only the console.
    const cmd = windows ? "cmd.exe" : "bash";
    const args = windows ? ["/c", "start", "", "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", join(root, "core", "launch.ps1"), "-Session", name, "-Project", project] : [join(root, "start-app.command"), name, project];
    // Windows: detached:true makes powershell.exe exit at once without running launch.ps1 (verified), so the launcher is a normal hidden child; unref() lets this server exit independently.
    const child = spawn(cmd, args, { cwd: root, detached: !windows, stdio: "ignore", windowsHide: windows });
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
      // Already running for this folder AND this session: just show its window. Another program, or ANOTHER session of this folder whose port
      // hashes to the same number (two session names can collide), on the port: try the next one.
      return fetch(`http://127.0.0.1:${PORT}/api/root`).then((r) => r.json()).then((body) => {
        if (body.root !== root || String(body.session || "") !== session) throw new Error("other");
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
  server.listen(PORT, "127.0.0.1", () => { try { self = registerSession(root, { session, port: PORT, extra: { profile_label: profileLabel(), running: false, project: /^[a-z0-9][a-z0-9-]{1,60}$/.test(process.env.PR_PROJECT || "") ? process.env.PR_PROJECT : "" } }); setInterval(syncRegistry, 5000).unref(); initFocus(); } catch (e) { logError("Sessions", e.message); } startMenuBar(); if (!process.argv.includes("--no-open")) openWindow(); });
}
startRpc();
listen();

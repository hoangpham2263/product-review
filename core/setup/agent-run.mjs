// Agent mode: starts Claude Code headless (`claude -p`) to drive Google Flow (Playwright MCP) and write the reviews.
// One run at a time (one browser, one agent). The prompt goes to STDIN, never argv. Nothing secret is stored: only assistant
// text and tool NAMES are kept, scrubbed and cut (never tool inputs or results).
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { platform as osPlatform } from "node:os";

export const DEFAULT_MINUTES = 40;
export const MAX_LINE = 300, LOG_LINES = 2000, TAIL_LINES = 30;
export const PLAYWRIGHT_TOOLS = ["browser_tabs", "browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_press_key", "browser_wait_for", "browser_run_code_unsafe", "browser_take_screenshot", "browser_evaluate", "browser_file_upload"].map((n) => "mcp__playwright__" + n);
export const ALLOWED_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", ...PLAYWRIGHT_TOOLS];

const SCRUBS = [
  [/\bBearer\s+\S+/gi, "Bearer [hidden]"],
  [/\b[\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization)[\w-]*\s*[:=]\s*\S+/gi, "[hidden]"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "[hidden]"],
  [/[A-Za-z0-9+/_=-]{40,}/g, "[hidden]"],
];
export function sanitize(text, max = MAX_LINE) {
  let s = String(text ?? "").replace(/\s+/g, " ").trim();
  for (const [re, to] of SCRUBS) s = s.replace(re, to);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function mcpConfig({ plat = osPlatform() } = {}) {
  const server = plat === "win32" ? { command: "cmd", args: ["/c", "npx", "@playwright/mcp@latest", "--extension"] } : { command: "npx", args: ["@playwright/mcp@latest", "--extension"] };
  return { mcpServers: { playwright: server } };
}

export const newRunId = (d = new Date()) => "agent-" + d.toISOString().replace(/\D/g, "").slice(0, 14);

// The text block of docs/agent-prompt.md, placeholders filled.
export function buildPrompt({ toolRoot, run, options = "defaults" }) {
  const md = readFileSync(join(toolRoot, "docs", "agent-prompt.md"), "utf8");
  const m = md.match(/```text\r?\n([\s\S]*?)\r?\n```/);
  if (!m) throw new Error("docs/agent-prompt.md has no text block.");
  return m[1].replace(/\{\{TOOL\}\}/g, toolRoot).replace(/\{\{RUN\}\}/g, run).replace(/\{\{OPTIONS\}\}/g, options);
}

const defaultKill = (child, plat) => {
  if (!child?.pid) return;
  if (plat === "win32") { try { spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000, stdio: "ignore" }); } catch {} return; }
  try { child.kill("SIGTERM"); } catch {}
  const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000); t.unref?.();
};
const defaultNpx = (plat) => {
  try {
    if (plat === "win32") execFileSync("cmd", ["/c", "npx", "--version"], { windowsHide: true, timeout: 20000, stdio: "ignore" });
    else execFileSync("npx", ["--version"], { timeout: 20000, stdio: "ignore" });
    return true;
  } catch { return false; }
};
// The Claude CLI: env PR_CLAUDE_CLI, else the first `claude` on PATH.
export function findClaude(plat = osPlatform()) {
  const given = process.env.PR_CLAUDE_CLI;
  if (given && existsSync(given)) return { found: true, path: given };
  try {
    const out = execFileSync(plat === "win32" ? "where" : "which", ["claude"], { encoding: "utf8", windowsHide: true, timeout: 10000 }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const pick = (plat === "win32" && out.find((p) => /\.(cmd|exe|bat)$/i.test(p))) || out[0];
    return pick ? { found: true, path: pick } : { found: false, path: "" };
  } catch { return { found: false, path: "" }; }
}

export function createAgentRunner({ toolRoot, workspace, findCli = findClaude, plat = osPlatform(), spawnFn = spawn, killTree = (c) => defaultKill(c, plat), npxOk = () => defaultNpx(plat), now = () => Date.now(), graceMs = 4000, minutes = DEFAULT_MINUTES, maxTurns = 400 }) {
  const runsDir = join(workspace, "runs"), tmpDir = join(workspace, "tmp");
  const stateFile = join(runsDir, "agent-run.json"), logFile = join(runsDir, "agent-run.log");
  let cur = null, last = null;

  const readState = () => { try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch { return null; } };
  const saveState = (st) => { try { mkdirSync(runsDir, { recursive: true }); writeFileSync(stateFile, JSON.stringify(st, null, 2)); } catch {} };
  const touch = (run, patch = {}) => { Object.assign(run.state, patch, { updated: new Date(now()).toISOString() }); saveState(run.state); };
  const addLine = (run, text) => {
    const line = sanitize(text); if (!line) return;
    run.lines.push(line); if (run.lines.length > LOG_LINES) run.lines.splice(0, run.lines.length - LOG_LINES);
    try { mkdirSync(runsDir, { recursive: true }); if (++run.written % 500 === 0) writeFileSync(logFile, run.lines.join("\n") + "\n"); else appendFileSync(logFile, line + "\n"); } catch {}
  };
  const handleLine = (run, raw) => {
    let ev; try { ev = JSON.parse(raw); } catch { addLine(run, raw); return; }
    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      run.state.turns = (run.state.turns || 0) + 1;
      for (const c of ev.message.content) {
        if (c.type === "text" && c.text) { addLine(run, "A: " + c.text); const t = sanitize(c.text); if (t) run.state.last_text = t; }
        else if (c.type === "tool_use" && typeof c.name === "string") addLine(run, "tool: " + c.name);
      }
      touch(run);
    } else if (ev.type === "result") {
      run.result = { is_error: !!ev.is_error, subtype: String(ev.subtype || "") };
      if (typeof ev.num_turns === "number") run.state.turns = ev.num_turns;
      if (typeof ev.result === "string" && ev.result) run.state.last_text = sanitize(ev.result);
      addLine(run, `result: ${run.result.subtype}${run.result.is_error ? " (error)" : ""}`);
      touch(run);
    }
  };
  const feed = (run, chunk) => {
    run.buf += chunk.toString("utf8");
    let i;
    while ((i = run.buf.indexOf("\n")) >= 0) { const l = run.buf.slice(0, i).trim(); run.buf = run.buf.slice(i + 1); if (l) handleLine(run, l); }
    if (run.buf.length > 1e6) run.buf = "";
  };
  const finish = (run, code, err) => {
    if (run.ended) return; run.ended = true;
    clearTimeout(run.timer);
    if (run.buf.trim()) handleLine(run, run.buf.trim());
    try { rmSync(run.cfg, { force: true }); } catch {}
    const status = run.forced || (code === 0 && !run.result?.is_error ? "done" : "failed");
    const error = status === "failed" ? sanitize(err || run.stderr.at(-1) || (run.result?.is_error ? `Claude reported ${run.result.subtype || "an error"}.` : `Claude exited with code ${code}.`))
      : status === "timeout" ? `Stopped after the ${minutes}-minute limit.` : "";
    addLine(run, `end: ${status}${code === null || code === undefined ? "" : " (exit " + code + ")"}`);
    try { writeFileSync(logFile, run.lines.join("\n") + "\n"); } catch {}
    touch(run, { status, exit_code: code ?? null, error });
    last = run.state; cur = null;
  };

  function start({ run: runId = newRunId(), options = "defaults" } = {}) {
    if (!/^[\w.-]{3,64}$/.test(runId)) return { ok: false, status: 400, error: "Invalid run id." };
    if (cur) return { ok: false, status: 409, error: `An agent run is already active (started ${cur.state.started}). Wait for it or press Stop.` };
    const found = findCli();
    if (!found?.found) return { ok: false, status: 400, error: "Claude CLI not found: install Claude Code, or set PR_CLAUDE_CLI to its path." };
    if (!npxOk()) return { ok: false, status: 400, error: "npx is not available (it comes with Node.js): the Playwright MCP cannot start." };
    let prompt;
    try { prompt = buildPrompt({ toolRoot, run: runId, options }); } catch (e) { return { ok: false, status: 500, error: sanitize(e.message) }; }
    mkdirSync(tmpDir, { recursive: true }); mkdirSync(runsDir, { recursive: true });
    const cfg = join(tmpDir, `mcp-${runId}-${randomBytes(3).toString("hex")}.json`);
    writeFileSync(cfg, JSON.stringify(mcpConfig({ plat })));
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "default", "--max-turns", String(maxTurns), "--allowedTools", ALLOWED_TOOLS.join(","), "--add-dir", toolRoot, "--mcp-config", cfg];
    const env = { ...process.env };
    const cmd = plat === "win32" && /\.(cmd|bat)$/i.test(found.path) ? ["cmd", ["/c", found.path, ...args]] : [found.path, args];
    let child;
    try { child = spawnFn(cmd[0], cmd[1], { cwd: toolRoot, env, windowsHide: true, detached: false, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { try { rmSync(cfg, { force: true }); } catch {} return { ok: false, status: 500, error: sanitize(e.message) }; }
    const started = new Date(now()).toISOString();
    const run = { child, cfg, lines: [], buf: "", written: 0, stderr: [], ended: false, forced: "", result: null, timer: null,
      state: { run_id: runId, pid: child.pid ?? null, started, updated: started, status: "running", exit_code: null, last_text: "", turns: 0, error: "" } };
    cur = run;
    try { writeFileSync(logFile, ""); } catch {}
    addLine(run, `start: agent run ${runId}`);
    saveState(run.state);
    child.stdout?.on("data", (c) => feed(run, c));
    child.stderr?.on("data", (c) => { for (const l of c.toString("utf8").split(/\r?\n/)) { const t = sanitize(l); if (t) { run.stderr.push(t); if (run.stderr.length > 20) run.stderr.shift(); addLine(run, "! " + t); } } });
    child.on("error", (e) => finish(run, null, e.message));
    child.on("close", (code) => finish(run, code));
    child.stdin?.on("error", () => {});
    const note = "RUN-NOW NOTE: this run was started from the app, so the person is at the computer and will click Connect in Chrome if asked. If the browser is not connected yet, bring the Playwright Welcome / connect tab to the front (browser_run_code_unsafe: async (page) => { await page.bringToFront(); }), tell the person in one line to click Connect, then wait up to 3 minutes calling browser_tabs about every 15 seconds; if nothing connects, stop and report that Chrome did not connect.\n\n";
    try { child.stdin?.end(note + prompt); } catch {}
    run.timer = setTimeout(() => { if (run.ended) return; run.forced = "timeout"; killTree(child); setTimeout(() => finish(run, null), graceMs).unref?.(); }, minutes * 60000);
    run.timer.unref?.();
    return { ok: true, status: 200, run_id: runId, started };
  }

  function stop() {
    if (!cur) return { ok: false, status: 409, error: "No run is active." };
    const run = cur; run.forced = "stopped"; killTree(run.child);
    setTimeout(() => finish(run, null), graceMs).unref?.();
    return { ok: true, status: 200, run_id: run.state.run_id };
  }
  function shutdown() {
    if (!cur) return;
    cur.forced = cur.forced || "stopped"; killTree(cur.child);
    try { rmSync(cur.cfg, { force: true }); } catch {}
    touch(cur, { status: "stopped" });
  }
  function status() {
    const run = cur, st = run ? run.state : last || readState();
    const shown = st && !run && st.status === "running" ? { ...st, status: "failed", error: "The app closed while this run was active." } : st;
    const lines = run ? run.lines : (() => { try { return readFileSync(logFile, "utf8").split("\n").filter(Boolean); } catch { return []; } })();
    return {
      active: !!run, status: shown?.status || "idle", run_id: shown?.run_id || "", started: shown?.started || "",
      elapsed_s: shown?.started ? Math.max(0, Math.round(((run ? now() : Date.parse(shown.updated) || now()) - Date.parse(shown.started)) / 1000)) : 0,
      last_text: shown?.last_text || "", turns: shown?.turns || 0, error: shown?.error || "", tail: lines.slice(-TAIL_LINES),
    };
  }
  return { start, stop, status, shutdown, isActive: () => !!cur };
}

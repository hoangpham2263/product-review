// Agent mode: starts Claude Code headless (`claude -p`) to drive Google Flow (Playwright MCP) and write the reviews.
// One run at a time (one browser, one agent). The prompt goes to STDIN, never argv. Nothing secret is stored: only assistant
// text and tool NAMES are kept, scrubbed and cut (never tool inputs or results).
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { platform as osPlatform } from "node:os";
import { localChromeProfiles, extensionToken } from "./flow-browser.mjs";
import { WINDOW_SIZE } from "./flow-login.mjs";
import { claimLock, releaseLocks, takeGroup, sessionLabel, readSeededJson } from "./session.mjs";

// 0 = no limit: a run ends when Claude finishes, so a long batch is never cut off half way. Set minutes / maxTurns above 0 to cap a run.
export const DEFAULT_MINUTES = 0;
export const MAX_LINE = 300, LOG_LINES = 2000, TAIL_LINES = 30;
export const PLAYWRIGHT_TOOLS = ["browser_tabs", "browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_press_key", "browser_wait_for", "browser_run_code_unsafe", "browser_take_screenshot", "browser_evaluate", "browser_file_upload"].map((n) => "mcp__playwright__" + n);
export const ALLOWED_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", ...PLAYWRIGHT_TOOLS];
// queue / prep / index runs only look at photos and call src/scan.ps1: no browser, no Playwright MCP, no Chrome profile.
export const LIGHT_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"];
export const LIGHT_MODES = ["queue", "prep", "index"];
// The name of each feature as the person knows it: every log line of a run starts with [feature · project].
export const FEATURE = { flow: "Tạo ảnh & review (Bắt đầu)", scan: "Quét web", reviews: "Cập nhật số review", queue: "Thêm vào hàng chờ", prep: "Chuẩn bị trước", index: "Gắn nhãn kho ảnh" };

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

// What the person reads in "Tiến trình & thông báo": one plain Vietnamese line per Claude step instead of tool names.
// A tool input is only matched against keywords to pick the wording; it is never stored or shown.
const TOOL_TEXT = {
  browser_tabs: "Kiểm tra tab trình duyệt", browser_navigate: "Mở trang Google Flow", browser_snapshot: "Đọc nội dung trang Flow",
  browser_click: "Bấm nút trên Flow", browser_type: "Nhập nội dung vào Flow", browser_press_key: "Nhấn phím trên Flow",
  browser_wait_for: "Chờ Flow xử lý", browser_run_code_unsafe: "Thao tác trên Flow (tải ảnh, gửi yêu cầu, tải ảnh về)",
  browser_take_screenshot: "Chụp màn hình Flow để kiểm tra", browser_evaluate: "Đọc trạng thái trang Flow", browser_file_upload: "Tải ảnh tham chiếu lên Flow",
};
// Quét web: the same browser tools, worded for a shop website instead of Google Flow.
const SCAN_TOOL_TEXT = {
  browser_tabs: "Kiểm tra tab trình duyệt", browser_navigate: "Mở trang web cần quét", browser_snapshot: "Đọc nội dung trang",
  browser_click: "Bấm trên trang web", browser_type: "Nhập vào trang web", browser_press_key: "Nhấn phím trên trang web",
  browser_wait_for: "Chờ trang tải", browser_run_code_unsafe: "Thao tác trên trang web (cuộn, đọc danh sách sản phẩm)",
  browser_take_screenshot: "Chụp ảnh trang hoặc ảnh sản phẩm", browser_evaluate: "Đọc danh sách link và ảnh trên trang", browser_file_upload: "Tải file lên trang",
};
// Cập nhật số review: the same browser tools, worded for reading the review number on a product page (read only).
const REVIEWS_TOOL_TEXT = {
  browser_tabs: "Kiểm tra tab trình duyệt", browser_navigate: "Mở trang sản phẩm", browser_snapshot: "Đọc số review hiển thị trên trang",
  browser_click: "Bấm trên trang sản phẩm (mở phần review)", browser_type: "Nhập vào trang web", browser_press_key: "Nhấn phím trên trang web",
  browser_wait_for: "Chờ trang tải", browser_run_code_unsafe: "Cuộn trang tới phần review", browser_take_screenshot: "Chụp trang để xem số review",
  browser_evaluate: "Đọc chữ trên trang sản phẩm", browser_file_upload: "Tải file lên trang",
};
// Thêm vào hàng chờ: no browser, only the library photos, the product photos and the queue commands.
const QUEUE_TOOL_TEXT = {
  browser_tabs: "Kiểm tra tab trình duyệt", browser_navigate: "Mở trang web", browser_snapshot: "Đọc nội dung trang",
  browser_click: "Bấm trên trang web", browser_type: "Nhập vào trang web", browser_press_key: "Nhấn phím trên trang web",
  browser_wait_for: "Chờ trang tải", browser_run_code_unsafe: "Thao tác trên trang web", browser_take_screenshot: "Chụp ảnh trang",
  browser_evaluate: "Đọc chữ trên trang", browser_file_upload: "Tải file lên trang",
};
export function friendlyTool(name, input = {}, mode = "flow") {
  const n = String(name || "").replace(/^mcp__playwright__/, "");
  if (mode === "scan" && SCAN_TOOL_TEXT[n]) return SCAN_TOOL_TEXT[n];
  if (mode === "reviews" && REVIEWS_TOOL_TEXT[n]) return REVIEWS_TOOL_TEXT[n];
  if (mode === "queue" && QUEUE_TOOL_TEXT[n]) return QUEUE_TOOL_TEXT[n];
  if (TOOL_TEXT[n]) return TOOL_TEXT[n];
  const cmd = String(input?.command || input?.file_path || "");
  if (n === "Bash") {
    if (/scan\.ps1/i.test(cmd)) {
      if (/scene-index-todo/i.test(cmd)) return "Lấy lô ảnh kho chưa gắn nhãn (một tấm ảnh ghép)";
      if (/scene-index-add/i.test(cmd)) return "Lưu nhãn ảnh kho vừa xem";
      if (/scene-index-status/i.test(cmd)) return "Xem số ảnh kho đã gắn nhãn";
      if (/scene-candidates/i.test(cmd)) return "Lấy ảnh bối cảnh hợp loại sản phẩm (tấm ảnh ghép)";
      if (/contact-sheet/i.test(cmd)) return "Ghép ảnh thành một tấm để xem";
      if (/prep-todo/i.test(cmd)) return "Lấy danh sách sản phẩm cần chuẩn bị";
      if (/prep-add/i.test(cmd)) return "Lưu ảnh bối cảnh đã chọn vào kho chuẩn bị";
      if (/prep-status/i.test(cmd)) return "Xem số đã chuẩn bị";
      if (/queue-from-prepared/i.test(cmd)) return "Lấy sản phẩm từ kho chuẩn bị vào hàng chờ";
      if (/queue-todo/i.test(cmd)) return "Lấy danh sách sản phẩm cần thêm vào hàng chờ";
      if (/queue-add/i.test(cmd)) return "Thêm sản phẩm vào hàng chờ (link, ảnh gốc, các ảnh bối cảnh)";
      if (/scene-get/i.test(cmd)) return "Lấy ảnh bối cảnh từ kho ảnh để xem";
      if (/scenes/i.test(cmd)) return "Xem danh sách ảnh bối cảnh trong kho";
      if (/set-reviews/i.test(cmd)) return "Lưu số review vừa đọc";
      if (/reviews-todo/i.test(cmd)) return "Lấy danh sách link cần kiểm tra review";
      if (/\bstart\b/i.test(cmd)) return "Mở dự án và bắt đầu quét";
      if (/\bknown\b/i.test(cmd)) return "Xem các link dự án đã có";
      if (/set-menu/i.test(cmd)) return "Lưu menu của web";
      if (/add-many|\badd\b/i.test(cmd)) return "Lưu sản phẩm đã quét vào bảng";
      if (/\bfinish\b/i.test(cmd)) return "Tổng kết lượt quét";
      if (/set-used/i.test(cmd)) return "Đánh dấu link đã dùng";
      return "Kiểm tra bảng dự án";
    }
    if (/register-image/i.test(cmd)) return "Lưu ảnh Flow vừa tạo vào kết quả";
    if (/flow-brief/i.test(cmd)) return "Chuẩn bị nội dung gửi Flow cho sản phẩm";
    if (/set-sign-text/i.test(cmd)) return "Lưu chữ trên biển đã chọn cho sản phẩm";
    if (/sign-brief/i.test(cmd)) return "Chọn chữ trên biển theo cảnh";
    if (/agent\.ps1\s+(review-brief|write-review)/i.test(cmd)) return "Ghi review cho sản phẩm";
    if (/agent\.ps1\s+finish/i.test(cmd)) return "Hoàn tất sản phẩm (tải kết quả)";
    if (/flow-pace\.mjs\s+gate/i.test(cmd)) return "Chờ nhịp gửi prompt Flow";
    if (/flow-pace\.mjs\s+download-lock/i.test(cmd)) return "Khóa / mở khóa tải ảnh";
    return "Chạy lệnh của công cụ";
  }
  if (n === "Read") return /contact-sheets/i.test(cmd) ? "Xem tấm ảnh ghép (nhiều ảnh một lần)" : /\.(png|jpe?g|webp)$/i.test(cmd) ? "Xem ảnh sản phẩm / ảnh bối cảnh" : "Đọc dữ liệu của lượt chạy";
  if (n === "Write" || n === "Edit") return "Ghi file tạm của lượt chạy";
  return "Đang xử lý: " + n;
}

// Playwright MCP on the tool's OWN Chrome profile (workspace/chrome-profile, signed in to Google by the person once). Never the
// person's real Chrome, never --extension. A normal visible Chrome window by default (Google Flow flagged headless runs as "unusual activity"); PR_FLOW_HEADLESS=1 runs it in the background. This temp file is the only config.
// extension = { profile: "Profile 1", name, color }: the person's everyday Chrome through the Playwright extension (the Chrome window of that
// profile must be open; the person clicks Connect). The run's tabs go into one named Chrome tab group.
// extension.background (default true): false for Flow image runs. Google Flow flagged prompts submitted in a hidden (background) tab as
// "unusual activity" (2026-11-23), so a Flow run keeps the old visible-tab behaviour; scan / reviews runs stay in the background.
export function mcpConfig({ plat = osPlatform(), profile, headless = true, extension = null } = {}) {
  if (extension) {
    // Background mode (PLAYWRIGHT_MCP_BACKGROUND=1 = the --background flag of Playwright MCP 0.0.86+, checked in its cdpRelay/browserModel
    // source; the env var is used because an older cached version would refuse an unknown flag): Page.bringToFront / Target.activateTarget become
    // no-ops (page.bringToFront() and browser_tabs select never raise Chrome), new tabs open with active:false, the extension skips its
    // chrome.windows.update({ focused: true }) after Connect, and with a token the Connect page opens with --open-in-background. Without it
    // every run pulled Chrome to the front while the person worked in other apps (worse with several windows running).
    const a = ["@playwright/mcp@latest", "--extension", ...(extension.profile ? ["--profile-dir-name", extension.profile] : []), "--session-name", extension.name || "Product Review", "--session-color", extension.color || "blue"];
    const server = plat === "win32" ? { command: "cmd", args: ["/c", "npx", ...a] } : { command: "npx", args: a };
    server.env = { ...(extension.profile ? { PLAYWRIGHT_MCP_PROFILE_DIR_NAME: extension.profile } : {}), ...(extension.background === false ? {} : { PLAYWRIGHT_MCP_BACKGROUND: "1" }) };
    return { mcpServers: { playwright: server } };
  }
  if (!profile) throw new Error("mcpConfig needs the own Chrome profile folder.");
  const args = ["@playwright/mcp@latest", "--browser", "chrome", "--user-data-dir", profile, ...(headless ? ["--headless"] : []), "--viewport-size", `${WINDOW_SIZE.width}x${WINDOW_SIZE.height}`];
  const server = plat === "win32" ? { command: "cmd", args: ["/c", "npx", ...args] } : { command: "npx", args };
  return { mcpServers: { playwright: server } };
}

// Note put in front of the prompt when the run drives the person's everyday Chrome (extension mode).
// tokenSet: a Playwright extension token is saved for this profile, so the extension connects by itself (no Connect click to wait for).
export const extensionNote = ({ groupName = "Product Review", session = "default", downloadsDir = "", tokenSet = false, flow = false } = {}) => flowFocus(flow, (tokenSet
  ? `RUN-NOW NOTE: this run uses the person's everyday Chrome through the Playwright extension. The extension token of this Chrome profile is set, so the connection is AUTOMATIC: there is no Connect click and nobody needs to click anything. Your tabs go into the Chrome tab group named "${groupName}" (session "${session}").
If the browser tools fail at the start: the Chrome window of that profile may still be opening; call browser_tabs about every 10 seconds for up to 1 minute. Still nothing: stop and report that Chrome did not connect (CAUSE:BROWSER; the saved token may be outdated: the person can save the current one or clear it in the app).`
  : `RUN-NOW NOTE: this run uses the person's everyday Chrome through the Playwright extension, so the person is at the computer and will click Connect in Chrome. Your tabs go into the Chrome tab group named "${groupName}" (session "${session}").
If browser_tabs shows only a Welcome / connect.html tab, or the browser tools fail: the Playwright MCP has ALREADY opened that page, do NOT open a second copy and do not bring it to the front; tell the person in one line to click Connect in Chrome. Then wait up to 3 minutes, calling browser_tabs about every 15 seconds, until a real page tab appears. If nothing connects, stop and report that Chrome did not connect (CAUSE:BROWSER).`) + `
NEVER STEAL FOCUS: the person keeps working in other apps (often with several windows of this tool running). Never bring Chrome to the front, focus or activate a tab or window: no page.bringToFront, no browser_tabs select just to show a tab, no new windows. Your tabs run in the background in their tab group and a hidden tab is normal. Wait with page.waitForTimeout (Node side), never requestAnimationFrame or page-side timer loops; scroll with window.scrollBy, never page.mouse.wheel. If a click times out on "element is not stable" (a background tab gets no animation frames), do that click in browser_run_code_unsafe with locator.click({ force: true }); uploads (setInputFiles), typing and downloads work in the background.
CLEAN UP FIRST (once, at the very start): close only leftover tabs that clearly belong to an OLD Chrome tab group of this same session (a group whose title starts with "Product Review · ${session} ·" but is not "${groupName}"). Never close any other tab, never touch the person's own tabs; if you cannot tell which tabs belong to an old group, close nothing.
Downloads (the Downloads folder is shared by EVERY window of this machine, so two windows must never download at the same moment): around EACH download hold the machine-wide download lock: "node core/flow-pace.mjs download-lock acquire --tag <item id>" (it blocks until free), click the download button, move the NEW file from the Downloads folder AT ONCE into ${downloadsDir || "your own session folder"} and rename it "<item id>.<ext>", check it is the right picture (expected size, the prompt tile you submitted), then "node core/flow-pace.mjs download-lock release --tag <item id>". Never take a file you did not just download yourself. This mode cannot use download.saveAs.
HUMAN PACING: before EVERY prompt you submit in Google Flow run: node core/flow-pace.mjs gate --tag <item id> (it waits the human-like time by itself; submit right after it returns; never several prompts behind one gate).

`);
// Flow runs: the Flow tab must be VISIBLE while working in it (Google flags actions in a hidden tab); every other run never takes focus.
const FLOW_FOCUS = "FLOW TAB VISIBLE (Google Flow flags work done in a hidden tab as unusual activity): this run is NOT in background mode. Before you upload, type, submit or download in Google Flow, make the Flow tab the visible tab with page.bringToFront() (in browser_run_code_unsafe) and keep it visible until that action is done. Use ONE Flow tab; open no new windows; outside Flow do not focus anything else.";
const flowFocus = (flow, text) => (flow ? text.replace(/^NEVER STEAL FOCUS:.*$/m, FLOW_FOCUS) : text);
// Extension mode only works on a profile that HAS the Playwright MCP Bridge extension: otherwise the MCP silently uses "the last used profile that
// has it". So a chosen profile without the extension (or missing) refuses to start; another profile is never used instead.
// The Google account chosen for Flow (workspace/config/run-settings.json flowAccount), "" when none.
// PER SESSION: the Flow account of THIS window (its workspace/config/run-settings.json, seeded from the default session's file).
export function readFlowAccount(workspaceDir, seedDir = "") {
  try {
    const f = (d) => join(d, "config", "run-settings.json");
    const e = String(readSeededJson(f(workspaceDir), seedDir ? f(seedDir) : "", {}).flowAccount || "");
    return /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/.test(e) ? e : "";
  } catch { return ""; }
}
export function checkExtensionProfile(profile, { profiles = localChromeProfiles().profiles, account = "" } = {}) {
  const p = profiles.find((x) => x.folder === profile);
  if (!p) return { ok: false, error: `Profile Chrome "${profile}" không có trên máy này. Chọn profile khác ở ô trình duyệt.` };
  if (!p.playwright_extension) return { ok: false, error: `Profile ${profile}${p.email ? " (" + p.email + ")" : ""} chưa có extension Playwright MCP Bridge. Cài extension vào profile đó (nút "Cài extension vào profile này") hoặc chọn profile khác; tool không dùng profile khác thay thế.` };
  const want = String(account || "").toLowerCase();
  if (want && !(p.accounts || []).includes(want)) return { ok: false, error: `Tài khoản ${account} không đăng nhập trong profile ${profile}${p.email ? " (" + p.email + ")" : ""} (có: ${(p.accounts || []).join(", ") || "không có tài khoản nào"}). Chọn tài khoản khác ở ô tài khoản Flow hoặc đăng nhập tài khoản đó vào profile này.` };
  return { ok: true };
}
// A random suffix: two windows starting in the same second never share a run id (it names output folders, logs and the files copied to Downloads).
export const newRunId = (d = new Date()) => "agent-" + d.toISOString().replace(/\D/g, "").slice(0, 14) + "-" + Math.random().toString(16).slice(2, 6);

// The text block of docs/agent-prompt.md (mode "flow") or docs/scan-prompt.md (mode "scan"), placeholders filled.
export const PROMPT_FILES = { flow: "agent-prompt.md", scan: "scan-prompt.md", reviews: "reviews-count-prompt.md", queue: "queue-prompt.md", prep: "prep-prompt.md", index: "index-prompt.md" };
export function buildPrompt({ toolRoot, run, options = "defaults", mode = "flow", site = "", max = 20, project = "", workspace = "" }) {
  const file = PROMPT_FILES[mode];
  if (!file) throw new Error("Unknown run mode: " + mode);
  const md = readFileSync(join(toolRoot, "docs", file), "utf8");
  const m = md.match(/```text\r?\n([\s\S]*?)\r?\n```/);
  if (!m) throw new Error(`docs/${file} has no text block.`);
  let acct = ""; // the Google account Flow must use (run-settings.json flowAccount, set in the app); only the image (flow) run opens Flow
  if (mode === "flow") acct = readFlowAccount(workspace || join(toolRoot, "workspace"), join(toolRoot, "workspace"));
  const acctText = acct ? `\nGOOGLE ACCOUNT FOR FLOW: use ONLY the already signed-in Google account ${acct}. The profile may hold several Google accounts and Flow opens the first one. Before creating the project open https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fflow.google.com%2F and click THAT email (no password is needed for a signed-in account); on Flow check the avatar menu shows the same email. If that email is not in the list, or Flow says the credits are used up on it: STOP and report. Never sign out, never remove or add an account, never use another account.` : "";
  return m[1].replace(/\{\{TOOL\}\}/g, toolRoot).replace(/\{\{RUN\}\}/g, run).replace(/\{\{OPTIONS\}\}/g, options)
    .replace(/\{\{SITE\}\}/g, site).replace(/\{\{MAX\}\}/g, String(max)).replace(/\{\{PROJECT\}\}/g, project) + acctText;
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

export function createAgentRunner({ toolRoot, workspace, profileDir = join(workspace, "chrome-profile"), headless = process.env.PR_FLOW_HEADLESS === "1", getBrowser = () => ({ mode: "extension", profile: "Profile 1" }), session = "", kind = "main", checkProfile = checkExtensionProfile, findCli = findClaude, plat = osPlatform(), spawnFn = spawn, killTree = (c) => defaultKill(c, plat), npxOk = () => defaultNpx(plat), now = () => Date.now(), graceMs = 4000, minutes = DEFAULT_MINUTES, maxTurns = 0 }) {
  const runsDir = join(workspace, "runs"), tmpDir = join(workspace, "tmp");
  // Two runner instances per server: "main" (Flow images + reviews, scan, review count) and "light" (queue, prep: no browser). Own state and log files,
  // so a prep / queue run goes on while Bắt đầu runs; two light runs at once stay forbidden (each runner is one run at a time).
  const stateName = kind === "light" ? "prep-run" : "agent-run";
  const stateFile = join(runsDir, stateName + ".json"), logFile = join(runsDir, stateName + ".log");
  let cur = null, last = null;

  const readState = () => { try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch { return null; } };
  const saveState = (st) => { try { mkdirSync(runsDir, { recursive: true }); writeFileSync(stateFile, JSON.stringify(st, null, 2)); } catch {} };
  const touch = (run, patch = {}) => { Object.assign(run.state, patch, { updated: new Date(now()).toISOString() }); saveState(run.state); };
  const addLine = (run, text) => {
    let line = sanitize(text); if (!line) return;
    // Same step twice in a row: one line with a count, not a wall of repeats.
    if (run.prev === line) { run.repeat = (run.repeat || 1) + 1; run.lines[run.lines.length - 1] = run.stamp + " " + line + ` (×${run.repeat})`; return; }
    run.prev = line; run.repeat = 1; run.stamp = new Date(now()).toTimeString().slice(0, 8);
    line = run.stamp + " " + (run.prefix || "") + line;
    run.lines.push(line); if (run.lines.length > LOG_LINES) run.lines.splice(0, run.lines.length - LOG_LINES);
    try { mkdirSync(runsDir, { recursive: true }); if (++run.written % 500 === 0) writeFileSync(logFile, run.lines.join("\n") + "\n"); else appendFileSync(logFile, line + "\n"); } catch {}
  };
  const handleLine = (run, raw) => {
    // Not an event (a cut-off fragment, tool output): nothing a person can read, so it stays out of the log.
    let ev; try { ev = JSON.parse(raw); } catch { return; }
    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      run.state.turns = (run.state.turns || 0) + 1;
      for (const c of ev.message.content) {
        if (c.type === "text" && c.text) { addLine(run, "Claude: " + c.text); const t = sanitize(c.text); if (t) run.state.last_text = t; }
        else if (c.type === "tool_use" && typeof c.name === "string") addLine(run, friendlyTool(c.name, c.input, run.state.mode));
      }
      touch(run);
    } else if (ev.type === "result") {
      run.result = { is_error: !!ev.is_error, subtype: String(ev.subtype || "") };
      if (typeof ev.num_turns === "number") run.state.turns = ev.num_turns;
      if (typeof ev.result === "string" && ev.result) run.state.last_text = sanitize(ev.result);
      addLine(run, run.result.is_error ? `Claude báo lỗi (${run.result.subtype || "không rõ"})` : "Claude đã xử lý xong các bước");
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
    try { releaseLocks(toolRoot, session, process.pid, kind); } catch {}
    // An image run (mode "flow") that finished its process cleanly but produced nothing for ANY of its items (no image, no result) is a failed run,
    // not a success: the final state must not look like "done, 0 errors" when 0 of N items were completed.
    let nothing = "";
    if (!run.forced && code === 0 && !run.result?.is_error && run.state.mode === "flow") {
      try {
        const dir = join(workspace, "output", run.state.run_id);
        const parsed = JSON.parse(readFileSync(join(dir, "agent-items.json"), "utf8"));
        const n = (Array.isArray(parsed) ? parsed : parsed.items || []).length;
        let made = 0;
        try { made = readdirSync(join(dir, "images")).filter((x) => /\.(png|jpe?g|webp)$/i.test(x)).length; } catch {}
        let results = 0;
        try { const r = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")); results = Array.isArray(r) ? r.length : 0; } catch {}
        if (n > 0 && made === 0 && results === 0) nothing = "0/" + n + " mục hoàn tất: không có ảnh nào được tạo và không có kết quả nào. Xem lý do của từng mục trong báo cáo cuối của Claude.";
      } catch {}
    }
    const status = nothing ? "failed" : run.forced || (code === 0 && !run.result?.is_error ? "done" : "failed");
    const error = status === "failed" ? sanitize(nothing || err || run.stderr.at(-1) || (run.result?.is_error ? `Claude reported ${run.result.subtype || "an error"}.` : `Claude exited with code ${code}.`))
      : status === "timeout" ? `Stopped after the ${minutes}-minute limit.` : "";
    addLine(run, { done: "Lượt chạy kết thúc", failed: `Lượt chạy dừng vì lỗi${code === null || code === undefined ? "" : " (mã " + code + ")"}`, timeout: "Lượt chạy dừng vì quá thời gian" }[status] || `Lượt chạy: ${status}`);
    try { writeFileSync(logFile, run.lines.join("\n") + "\n"); } catch {}
    touch(run, { status, exit_code: code ?? null, error });
    last = run.state; cur = null;
  };

  // mode "flow": Google Flow images + reviews (docs/agent-prompt.md); mode "scan": Quét web (docs/scan-prompt.md, needs site and max);
  // mode "queue": put products of a project into the run queue with N scenes each (docs/queue-prompt.md, needs project and options).
  // mode "reviews": read the review number shown on each product page of a project (docs/reviews-count-prompt.md, needs project).
  // One run at a time for all: they share the one Chrome profile.
  function start({ run: runId = newRunId(), options = "defaults", mode = "flow", site = "", max = 20, project = "" } = {}) {
    if (!/^[\w.-]{3,64}$/.test(runId)) return { ok: false, status: 400, error: "Invalid run id." };
    const lightMode = LIGHT_MODES.includes(mode);
    if ((kind === "light") !== lightMode) return { ok: false, status: 400, error: `Mode ${mode} does not run on this runner.` };
    if (cur) return { ok: false, status: 409, error: `An agent run is already active (started ${cur.state.started}). Wait for it or press Stop.` };
    const found = findCli();
    if (!found?.found) return { ok: false, status: 400, error: "Claude CLI not found: install Claude Code, or set PR_CLAUDE_CLI to its path." };
    if (!lightMode && !npxOk()) return { ok: false, status: 400, error: "npx is not available (it comes with Node.js): the Playwright MCP cannot start." };
    let prompt;
    try { prompt = buildPrompt({ toolRoot, run: runId, options, mode, site, max, project, workspace }); } catch (e) { return { ok: false, status: 500, error: sanitize(e.message) }; }
    mkdirSync(tmpDir, { recursive: true }); mkdirSync(runsDir, { recursive: true });
    const cfg = join(tmpDir, `mcp-${runId}-${randomBytes(3).toString("hex")}.json`);
    const bc = lightMode ? {} : (getBrowser() || {}), ext = !lightMode && bc.mode !== "own";
    if (ext) { const chk = checkProfile(bc.profile, { account: mode === "flow" ? readFlowAccount(workspace, join(toolRoot, "workspace")) : "" }); if (!chk.ok) return { ok: false, status: 409, error: chk.error }; }
    // Sessions (several windows): the own Chrome profile and a project are used by one live session at a time.
    const holderText = (h) => "phiên \"" + sessionLabel(h.session) + "\"";
    if (!lightMode && !ext) {
      const c = claimLock(toolRoot, "chrome", "own", session, process.pid, kind);
      if (!c.ok) return { ok: false, status: 409, error: "Chrome riêng của tool đang được " + holderText(c.holder) + " dùng. Chọn Chrome thật (profile có sẵn trên máy) hoặc đợi phiên đó chạy xong." };
    }
    let projectId = project;
    if (!projectId && mode === "scan" && site) { try { projectId = new URL(site).hostname.replace(/^www\./, "").replace(/\./g, "-"); } catch {} }
    if (projectId) {
      const c = claimLock(toolRoot, "project", projectId, session, process.pid, kind);
      if (!c.ok) { releaseLocks(toolRoot, session, process.pid, kind); return { ok: false, status: 409, error: "Dự án " + projectId + " đang được " + holderText(c.holder) + " dùng. Chọn dự án khác hoặc đợi phiên đó xong để khỏi ghi đè dữ liệu của nhau." }; }
    }
    // Gắn nhãn kho ảnh: the library index is shared by every session, so one index run at a time on this machine (no two windows tagging the same photos).
    if (mode === "index") {
      const c = claimLock(toolRoot, "library", "scene-index", session, process.pid, kind);
      if (!c.ok) { releaseLocks(toolRoot, session, process.pid, kind); return { ok: false, status: 409, error: "Kho ảnh đang được " + holderText(c.holder) + " gắn nhãn. Đợi lượt đó xong." }; }
    }
    const group = ext ? takeGroup(workspace, session) : null;
    if (!lightMode) writeFileSync(cfg, JSON.stringify(mcpConfig({ plat, profile: profileDir, headless, extension: ext ? { profile: bc.profile, name: group.name, color: group.color, background: mode !== "flow" } : null })));
    if (!lightMode && !ext) mkdirSync(profileDir, { recursive: true });
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "default", ...(maxTurns > 0 ? ["--max-turns", String(maxTurns)] : []), "--allowedTools", (lightMode ? LIGHT_TOOLS : ALLOWED_TOOLS).join(","), "--add-dir", toolRoot, ...(lightMode ? ["--strict-mcp-config"] : ["--mcp-config", cfg])];
    // Optional per-profile Playwright extension token (shared workspace/playwright-tokens.json): only through this env, never in the MCP config file or a log.
    const extToken = ext ? extensionToken(join(toolRoot, "workspace"), bc.profile) : "";
    const env = { ...process.env, ...(extToken ? { PLAYWRIGHT_MCP_EXTENSION_TOKEN: extToken } : {}) };
    const cmd = plat === "win32" && /\.(cmd|bat)$/i.test(found.path) ? ["cmd", ["/c", found.path, ...args]] : [found.path, args];
    let child;
    try { child = spawnFn(cmd[0], cmd[1], { cwd: toolRoot, env, windowsHide: true, detached: false, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { try { rmSync(cfg, { force: true }); } catch {} try { releaseLocks(toolRoot, session, process.pid, kind); } catch {} return { ok: false, status: 500, error: sanitize(e.message) }; }
    const started = new Date(now()).toISOString();
    const run = { child, cfg, lines: [], buf: "", written: 0, stderr: [], ended: false, forced: "", result: null, timer: null,
      state: { run_id: runId, mode, project, pid: child.pid ?? null, started, updated: started, status: "running", exit_code: null, last_text: "", turns: 0, error: "" } };
    run.prefix = "[" + (FEATURE[mode] || mode) + (project ? " · " + project : "") + "] ";
    cur = run;
    try { writeFileSync(logFile, ""); } catch {}
    addLine(run, mode === "index" ? "Bắt đầu: Claude gắn nhãn kho ảnh bối cảnh (mã lượt " + runId + ")"
      : mode === "prep" ? "Bắt đầu: Claude chuẩn bị trước ảnh bối cảnh cho các sản phẩm của dự án " + project + " (mã lượt " + runId + ")"
      : mode === "scan" ? "Bắt đầu: Claude quét " + site + " (mã lượt " + runId + ")"
      : mode === "queue" ? "Bắt đầu: Claude thêm sản phẩm của dự án " + project + " vào hàng chờ (mã lượt " + runId + ")"
      : mode === "reviews" ? "Bắt đầu: Claude đọc số review trên các trang sản phẩm của dự án " + project + " (mã lượt " + runId + ")"
      : "Bắt đầu: Claude điều khiển Google Flow (mã lượt " + runId + ")");
    saveState(run.state);
    child.stdout?.on("data", (c) => feed(run, c));
    child.stderr?.on("data", (c) => { for (const l of c.toString("utf8").split(/\r?\n/)) { const t = sanitize(l); if (t) { run.stderr.push(t); if (run.stderr.length > 20) run.stderr.shift(); addLine(run, "Cảnh báo: " + t); } } });
    child.on("error", (e) => finish(run, null, e.message));
    child.on("close", (code) => finish(run, code));
    child.stdin?.on("error", () => {});
    const note = mode === "index"
      ? "RUN-NOW NOTE: this run only TAGS the scene photo library (no browser needed, do not open any page): look at the numbered contact sheets with the Read tool and use the scan.ps1 scene-index commands. It never touches a project, the queue or image creation.\n\n"
      : mode === "prep"
      ? "RUN-NOW NOTE: this run only PREPARES scene picks in advance (no browser needed, do not open any page): look at photos with the Read tool and use the scan.ps1 prep commands. It never touches the queue, never starts image creation and never writes review text.\n\n"
      : mode === "queue"
      ? "RUN-NOW NOTE: this run only PREPARES the queue (no browser needed, do not open any page): look at photos with the Read tool and use the scan.ps1 queue commands. It never starts image creation and never writes review text.\n\n"
      : mode === "reviews"
      ? "RUN-NOW NOTE: this run uses the tool's OWN Chrome (a dedicated profile, no sign-in needed to read a product page)" + (headless ? ", running in the background (headless)" : "") + ". There is no Connect step and no extension: ignore any instruction to click Connect or wait for the person; start with browser_tabs or browser_navigate. If a page shows a login wall or captcha, stop and report it (never sign in for the person). The run is READ ONLY: never write, submit or change any review.\n\n"
      : mode === "scan"
      ? "RUN-NOW NOTE: this run uses the tool's OWN Chrome (a dedicated profile, no sign-in needed to scan a shop)" + (headless ? ", running in the background (headless)" : "") + ". There is no Connect step and no extension: ignore any instruction to click Connect or wait for the person; start with browser_tabs or browser_navigate. If the site asks for a login or shows a captcha, stop and report it (never sign in for the person)." + "\n\n"
      : "RUN-NOW NOTE: this run uses the tool's OWN Chrome (a dedicated profile the person already signed in to Google Flow with)" + (headless ? ", running in the background (headless)" : "") + ". There is no Connect step and no extension: ignore any instruction to click Connect or wait for the person; start with browser_tabs or browser_navigate. If Flow shows a Google sign-in page, stop and report CAUSE:LOGIN (never sign in for the person)." + "\n\n";
    try { child.stdin?.end((ext && mode !== "queue" ? extensionNote({ groupName: group.name, session: sessionLabel(session), downloadsDir: join(workspace, "tmp", "flow-downloads"), tokenSet: !!extToken, flow: mode === "flow" }) : note) + prompt); } catch {}
    if (minutes > 0) run.timer = setTimeout(() => { if (run.ended) return; run.forced = "timeout"; killTree(child); setTimeout(() => finish(run, null), graceMs).unref?.(); }, minutes * 60000);
    run.timer?.unref?.();
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
      active: !!run, status: shown?.status || "idle", run_id: shown?.run_id || "", mode: shown?.mode || "flow", project: shown?.project || "", started: shown?.started || "",
      elapsed_s: shown?.started ? Math.max(0, Math.round(((run ? now() : Date.parse(shown.updated) || now()) - Date.parse(shown.started)) / 1000)) : 0,
      last_text: shown?.last_text || "", turns: shown?.turns || 0, error: shown?.error || "", updated: shown?.updated || "", tail: lines.slice(-TAIL_LINES),
    };
  }
  return { start, stop, status, shutdown, isActive: () => !!cur };
}

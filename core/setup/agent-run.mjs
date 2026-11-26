// Agent mode: starts Claude Code headless (`claude -p`) to drive Google Flow (Playwright MCP) and write the reviews.
// One run at a time (one browser, one agent). The prompt goes to STDIN, never argv. Nothing secret is stored: only assistant
// text and tool NAMES are kept, scrubbed and cut (never tool inputs or results).
import { spawn, spawnSync, execFileSync, execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { platform as osPlatform, tmpdir, homedir } from "node:os";
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
// ctx / rev = the no-browser PHASE workers of an image run with Luồng above 1 (context + sign wording, review writing); they work on a slice of its items.
export const LIGHT_MODES = ["queue", "prep", "index", "ctx", "rev"];
// The name of each feature as the person knows it: every log line of a run starts with [feature · project].
export const FEATURE = { flow: "Tạo ảnh & review (Bắt đầu)", scan: "Quét web", reviews: "Cập nhật số review", queue: "Thêm vào hàng chờ", prep: "Chuẩn bị trước", index: "Gắn nhãn kho ảnh", ctx: "Ngữ cảnh ảnh", rev: "Viết review" };

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
export function friendlyTool(name, input = {}, mode = "flow", ai = "") {
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
    // Every per-item step names its item ("Mục 035 · ...") so the progress line tells at a glance what is happening to which item.
    const item = (cmd.match(/-Item\s+["']?(\d{3})/i) || cmd.match(/--tag\s+["']?(\d{3})/i) || [])[1];
    const m = (t) => (item ? `Mục ${item} · ${t}` : t);
    const agy = ai === "antigravity"; // Antigravity makes the pictures itself: no Flow in the wording
    if (/register-image/i.test(cmd)) return m(/-SignRead/i.test(cmd) ? (agy ? "Lưu ảnh + kiểm chữ trên biển" : "Lưu ảnh Flow + kiểm chữ trên biển") : (agy ? "Lưu ảnh vừa tạo vào kết quả" : "Lưu ảnh Flow vừa tạo vào kết quả"));
    if (/flow-brief/i.test(cmd)) return m(/-Safe/i.test(cmd) ? (agy ? "Ảnh bị từ chối → thử lại 1 lần bằng mô tả an toàn" : "Flow từ chối → thử lại 1 lần bằng mô tả an toàn") : (agy ? "Chuẩn bị nội dung tạo ảnh" : "Chuẩn bị nội dung gửi Flow"));
    if (/set-sign-text/i.test(cmd)) return m("Lưu chữ trên biển đã chọn");
    if (/sign-brief/i.test(cmd)) return m("Chọn chữ trên biển theo cảnh");
    if (/agent\.ps1\s+context-brief/i.test(cmd)) return m("Xem ảnh để lập ngữ cảnh");
    if (/agent\.ps1\s+context\b/i.test(cmd)) return m("Lưu ngữ cảnh sản phẩm");
    if (/agent\.ps1\s+(review-brief|write-review)/i.test(cmd)) return m("Viết review");
    if (/agent\.ps1\s+finish/i.test(cmd)) return m("Hoàn tất (tải kết quả lên kho)");
    if (/flow-pace\.mjs\s+gate/i.test(cmd)) return m("Chờ nhịp rồi gửi prompt Flow");
    if (/flow-pace\.mjs\s+download-lock/i.test(cmd)) return "Khóa / mở khóa tải ảnh";
    return "Chạy lệnh của công cụ";
  }
  if (n === "Read") return /contact-sheets/i.test(cmd) ? "Xem tấm ảnh ghép (nhiều ảnh một lần)" : /\.(png|jpe?g|webp)$/i.test(cmd) ? "Xem ảnh sản phẩm / ảnh bối cảnh" : "Đọc dữ liệu của lượt chạy";
  if (n === "AgyImage") return input?.count > 1 ? `Antigravity tạo ${input.count} ảnh cùng lúc` : "Antigravity tạo ảnh";
  if (n === "Write" || n === "Edit") return "Ghi file tạm của lượt chạy";
  return "Đang xử lý: " + n;
}

// Playwright MCP on the tool's OWN Chrome profile (workspace/chrome-profile, signed in to Google by the person once). Never the
// person's real Chrome, never --extension. A normal visible Chrome window by default (Google Flow flagged headless runs as "unusual activity"); PR_FLOW_HEADLESS=1 runs it in the background. This temp file is the only config.
// extension = { profile: "Profile 1", name, color }: the person's everyday Chrome through the Playwright extension (the Chrome window of that
// profile must be open; the person clicks Connect). The run's tabs go into one named Chrome tab group.
// No background mode (reverted 2026-11-23 at the user's request): with PLAYWRIGHT_MCP_BACKGROUND=1 Google Flow flagged prompts sent in a
// hidden tab as "unusual activity" and pages rendered nothing hidden. Runs bring their tab to the front again, as before.
export function mcpConfig({ plat = osPlatform(), profile, headless = true, extension = null } = {}) {
  if (extension) {
    // Background mode (PLAYWRIGHT_MCP_BACKGROUND=1 = the --background flag of Playwright MCP 0.0.86+, checked in its cdpRelay/browserModel
    // source; the env var is used because an older cached version would refuse an unknown flag): Page.bringToFront / Target.activateTarget become
    // no-ops (page.bringToFront() and browser_tabs select never raise Chrome), new tabs open with active:false, the extension skips its
    // chrome.windows.update({ focused: true }) after Connect, and with a token the Connect page opens with --open-in-background. Without it
    // every run pulled Chrome to the front while the person worked in other apps (worse with several windows running).
    const a = ["@playwright/mcp@latest", "--extension", ...(extension.profile ? ["--profile-dir-name", extension.profile] : []), "--session-name", extension.name || "Product Review", "--session-color", extension.color || "blue"];
    const server = plat === "win32" ? { command: "cmd", args: ["/c", "npx", ...a] } : { command: "npx", args: a };
    server.env = { ...(extension.profile ? { PLAYWRIGHT_MCP_PROFILE_DIR_NAME: extension.profile } : {}), };
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
CLEAN UP FIRST (once, at the very start): close only leftover tabs that clearly belong to an OLD Chrome tab group of this same session (a group whose title starts with "Product Review · ${session} ·" but is not "${groupName}"). Never close any other tab, never touch the person's own tabs; if you cannot tell which tabs belong to an old group, close nothing.
Downloads (the Downloads folder is shared by EVERY window of this machine, so two windows must never download at the same moment): around EACH download hold the machine-wide download lock: "node core/flow-pace.mjs download-lock acquire --tag <item id>" (it blocks until free), click the download button, move the NEW file from the Downloads folder AT ONCE into ${downloadsDir || "your own session folder"} and rename it "<item id>.<ext>", check it is the right picture (expected size, the prompt tile you submitted), then "node core/flow-pace.mjs download-lock release --tag <item id>". Never take a file you did not just download yourself. This mode cannot use download.saveAs.
HUMAN PACING: before EVERY prompt you submit in Google Flow run: node core/flow-pace.mjs gate --tag <item id> (it waits the human-like time by itself; submit right after it returns; never several prompts behind one gate).

`);
// Flow runs: the Flow tab must be VISIBLE while working in it (Google flags actions in a hidden tab); every other run never takes focus.
const flowFocus = (_flow, text) => text;
// Extension mode only works on a profile that HAS the Playwright MCP Bridge extension: otherwise the MCP silently uses "the last used profile that
// has it". So a chosen profile without the extension (or missing) refuses to start; another profile is never used instead.
// The Google account chosen for Flow (workspace/config/run-settings.json flowAccount), "" when none.
// PER SESSION: the Flow account of THIS window (its workspace/config/run-settings.json, seeded from the default session's file).
// The Claude model + effort of this window (run-settings.json claudeModel: any listed alias / full id or a custom id, DEFAULT claude-sonnet-4-6;
// claudeEffort: a `claude --effort` level, "" = no flag). The value is passed to `claude --model` exactly as stored.
export const CLAUDE_DEFAULT_MODEL = "claude-sonnet-4-6";
export const CLAUDE_MODEL_RE = /^[A-Za-z0-9._\-\[\]]{1,60}$/;
const fam = (name, note, items) => ({ family: name, note, models: items.map(([id, label]) => ({ id, label })) });
// All ids verified with `claude --model <id>` on CLI 2.1.323. Not offered: claude-opus-4-1 / -4-0 (remapped), claude-sonnet-4-0 (retired), claude-haiku-3-5 (unknown).
export const CLAUDE_MODEL_GROUPS = [
  fam("Fable", "Mạnh nhất, cho việc khó và chạy lâu", [["fable", "Fable mới nhất · fable"], ["claude-fable-5-2", "Fable 5.2 · claude-fable-5-2"], ["claude-fable-5-1", "Fable 5.1 · claude-fable-5-1"], ["claude-fable-5", "Fable 5 · claude-fable-5"]]),
  fam("Opus", "Tốt cho việc phức tạp hằng ngày", [["opus", "Opus mới nhất · opus"], ["claude-opus-5-5", "Opus 5.5 · claude-opus-5-5"], ["claude-opus-5", "Opus 5 · claude-opus-5"], ["claude-opus-4-8", "Opus 4.8 · claude-opus-4-8"], ["claude-opus-4-7", "Opus 4.7 · claude-opus-4-7"], ["claude-opus-4-6", "Opus 4.6 · claude-opus-4-6"], ["claude-opus-4-5", "Opus 4.5 · claude-opus-4-5"]]),
  fam("Sonnet", "Nhẹ, cho việc thường ngày", [["sonnet", "Sonnet mới nhất · sonnet"], ["claude-sonnet-5-5", "Sonnet 5.5 · claude-sonnet-5-5"], ["claude-sonnet-5", "Sonnet 5 · claude-sonnet-5"], ["claude-sonnet-4-6", "Sonnet 4.6 · claude-sonnet-4-6"], ["claude-sonnet-4-5", "Sonnet 4.5 · claude-sonnet-4-5"]]),
  fam("Haiku", "Nhẹ, cho việc thường ngày", [["haiku", "Haiku mới nhất · haiku"], ["claude-haiku-5-5", "Haiku 5.5 · claude-haiku-5-5"], ["claude-haiku-4-5", "Haiku 4.5 · claude-haiku-4-5"]]),
];
export const CLAUDE_MODELS = CLAUDE_MODEL_GROUPS.flatMap((g) => g.models.map((m) => m.id));
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const isClaudeModel = (v) => typeof v === "string" && CLAUDE_MODEL_RE.test(v);
export function readClaudeSettings(workspaceDir, seedDir = "") {
  try {
    const f = (d) => join(d, "config", "run-settings.json");
    const s = readSeededJson(f(workspaceDir), seedDir ? f(seedDir) : "", {});
    return { model: isClaudeModel(s.claudeModel) ? s.claudeModel : CLAUDE_DEFAULT_MODEL, effort: CLAUDE_EFFORTS.includes(s.claudeEffort) ? s.claudeEffort : "" };
  } catch { return { model: CLAUDE_DEFAULT_MODEL, effort: "" }; }
}
// The first line of every Claude run: the model the CLI REPORTS as running (init event), with a friendly name from CLAUDE_MODEL_GROUPS.
const EFFORT_VI = { low: "thấp", medium: "vừa", high: "cao", xhigh: "rất cao", max: "tối đa" };
export function claudeModelName(id) {
  for (const g of CLAUDE_MODEL_GROUPS) { const m = g.models.find((x) => x.id === id); if (m) return m.label.split(" · ")[0]; }
  return "";
}
export function modelLineText(id, effort, provisional = false, backend = "claude") {
  const agy = backend === "antigravity", name = agy ? "" : claudeModelName(id);
  return "Model đang dùng: " + (id || (agy ? "mặc định của Antigravity" : "")) + (name && name !== id ? " (" + name + ")" : "") + " · mức suy nghĩ: " + (EFFORT_VI[effort] || "mặc định") + (provisional ? ` (theo cài đặt, đang chờ ${AGENT_NAME[backend] || "Claude"} xác nhận)` : "");
}
// The setting may be an alias ("haiku") or carry a suffix ("[1m]"): that still counts as the same model.
export function modelMatches(asked, actual) {
  if (!asked || !actual) return true;
  const a = String(asked).replace(/\[.*\]$/, ""), b = String(actual).replace(/\[.*\]$/, "");
  return a === b || b.includes(a);
}
// ---- Agent backend: "claude" (Claude Code CLI) or "antigravity" (Google Antigravity CLI `agy`), chosen in Cấu hình (run-settings.json agentBackend).
// One runner serves both: only the spawn line, the per-run MCP wiring and the stream parser differ.
export const AGENT_BACKENDS = ["claude", "antigravity"];
export const AGENT_NAME = { claude: "Claude", antigravity: "Antigravity" };
export const AGY_MODEL_RE = /^[A-Za-z0-9._\-]{1,60}$/;
// agy rejects "max" on its models (the default gemini-4-neon only has low..xhigh), so it is not offered.
export const AGY_EFFORTS = ["low", "medium", "high", "xhigh"];
// "" = no --model flag: agy uses its own default and the run reports the model agy says it runs (init event).
export const AGY_DEFAULT_MODEL = "";
// The plugin + server name of the per-run Playwright MCP; agy exposes its tools as call_mcp_tool(ServerName "<plugin>_<server>", ToolName "browser_*").
export const AGY_PLUGIN = "prreview", AGY_SERVER = "flow", AGY_MCP_SERVER = AGY_PLUGIN + "_" + AGY_SERVER;
// Checked with `agy models` on agy 1.5.16; used only when the live list cannot be read.
const AGY_FALLBACK = [
  ["gemini-4-neon-high", "Gemini 4 Neon (High)"], ["gemini-4-neon-xhigh", "Gemini 4 Neon (XHigh)"], ["gemini-4-neon-medium", "Gemini 4 Neon (Medium)"], ["gemini-4-neon-low", "Gemini 4 Neon (Low)"],
  ["gemini-4-carbon-high", "Gemini 4 Carbon (High)"], ["gemini-4-carbon-medium", "Gemini 4 Carbon (Medium)"], ["gemini-4-carbon-low", "Gemini 4 Carbon (Low)"],
  ["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["gemini-4-argon-medium", "Gemini 4 Argon (Medium)"], ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
  ["gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"], ["gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (XHigh)"], ["gemini-4-hydrogen-medium", "Gemini 4 Hydrogen (Medium)"], ["gemini-4-hydrogen-low", "Gemini 4 Hydrogen (Low)"],
  ["gemini-pro-orchestrator-neon", "Orchestrator (Neon)"], ["gemini-pro-orchestrator", "Orchestrator (Carbon)"], ["gemini-pro-orchestrator-argon", "Orchestrator (Argon)"],
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"], ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"], ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"], ["claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"], ["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
];
// Same shape as CLAUDE_MODEL_GROUPS: [{family, note, models:[{id,label}]}], grouped by the model family in its id.
export function groupAgyModels(pairs) {
  const fams = [["Gemini 4", /^gemini-4-/, "Gemini mới nhất, mức suy nghĩ nằm trong tên model"], ["Orchestrator", /orchestrator/, "Điều phối nhiều bước"], ["Gemini 3.8", /^gemini-3/, "Nhẹ, nhanh"], ["Claude", /^claude-/, "Claude chạy qua Antigravity"], ["Khác", /./, ""]];
  const out = fams.map(([family, re, note]) => ({ family, re, note, models: [] }));
  // Flash Low / Medium are the fast ones for browser-driving work ("nhanh"); every High / XHigh model thinks for minutes per step.
  const FAST = /flash-(low|medium)$/, order = (id) => (FAST.test(id) ? 0 : 1);
  for (const [id, name] of pairs) { const g = out.find((f) => f.re.test(id)); g.models.push({ id, label: `${FAST.test(id) ? "nhanh · " : ""}${name} · ${id}` }); }
  for (const g of out) g.models.sort((a, b) => order(a.id) - order(b.id));
  out.sort((a, b) => (/^Gemini 3/.test(a.family) ? -1 : 0) - (/^Gemini 3/.test(b.family) ? -1 : 0));
  return out.filter((g) => g.models.length).map(({ family, note, models }) => ({ family, note: /^Gemini 3/.test(family) ? "Nhanh: hợp việc điều khiển trình duyệt" : /^Gemini 4/.test(family) ? "Mạnh hơn nhưng chậm: High / XHigh mất vài phút mỗi bước" : note, models }));
}
export function parseAgyModels(text) {
  const pairs = [];
  for (const line of String(text || "").split(/\r?\n/)) { const m = line.match(/^([A-Za-z0-9._-]+)\t+(.+?)\s*$/); if (m && AGY_MODEL_RE.test(m[1])) pairs.push([m[1], m[2]]); }
  return pairs;
}
let agyModelCache = { at: 0, groups: null };
// `agy models` (live, cached 10 minutes); the static list when agy is missing, not signed in or too slow.
export async function listAgyModels({ find = () => findAgy(), run = (path) => new Promise((res, rej) => execFile(path, ["models"], { timeout: 20000, windowsHide: true, encoding: "utf8" }, (e, out) => (e ? rej(e) : res(out)))), now = Date.now(), force = false } = {}) {
  if (!force && agyModelCache.groups && now - agyModelCache.at < 600000) return agyModelCache.groups;
  try {
    const found = find();
    if (found?.found) { const pairs = parseAgyModels(await run(found.path)); if (pairs.length) { agyModelCache = { at: now, groups: groupAgyModels(pairs) }; return agyModelCache.groups; } }
  } catch {}
  return groupAgyModels(AGY_FALLBACK);
}
// A dropped connection to agy ("the connection to the agent was interrupted", "conversation update stream lost", "subscriber fell behind updates"): transient transport trouble, NOT a quota or
// login error. The run is started again by itself (backoff 15 s / 30 s / 60 s, at most 5 times in a row; the count restarts when the run made progress in between).
export const isTransientAgyError = (t) => /connection to the agent was interrupted|update stream lost|subscriber fell behind|stream lost|stalled for \d+s|ECONNRESET|EPIPE|unexpected EOF|deadline exceeded|\bunavailable\b|connection (reset|closed|refused)/i.test(String(t || "")) && !/RESOURCE_EXHAUSTED|exhausted your capacity/i.test(String(t || ""));
export const isAgyModel = (v) => typeof v === "string" && AGY_MODEL_RE.test(v);
// Which AI runs which task (Cấu hình, Cách chạy): the image run follows Tạo ảnh (agentBackend); Quét web, Cập nhật số review and the no-browser
// queue / prep / index runs have their own key. A window saved before these keys existed keeps working: a missing key falls back to the old agentBackend.
// Codex cannot run these: the runner only starts the Claude or the Antigravity CLI.
export const AGENT_TASK_KEY = { flow: "agentBackend", scan: "scanAgent", reviews: "reviewsAgent", queue: "queueAgent", prep: "queueAgent", index: "queueAgent" };
// Luồng (run-settings.json threads, 1-4, default 1 here): how many pictures an Antigravity image run makes at once (Claude (Flow) ignores it: Flow pacing).
export function readThreads(workspaceDir, seedDir = "") {
  try {
    const f = (d) => join(d, "config", "run-settings.json");
    const n = Number(readSeededJson(f(workspaceDir), seedDir ? f(seedDir) : "", {}).threads);
    return Number.isInteger(n) && n >= 1 && n <= 4 ? n : 1;
  } catch { return 1; }
}
export function readAgentSettings(workspaceDir, seedDir = "", mode = "flow") {
  try {
    const f = (d) => join(d, "config", "run-settings.json");
    const s = readSeededJson(f(workspaceDir), seedDir ? f(seedDir) : "", {});
    const legacy = AGENT_BACKENDS.includes(s.agentBackend) ? s.agentBackend : "claude", own = s[AGENT_TASK_KEY[mode] || "agentBackend"];
    return { backend: AGENT_BACKENDS.includes(own) ? own : legacy, agyModel: isAgyModel(s.agyModel) ? s.agyModel : AGY_DEFAULT_MODEL, agyEffort: AGY_EFFORTS.includes(s.agyEffort) ? s.agyEffort : "", agyImages: s.agyImages === "flow" ? "flow" : "self" };
  } catch { return { backend: "claude", agyModel: AGY_DEFAULT_MODEL, agyEffort: "", agyImages: "self" }; }
}
// The Antigravity CLI: env PR_AGY_CLI, else the first `agy` on PATH, else its default install folders.
export function findAgy(plat = osPlatform()) {
  const given = process.env.PR_AGY_CLI;
  if (given && existsSync(given)) return { found: true, path: given };
  try {
    const out = execFileSync(plat === "win32" ? "where" : "which", ["agy"], { encoding: "utf8", windowsHide: true, timeout: 10000 }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const pick = (plat === "win32" && out.find((p) => /\.(exe|cmd|bat)$/i.test(p))) || out[0];
    if (pick) return { found: true, path: pick };
  } catch {}
  for (const p of [join(homedir(), ".local", "bin", "agy"), join(homedir(), ".local", "bin", "agy.exe"), ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe")] : [])]) if (existsSync(p)) return { found: true, path: p };
  return { found: false, path: "" };
}
// What agy's tool events become for friendlyTool(): the same names the Claude path shows. Only the command / path / MCP tool name are read, never stored.
export function agyToolToClaude(name, params = {}) {
  const n = String(name || "");
  if (n === "call_mcp_tool") return { name: String(params.ToolName || "mcp"), input: {} };
  if (n === "invoke_subagent" || n === "generate_image") return { name: "AgyImage", input: { count: Math.max(1, Number(params.count) || 1) } };
  if (n === "run_command") return { name: "Bash", input: { command: String(params.CommandLine || "") } };
  if (n === "read_file" || n === "view_file") return { name: "Read", input: { file_path: String(params.Path || params.AbsolutePath || "") } };
  if (["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file"].includes(n)) return { name: "Write", input: {} };
  return { name: n, input: {} };
}
// agy's OWN browser / image / web tools must never run a Flow or scan run: the Playwright MCP is the only browser (one browser = one agent, visible tab rule).
export const AGY_FORBIDDEN_TOOL = /^(browser_|open_browser_url$|capture_browser|execute_browser_javascript$|list_browser_pages$|read_browser_page$|click_browser_pixel$|generate_image$|search_web$|read_url_content$)/;
// Image run (Tạo ảnh = Antigravity): no browser at all; the picture comes from agy's built-in image-generator subagent.
export const agyImageNote = `ANTIGRAVITY TOOL MAP (you are Antigravity, not Claude; the task below uses Claude's tool names, use yours):
- "Bash" = run_command (a PowerShell on Windows: write the powershell / node commands exactly as given, from the TOOL folder).
- "Read" = view_file (also for photos: LOOK at them); "Write" / "Edit" = write_to_file / replace_file_content, only for the temp files the steps ask for.
- FOREGROUND ONLY: do every step in the foreground, one command at a time. Never use manage_task, background tasks, schedule or timer / wait tools for the work (they leave you idle for minutes); wait only through the task's own commands.
- This run has NO browser and no Google Flow: never call browser_* tools, never use call_mcp_tool, search_web or read_url_content. Images are made ONLY by invoke_subagent with type_name image-generator (any other subagent stops the run).

`;
// Put in front of the prompt of an Antigravity run: the prompt is written with Claude's tool names; this maps them to agy's.
export const agyNote = (light, image = false) => image ? agyImageNote : `ANTIGRAVITY TOOL MAP (you are Antigravity, not Claude; the task below uses Claude's tool names, use yours):
- "Bash" = run_command (a PowerShell on Windows: write "node core/flow-pace.mjs ..." and "powershell -NoProfile -ExecutionPolicy Bypass -File src/agent.ps1 ..." exactly as given, from the TOOL folder).
- "Read" = view_file (also for photos and contact sheets: LOOK at them); "Write" / "Edit" = write_to_file / replace_file_content, only for the temp files the steps ask for.
- FOREGROUND ONLY: do every step in the foreground, one command at a time. Never use manage_task, background tasks, schedule or timer / wait tools for the work (they leave you idle for minutes); wait only through the task's own commands.
` + (light ? `- This run has NO browser: never call any browser_* tool.\n` : `- Every Playwright browser tool of the task (browser_tabs, browser_navigate, browser_snapshot, browser_click, browser_type, browser_press_key, browser_wait_for, browser_run_code_unsafe, browser_take_screenshot, browser_evaluate, browser_file_upload) is called through call_mcp_tool with ServerName "${AGY_MCP_SERVER}", ToolName = that tool's name and Arguments = its arguments (browser_run_code_unsafe takes {"code": "async (page) => {...}"}).
- NEVER use your own built-in browser tools (open_browser_url, browser_click_element, browser_input, browser_get_dom, browser_subagent, capture_browser_screenshot, execute_browser_javascript, ...), generate_image, search_web or read_url_content, and never another MCP server than "${AGY_MCP_SERVER}": the run is stopped at once if you do.\n`) + `\n`;

export function readClaudeModel(workspaceDir, seedDir = "") { return readClaudeSettings(workspaceDir, seedDir).model; }
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
export const PROMPT_FILES = { flow: "agent-prompt.md", scan: "scan-prompt.md", reviews: "reviews-count-prompt.md", queue: "queue-prompt.md", prep: "prep-prompt.md", index: "index-prompt.md", ctx: "agent-ctx-prompt.md", rev: "agent-review-prompt.md" };
export function buildPrompt({ toolRoot, run, options = "defaults", mode = "flow", site = "", max = 20, project = "", workspace = "", agentName = "Claude Code", threads = 1, tabs = 1, selfImages = true }) {
  const agyImg = mode === "flow" && agentName === "Antigravity" && selfImages; // Antigravity makes the images itself: its own prompt file, no Flow, no Google account
  const file = agyImg ? "agent-prompt-agy-image.md" : PROMPT_FILES[mode];
  if (!file) throw new Error("Unknown run mode: " + mode);
  const md = readFileSync(join(toolRoot, "docs", file), "utf8");
  const m = md.match(/```text\r?\n([\s\S]*?)\r?\n```/);
  if (!m) throw new Error(`docs/${file} has no text block.`);
  let acct = ""; // the Google account Flow must use (run-settings.json flowAccount, set in the app); only the image (flow) run opens Flow
  if (mode === "flow" && !agyImg) acct = readFlowAccount(workspace || join(toolRoot, "workspace"), join(toolRoot, "workspace"));
  const acctText = acct ? `\nGOOGLE ACCOUNT FOR FLOW: use ONLY the already signed-in Google account ${acct}. The profile may hold several Google accounts and Flow opens the first one. Before creating the project open https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fflow.google.com%2F and click THAT email (no password is needed for a signed-in account); on Flow check the avatar menu shows the same email. If that email is not in the list, or Flow says the credits are used up on it: STOP and report. Never sign out, never remove or add an account, never use another account.` : "";
  return m[1].replace(/\{\{TOOL\}\}/g, toolRoot).replace(/\{\{RUN\}\}/g, run).replace(/\{\{OPTIONS\}\}/g, options)
    .replace(/\{\{SITE\}\}/g, site).replace(/\{\{MAX\}\}/g, String(max)).replace(/\{\{PROJECT\}\}/g, project).replace(/agent: Claude Code/g, "agent: " + agentName).replace(/{{THREADS}}/g, String(threads)).replace(/{{TABS}}/g, String(tabs)) + acctText;
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

const lightRuns = new Map(); // active light runs per tool root + session (shared by every shard)
export function createAgentRunner({ toolRoot, workspace, profileDir = join(workspace, "chrome-profile"), headless = process.env.PR_FLOW_HEADLESS === "1", getBrowser = () => ({ mode: "extension", profile: "Profile 1" }), session = "", kind = "main", slot = 0, checkProfile = checkExtensionProfile, findCli = findClaude, findAgyCli = findAgy, plat = osPlatform(), spawnFn = spawn, killTree = (c) => defaultKill(c, plat), npxOk = () => defaultNpx(plat), now = () => Date.now(), graceMs = 4000, minutes = DEFAULT_MINUTES, maxTurns = 0 }) {
  const runsDir = join(workspace, "runs"), tmpDir = join(workspace, "tmp");
  // Two runner instances per server: "main" (Flow images + reviews, scan, review count) and "light" (queue, prep: no browser). Own state and log files,
  // so a prep / queue run goes on while Bắt đầu runs; two light runs at once stay forbidden (each runner is one run at a time).
  // slot 0 = the one light run of old; slots 1-3 = the other shards of a Luồng N run (own state / log files, own lock tag).
  const stateName = kind === "light" ? (slot ? "prep-run-" + slot : "prep-run") : "agent-run", lockTag = kind;
  // Several light runs (shards) of one session share the project / library lock: it is released only when the LAST one ends.
  const lightKey = toolRoot + "|" + session;
  const releaseOwn = (started) => {
    if (kind === "light") { const n = (lightRuns.get(lightKey) || 0) - (started ? 1 : 0); if (started) lightRuns.set(lightKey, Math.max(0, n)); if (n > 0) return; }
    try { releaseLocks(toolRoot, session, process.pid, lockTag); } catch {}
  };
  const stateFile = join(runsDir, stateName + ".json"), logFile = join(runsDir, stateName + ".log");
  let cur = null, last = null, retry = null, capTry = { runId: "", n: 0 }, netTry = { n: 0 }; // retry = an automatic restart waiting after a capacity error

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
  // First line of the run: written at spawn from the settings, replaced in place when the init event reports the real model.
  const setModelLine = (run, text) => {
    const line = (run.stamp0 || (run.stamp0 = new Date(now()).toTimeString().slice(0, 8))) + " " + (run.prefix || "") + sanitize(text);
    if (run.lines.length && run.modelLine) run.lines[0] = line; else run.lines.unshift(line);
    run.modelLine = true; run.prev = "";
    try { mkdirSync(runsDir, { recursive: true }); writeFileSync(logFile, run.lines.join("\n") + "\n"); } catch {}
  };
  // Antigravity's own image generation ran out of quota (HTTP 429 RESOURCE_EXHAUSTED, "reset after 3h28m59s"): stop the whole run at once (the remaining items
  // would only fail the same way), write when it resets, and tell the person what to switch to.
  // Real exhaustion = RESOURCE_EXHAUSTED (or "exhausted your capacity") WITH a reset time / capacity text; a short "please retry in 12s" is agy retrying by itself.
  const realQuota = (t) => (/RESOURCE_EXHAUSTED/.test(t) || /exhausted your capacity/i.test(t)) && (/reset after\s*\d/i.test(t) || /exhausted your capacity/i.test(t));
    // STRICT sources only: an agy error event, a failed result, and the failure of an image-generator subagent step. NEVER the output of run_command / view_file / read_file /
  // any other tool: those echo old logs and error files (a 10:45 incident text inside a run-summary once stopped a healthy run).
  const agyErrorText = (ev) => {
    const s = ev.step_update || {}, r = ev.result || {}, out = [];
    if (ev.event === "error") out.push(ev.error && ev.error.message, typeof ev.error === "string" ? ev.error : "", ev.message);
    if (ev.event === "result" && String(r.status || "").toUpperCase() !== "SUCCESS") out.push(r.error);
    if (s.step_type === "subagent" || s.tool_name === "invoke_subagent" || s.tool_name === "generate_image") {
      out.push(s.error && s.error.message, s.tool_info && s.tool_info.error && s.tool_info.error.message);
      for (const x of (s.subagent_info && s.subagent_info.subagents) || []) out.push(x.error, x.output, x.result, x.response);
    }
    return out.filter((x) => typeof x === "string").join(" ");
  };
  // Google's per-model CAPACITY throttle (HTTP 429 RESOURCE_EXHAUSTED, "reset after 3h26m"), NOT the account usage limit. The exact text is kept in the log and in the run state
  // (quota_raw). First the run is retried by itself with a growing wait (30 s, 2 min, 5 min); only when the third retry fails too does it stop with a message that names the ways out.
  const CAP_WAITS = String(process.env.PR_CAP_WAITS || "").split(",").map(Number).filter((n) => n > 0).length ? String(process.env.PR_CAP_WAITS).split(",").map(Number) : [30000, 120000, 300000]; // PR_CAP_WAITS only for tests
  const quotaStop = (run, text) => {
    if (run.abort || run.ended || run.retryDelay) return;
    const raw = sanitize(text, 600);
    run.state.quota_raw = raw; addLine(run, "Chi tiết lỗi: " + raw);
    const m = String(text).match(/reset after\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i);
    const ms = m ? (((+m[1] || 0) * 3600) + ((+m[2] || 0) * 60) + (+m[3] || 0)) * 1000 : 0, at = ms ? new Date(now() + ms) : null;
    if (at) run.state.quota_reset = at.toISOString();
    if (run.startOpts && capTry.n < CAP_WAITS.length) {
      const delay = CAP_WAITS[capTry.n++];
      run.retryDelay = delay;
      addLine(run, "⚠ Antigravity báo model quá tải (429, không phải hạn mức tài khoản): tự thử lại lần " + capTry.n + "/" + CAP_WAITS.length + " sau " + (delay >= 60000 ? Math.round(delay / 60000) + " phút" : Math.round(delay / 1000) + " giây")); touch(run);
      killTree(run.child); setTimeout(() => finish(run, null), graceMs).unref?.();
      return;
    }
    const friendly = "Antigravity báo model quá tải / hết dung lượng tạm thời (không phải hạn mức tài khoản)" + (at ? ", thử lại sau " + at.toTimeString().slice(0, 5) : "") + ". Đổi model Antigravity (Gemini 3.8 Flash hoặc Claude Sonnet 4.6) hoặc chọn Codex / Claude (Flow) rồi bấm Chạy tiếp.";
    run.abort = "[CAUSE:QUOTA] " + friendly;
    addLine(run, "⚠ " + friendly); touch(run);
    killTree(run.child); setTimeout(() => finish(run, null), graceMs).unref?.();
  };
  const NET_WAITS = String(process.env.PR_NET_WAITS || "").split(",").map(Number).filter((n) => n > 0).length ? String(process.env.PR_NET_WAITS).split(",").map(Number) : [15000, 30000, 60000]; // PR_NET_WAITS only for tests
  const netRetry = (run, text) => {
    if (run.retryDelay || run.abort || run.forced || run.ended || !run.startOpts || run.backend !== "antigravity" || !isTransientAgyError(text)) return false;
    if ((run.evCount || 0) > 5) netTry.n = 0;   // this launch got somewhere: the count starts again
    if (netTry.n >= 5) { run.abort = "Mất kết nối với Antigravity, đã tự chạy lại 5 lần nhưng vẫn lỗi: " + sanitize(text, 200); return false; }
    const delay = NET_WAITS[Math.min(netTry.n, NET_WAITS.length - 1)]; netTry.n++;
    run.retryDelay = delay; run.retryKind = "net";
    addLine(run, "⚠ Mất kết nối với Antigravity, tự chạy lại (lần " + netTry.n + "/5, sau " + Math.round(delay / 1000) + " giây)"); touch(run);
    return true;
  };
  const handleLine = (run, raw) => {
    // Not an event (a cut-off fragment, tool output): nothing a person can read, so it stays out of the log.
    let ev; try { ev = JSON.parse(raw); } catch { return; }
    if (run.backend === "antigravity") { run.evCount = (run.evCount || 0) + 1; const qt = agyErrorText(ev); if (qt && realQuota(qt)) quotaStop(run, qt); return handleAgy(run, ev); }
    if (ev.type === "system" && ev.subtype === "init" && typeof ev.model === "string" && ev.model) {
      run.state.model_in_use = ev.model;
      setModelLine(run, modelLineText(ev.model, run.asked?.effort));
      if (!modelMatches(run.asked?.model, ev.model)) addLine(run, "⚠ Model thực tế khác cài đặt: cài đặt = " + run.asked.model + ", đang chạy = " + ev.model);
      touch(run); return;
    }
    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      run.state.turns = (run.state.turns || 0) + 1;
      for (const c of ev.message.content) {
        if (c.type === "text" && c.text) { addLine(run, "Claude: " + c.text); const t = sanitize(c.text); if (t) run.state.last_text = t; }
        else if (c.type === "tool_use" && typeof c.name === "string") addLine(run, friendlyTool(c.name, c.input, run.state.mode, run.state.label_ai));
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
  // Antigravity (`agy -p --output-format stream-json`): {event:"init"|"step_update"|"result"}. Agent text arrives as text_delta pieces of one
  // step (printed when the step is DONE); a tool step is printed once, when first seen. Its own browser / image / web tools stop the run.
  const handleAgy = (run, ev) => {
    if (ev.event === "init" && ev.init) {
      const m = typeof ev.init.model === "string" ? ev.init.model : "";
      run.agySeen = true;
      if (m) { run.state.model_in_use = m; setModelLine(run, modelLineText(m, run.asked?.effort, false, "antigravity")); }
      else if (run.asked?.model) { run.state.model_in_use = run.asked.model; setModelLine(run, modelLineText(run.asked.model, run.asked?.effort, false, "antigravity") + " (theo cài đặt: agy không báo model)"); }
      else setModelLine(run, "Model đang dùng: mặc định của Antigravity (agy không báo tên model) · mức suy nghĩ: " + (EFFORT_VI[run.asked?.effort] || "mặc định"));
      if (m && run.asked?.model && !modelMatches(run.asked.model, m)) addLine(run, "⚠ Model thực tế khác cài đặt: cài đặt = " + run.asked.model + ", đang chạy = " + m);
      touch(run); return;
    }
    if (ev.event === "step_update" && ev.step_update) {
      const s = ev.step_update, idx = s.step_index;
      run.agyText = run.agyText || {}; run.agySteps = run.agySteps || new Set();
      if (s.step_type === "agent_response") {
        if (typeof s.text_delta === "string") run.agyText[idx] = (run.agyText[idx] || "") + s.text_delta;
        if (s.state === "DONE" && run.agyText[idx] !== undefined) {
          const t = sanitize(run.agyText[idx]); delete run.agyText[idx];
          run.state.turns = (run.state.turns || 0) + 1;
          if (t) { addLine(run, "Antigravity: " + t); run.state.last_text = t; }
          touch(run);
        }
      } else if (s.tool_name === "invoke_subagent") {
        // Judged on EVERY event of the step, and only once the type info is there (the first event may arrive with an empty list). Outside the image
        // run any subagent is foreign; inside it only image-generator is allowed. No type info at all by the end of the step = a warning, not a kill.
        const subs = s.subagent_info?.subagents || [], imgRun = run.agyImage;
        run.agyShown = run.agyShown || new Set();
        const gen = subs.some((x) => /^image-generator$/i.test(String(x.type_name || "")));
        const bad = !imgRun ? (gen && run.state.label_ai === "antigravity-flow" ? "subagent image-generator khi ảnh do Flow tạo (không cho dùng image-generator)" : "một subagent") : subs.length && !subs.every((x) => /^image-generator$/i.test(String(x.type_name || ""))) ? "subagent không phải image-generator" : "";
        if (bad) {
          run.abort = "Antigravity dùng " + bad + ", không phải việc của lượt chạy: đã dừng.";
          addLine(run, "⚠ " + run.abort); touch(run);
          killTree(run.child); setTimeout(() => finish(run, null), graceMs).unref?.();
          return;
        }
        if (subs.length && !run.agyShown.has(idx)) { run.agyShown.add(idx); const c = agyToolToClaude("invoke_subagent", { count: subs.length }); addLine(run, friendlyTool(c.name, c.input, run.state.mode, run.state.label_ai)); touch(run); }
        else if (!subs.length && s.state === "DONE" && !run.agyShown.has(idx)) { run.agyShown.add(idx); addLine(run, "⚠ Antigravity gọi một subagent nhưng không báo loại: bỏ qua kiểm tra bước này"); touch(run); }
      } else if ((s.step_type === "tool" || s.step_type === "subagent") && s.tool_name && !run.agySteps.has(idx)) {
        run.agySteps.add(idx);
        const p = s.tool_info?.parameters || {};
        if (s.tool_name === "manage_task" || s.tool_name === "schedule") {
          // slow, not harmful: counted and shown, the run goes on
          run.bgCount = (run.bgCount || 0) + 1; run.lastTool = s.tool_name;
          addLine(run, "⚠ Antigravity dùng tác vụ nền (" + s.tool_name + ") lần " + run.bgCount + ": chậm hơn, lượt vẫn chạy"); touch(run);
          return;
        }
        run.lastTool = s.tool_name;
        const imgRun = run.agyImage, noMcp = LIGHT_MODES.includes(run.state.mode) || imgRun;
        const bad = (imgRun && s.tool_name === "generate_image") ? ""
          : AGY_FORBIDDEN_TOOL.test(s.tool_name) ? "công cụ " + s.tool_name + " của chính Antigravity"
          : s.tool_name === "call_mcp_tool" && !noMcp && p.ServerName !== AGY_MCP_SERVER ? "máy chủ MCP \"" + String(p.ServerName || "?") + "\" (không phải " + AGY_MCP_SERVER + ")"
          : s.tool_name === "call_mcp_tool" && noMcp ? "công cụ MCP trong lượt không dùng trình duyệt" : "";
        if (bad) {
          run.abort = "Antigravity dùng " + bad + ", không phải Playwright MCP của lượt chạy: đã dừng để không mở trình duyệt thứ hai.";
          addLine(run, "⚠ " + run.abort); touch(run);
          killTree(run.child); setTimeout(() => finish(run, null), graceMs).unref?.();
          return;
        }
        const c = agyToolToClaude(s.tool_name, p);
        addLine(run, friendlyTool(c.name, c.input, run.state.mode, run.state.label_ai)); touch(run);
      }
      return;
    }
    if (ev.event === "result" && ev.result) {
      const r = ev.result, ok = String(r.status || "").toUpperCase() === "SUCCESS";
      run.result = { is_error: !ok, subtype: String(r.finished_reason || r.status || "") };
      if (typeof r.num_turns === "number" && r.num_turns > 0) run.state.turns = r.num_turns;
      if (typeof r.response === "string" && r.response.trim()) run.state.last_text = sanitize(r.response);
      if (!ok && r.error) run.agyError = sanitize(r.error);
      if (!ok) netRetry(run, String(r.error || run.stderr.join(" ")));
      addLine(run, ok ? "Antigravity đã xử lý xong các bước" : `Antigravity báo lỗi (${run.result.subtype || "không rõ"})`);
      touch(run);
    }
  };
  const feed = (run, chunk) => {
    run.lastEventAt = now(); run.idleNoted = false;
    run.buf += chunk.toString("utf8");
    let i;
    while ((i = run.buf.indexOf("\n")) >= 0) { const l = run.buf.slice(0, i).trim(); run.buf = run.buf.slice(i + 1); if (l) handleLine(run, l); }
    if (run.buf.length > 1e6) run.buf = "";
  };
  const finish = (run, code, err) => {
    if (run.ended) return; run.ended = true;
    clearTimeout(run.timer); if (run.idleTimer) clearInterval(run.idleTimer);
    if (run.buf.trim()) handleLine(run, run.buf.trim());
    try { rmSync(run.cfg, { force: true }); } catch {}
    // Antigravity: the per-run folder (prompt, plugin with the Playwright MCP config and its token) is always removed, on success, failure and stop.
    if (run.agyDir) { try { rmSync(run.agyDir, { recursive: true, force: true }); } catch {} }
    releaseOwn(true);
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
        if (n > 0 && made === 0 && results === 0) nothing = "0/" + n + " mục hoàn tất: không có ảnh nào được tạo và không có kết quả nào. Xem lý do của từng mục trong báo cáo cuối của " + (run.who || "Claude") + ".";
      } catch {}
    }
    if (!run.retryDelay && !run.forced && !run.abort && run.backend === "antigravity" && code !== 0 && (!run.result || run.result.is_error) && run.stderr.some((l) => isTransientAgyError(l))) netRetry(run, run.stderr.join(" "));
    const status = run.retryDelay && !run.forced ? "retrying" : nothing || run.abort ? "failed" : run.forced || (code === 0 && !run.result?.is_error ? "done" : "failed");
    const error = status === "failed" ? sanitize(nothing || run.abort || err || run.agyError || run.stderr.at(-1) || (run.result?.is_error ? `${run.who || "Claude"} reported ${run.result.subtype || "an error"}.` : `${run.who || "Claude"} exited with code ${code}.`))
      : status === "timeout" ? `Stopped after the ${minutes}-minute limit.` : "";
    addLine(run, { retrying: "Chờ để tự thử lại", done: "Lượt chạy kết thúc", failed: `Lượt chạy dừng vì lỗi${code === null || code === undefined ? "" : " (mã " + code + ")"}`, timeout: "Lượt chạy dừng vì quá thời gian" }[status] || `Lượt chạy: ${status}`);
    try { writeFileSync(logFile, run.lines.join("\n") + "\n"); } catch {}
    touch(run, { status, exit_code: code ?? null, error });
    last = run.state; cur = null;
    if (status === "retrying") {
      const delay = run.retryDelay, opts = { ...run.startOpts, _retry: true, _carry: run.lines.slice() };
      retry = { wakeAt: now() + delay, n: run.retryKind === "net" ? netTry.n : capTry.n, of: run.retryKind === "net" ? 5 : 3, kind: run.retryKind || "cap", timer: setTimeout(() => { retry = null; const r = start(opts); if (!r.ok) last = { ...last, status: "failed", error: r.error || "Chưa thử lại được.", updated: new Date(now()).toISOString() }; }, delay) };
      retry.timer.unref?.();
    }
  };

  // mode "flow": Google Flow images + reviews (docs/agent-prompt.md); mode "scan": Quét web (docs/scan-prompt.md, needs site and max);
  // mode "queue": put products of a project into the run queue with N scenes each (docs/queue-prompt.md, needs project and options).
  // mode "reviews": read the review number shown on each product page of a project (docs/reviews-count-prompt.md, needs project).
  // One run at a time for all: they share the one Chrome profile.
  function start({ run: runId = newRunId(), options = "defaults", mode = "flow", site = "", max = 20, project = "", shard = "", tabs = 1, targetRun = "", phased = false, _retry = false, _carry = [] } = {}) {
    if (!/^[\w.-]{3,64}$/.test(runId)) return { ok: false, status: 400, error: "Invalid run id." };
    const lightMode = LIGHT_MODES.includes(mode);
    if ((kind === "light") !== lightMode) return { ok: false, status: 400, error: `Mode ${mode} does not run on this runner.` };
    if (retry && !_retry) return { ok: false, status: 409, error: "Antigravity đang chờ để tự thử lại: đợi xong hoặc bấm Dừng." };
    if (!_retry) { capTry = { runId, n: 0 }; netTry = { n: 0 }; }
    if (cur) return { ok: false, status: 409, error: `An agent run is already active (started ${cur.state.started}). Wait for it or press Stop.` };
    const agentSet = readAgentSettings(workspace || join(toolRoot, "workspace"), join(toolRoot, "workspace"), mode), backend = agentSet.backend, agy = backend === "antigravity", who = AGENT_NAME[backend];
    // Antigravity makes the images itself (image-generator subagent): the image run needs no Chrome, no Playwright MCP, no Flow account.
    // agyImages: "self" = Antigravity makes the pictures itself (image-generator subagent, no browser); "flow" = it drives Google Flow through the per-run Playwright MCP, exactly like Claude (Flow).
    const agyFlow = agy && mode === "flow" && agentSet.agyImages === "flow", agyImage = agy && mode === "flow" && !agyFlow, noBrowser = lightMode || agyImage;
    const found = agy ? findAgyCli() : findCli();
    if (!found?.found) return { ok: false, status: 400, error: agy ? "Antigravity CLI (agy) not found: install Antigravity and sign in with Google, or set PR_AGY_CLI to its path." : "Claude CLI not found: install Claude Code, or set PR_CLAUDE_CLI to its path." };
    if (!noBrowser && !npxOk()) return { ok: false, status: 400, error: "npx is not available (it comes with Node.js): the Playwright MCP cannot start." };
    let prompt;
    try { prompt = buildPrompt({ toolRoot, run: targetRun || runId, options, mode, site, max, project, workspace, agentName: agy ? "Antigravity" : "Claude Code", selfImages: !agyFlow, tabs: Math.min(4, Math.max(1, Math.round(Number(tabs)) || 1)), threads: agyImage ? readThreads(workspace || join(toolRoot, "workspace"), join(toolRoot, "workspace")) : 1 }); } catch (e) { return { ok: false, status: 500, error: sanitize(e.message) }; }
    mkdirSync(tmpDir, { recursive: true }); mkdirSync(runsDir, { recursive: true });
    const cfg = join(tmpDir, `mcp-${runId}-${randomBytes(3).toString("hex")}.json`);
    const bc = noBrowser ? {} : (getBrowser() || {}), ext = !noBrowser && bc.mode !== "own";
    if (ext) { const chk = checkProfile(bc.profile, { account: mode === "flow" ? readFlowAccount(workspace, join(toolRoot, "workspace")) : "" }); if (!chk.ok) return { ok: false, status: 409, error: chk.error }; }
    // Sessions (several windows): the own Chrome profile and a project are used by one live session at a time.
    const holderText = (h) => "phiên \"" + sessionLabel(h.session) + "\"";
    if (!noBrowser && !ext) {
      const c = claimLock(toolRoot, "chrome", "own", session, process.pid, lockTag);
      if (!c.ok) return { ok: false, status: 409, error: "Chrome riêng của tool đang được " + holderText(c.holder) + " dùng. Chọn Chrome thật (profile có sẵn trên máy) hoặc đợi phiên đó chạy xong." };
    }
    let projectId = project;
    if (!projectId && mode === "scan" && site) { try { projectId = new URL(site).hostname.replace(/^www\./, "").replace(/\./g, "-"); } catch {} }
    if (projectId) {
      const c = claimLock(toolRoot, "project", projectId, session, process.pid, lockTag);
      if (!c.ok) { releaseOwn(false); return { ok: false, status: 409, error: "Dự án " + projectId + " đang được " + holderText(c.holder) + " dùng. Chọn dự án khác hoặc đợi phiên đó xong để khỏi ghi đè dữ liệu của nhau." }; }
    }
    // Gắn nhãn kho ảnh: the library index is shared by every session, so one index run at a time on this machine (no two windows tagging the same photos).
    if (mode === "index") {
      const c = claimLock(toolRoot, "library", "scene-index", session, process.pid, lockTag);
      if (!c.ok) { releaseOwn(false); return { ok: false, status: 409, error: "Kho ảnh đang được " + holderText(c.holder) + " gắn nhãn. Đợi lượt đó xong." }; }
    }
    const group = ext ? takeGroup(workspace, session) : null;
    if (!noBrowser) writeFileSync(cfg, JSON.stringify(mcpConfig({ plat, profile: profileDir, headless, extension: ext ? { profile: bc.profile, name: group.name, color: group.color, background: mode !== "flow" } : null })));
    if (!noBrowser && !ext) mkdirSync(profileDir, { recursive: true });
    const claudeSet = readClaudeSettings(workspace || join(toolRoot, "workspace"), join(toolRoot, "workspace"));
    const asked = agy ? { model: agentSet.agyModel, effort: agentSet.agyEffort } : claudeSet;
    // Optional per-profile Playwright extension token (shared workspace/playwright-tokens.json): through this env for Claude, never in a log.
    const extToken = ext ? extensionToken(join(toolRoot, "workspace"), bc.profile) : "";
    const note = mode === "ctx" || mode === "rev"
      ? "RUN-NOW NOTE: this is one WORKER of an image run split between several workers (no browser, no Flow, open no page): it handles ONLY the items listed in the items file named in OPTIONS, with the CLI commands of the steps below; other workers do the other items at the same time, so run CLI commands one at a time and never touch an item that is not in your list.\n\n"
      : mode === "index"
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
    const phaseNote = phased === "review" ? "PHASE NOTE: the reviews are written by ANOTHER AI after the images exist, and the app runs finish afterwards: skip step 4 entirely. Do step 2 and step 3 as usual; when step 3 is over (every image registered or skipped) go to step 5 (CLI run-summary) and STOP; never write reviews and never run finish. The items are ALREADY prepared: `prepare` may list them as new:false, and an empty list never means \"nothing to do\": work every item that lacks an image (run-summary status needs_image).\n\n" : phased ? "PHASE NOTE: this run is split in phases because Luồng is above 1. Step 2 (context, sign wording, custom-logo flags) was ALREADY done for the items by other workers: do NOT redo it for an item that has a context; an item without one, or flow-brief answering NEEDS_SIGN_TEXT, is the exception: do its step 2 yourself. Step 4 (reviews and finish) is done AFTER this run by other workers: when step 3 is over (every image registered or skipped) go to step 5 (CLI run-summary) and STOP; never write reviews and never run finish. The items are ALREADY prepared: `prepare` may list them as new:false, and an empty list never means \"nothing to do\": work every item that lacks an image (run-summary status needs_image).\n\n" : "";
    const intro = phaseNote + (agyImage ? "" : ext && mode !== "queue" ? extensionNote({ groupName: group.name, session: sessionLabel(session), downloadsDir: join(workspace, "tmp", "flow-downloads"), tokenSet: !!extToken, flow: mode === "flow" }) : note) + prompt;
    let args, agyDir = "";
    if (agy) {
      // Antigravity has no per-run MCP flag (--settings refuses mcpServers) and global config must stay untouched, so the run gets a folder of its own
      // OUTSIDE the repo (agy would otherwise read the AGENTS.md files above it) used as its cwd: it holds prompt.md and a project plugin
      // .agents/plugins/prreview/mcp_config.json that carries the same Playwright MCP as the Claude path (agy loads it for this cwd only). Removed in finish().
      agyDir = join(tmpdir(), "pr-agy-" + runId + "-" + randomBytes(3).toString("hex"));
      try {
        mkdirSync(agyDir, { recursive: true });
        writeFileSync(join(agyDir, "prompt.md"), agyNote(lightMode, agyImage) + intro, "utf8");
        if (!noBrowser) {
          mkdirSync(join(agyDir, ".agents", "plugins", AGY_PLUGIN), { recursive: true });
          writeFileSync(join(agyDir, ".agents", "plugins", AGY_PLUGIN, "plugin.json"), JSON.stringify({ name: AGY_PLUGIN }));
          const server = { ...mcpConfig({ plat, profile: profileDir, headless, extension: ext ? { profile: bc.profile, name: group.name, color: group.color } : null }).mcpServers.playwright };
          // agy starts the MCP from its own language server: the extension token travels in this file (a private temp folder, deleted when the run ends).
          if (extToken) server.env = { ...(server.env || {}), PLAYWRIGHT_MCP_EXTENSION_TOKEN: extToken };
          writeFileSync(join(agyDir, ".agents", "plugins", AGY_PLUGIN, "mcp_config.json"), JSON.stringify({ mcpServers: { [AGY_SERVER]: server } }));
        }
      } catch (e) { try { rmSync(agyDir, { recursive: true, force: true }); } catch {} try { rmSync(cfg, { force: true }); } catch {} releaseOwn(false); return { ok: false, status: 500, error: sanitize(e.message) }; }
      const task = "Your full task is in the file " + join(agyDir, "prompt.md") + ". Read it first with view_file, then do exactly what it says, following its numbered steps in order. Reply only as the task asks.";
      args = ["-p", task, "--output-format", "stream-json", "--dangerously-skip-permissions", "--add-dir", toolRoot, ...(asked.model ? ["--model", asked.model] : []), ...(asked.effort && !(asked.model && /-(low|medium|high|xhigh)$/.test(asked.model)) ? ["--effort", asked.effort] : [])];
    } else {
      args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "default", "--model", claudeSet.model, ...(claudeSet.effort ? ["--effort", claudeSet.effort] : []), ...(maxTurns > 0 ? ["--max-turns", String(maxTurns)] : []), "--allowedTools", (lightMode ? LIGHT_TOOLS : ALLOWED_TOOLS).join(","), "--add-dir", toolRoot, ...(lightMode ? ["--strict-mcp-config"] : ["--mcp-config", cfg])];
    }
    const env = { ...process.env, PR_AGENT_ENGINE: agyFlow ? "antigravity-flow" : backend, ...(extToken && !agy ? { PLAYWRIGHT_MCP_EXTENSION_TOKEN: extToken } : {}) };
    const cmd = plat === "win32" && /\.(cmd|bat)$/i.test(found.path) ? ["cmd", ["/c", found.path, ...args]] : [found.path, args];
    let child;
    try { child = spawnFn(cmd[0], cmd[1], { cwd: agy ? agyDir : toolRoot, env, windowsHide: true, detached: false, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { try { rmSync(cfg, { force: true }); } catch {} if (agyDir) { try { rmSync(agyDir, { recursive: true, force: true }); } catch {} } releaseOwn(false); return { ok: false, status: 500, error: sanitize(e.message) }; }
    const started = new Date(now()).toISOString();
    const run = { child, cfg, lines: _retry ? _carry : [], buf: "", written: 0, stderr: [], ended: false, forced: "", result: null, timer: null,
      state: { run_id: runId, mode, project, pid: child.pid ?? null, started, updated: started, status: "running", exit_code: null, last_text: "", turns: 0, error: "", model_in_use: asked.model, agent: backend, label_ai: agyImage ? "antigravity" : agyFlow ? "antigravity-flow" : backend } };
    run.asked = asked; run.backend = backend; run.who = who; run.agyDir = agyDir; run.agyImage = agyImage;
    run.prefix = "[" + (FEATURE[mode] || mode) + (project ? " · " + project : "") + (shard ? " · luồng " + shard : "") + "] ";
    run.startOpts = { run: runId, options, mode, site, max, project, shard, tabs, targetRun, phased };
    if (_retry && _carry.length) run.modelLine = true; // the carried log keeps its first (model) line: it is replaced in place, not duplicated
    cur = run; if (kind === "light") lightRuns.set(lightKey, (lightRuns.get(lightKey) || 0) + 1);
    if (!_retry) { try { writeFileSync(logFile, ""); } catch {} }
    setModelLine(run, modelLineText(asked.model, asked.effort, true, backend));
    addLine(run, mode === "ctx" ? "Bắt đầu: " + who + " lập ngữ cảnh cho các mục được giao (mã lượt " + runId + ")" : mode === "rev" ? "Bắt đầu: " + who + " viết review cho các mục được giao (mã lượt " + runId + ")" : mode === "index" ? "Bắt đầu: " + who + " gắn nhãn kho ảnh bối cảnh (mã lượt " + runId + ")"
      : mode === "prep" ? "Bắt đầu: " + who + " chuẩn bị trước ảnh bối cảnh cho các sản phẩm của dự án " + project + " (mã lượt " + runId + ")"
      : mode === "scan" ? "Bắt đầu: " + who + " quét " + site + " (mã lượt " + runId + ")"
      : mode === "queue" ? "Bắt đầu: " + who + " thêm sản phẩm của dự án " + project + " vào hàng chờ (mã lượt " + runId + ")"
      : mode === "reviews" ? "Bắt đầu: " + who + " đọc số review trên các trang sản phẩm của dự án " + project + " (mã lượt " + runId + ")"
      : (agyImage ? "Bắt đầu: Antigravity (tạo ảnh) tạo ảnh và viết review (mã lượt " + runId + ")" : "Bắt đầu: " + who + " điều khiển Google Flow (mã lượt " + runId + ")"));
    saveState(run.state);
    child.stdout?.on("data", (c) => feed(run, c));
    child.stderr?.on("data", (c) => { for (const l of c.toString("utf8").split(/\r?\n/)) { if (run.backend === "antigravity" && realQuota(l)) quotaStop(run, l); const bg = l.match(/idle; waiting for (\d+) background task/i); if (bg) { run.idleHint = true; addLine(run, "Antigravity đang chờ " + bg[1] + " tác vụ nền …"); continue; } const t = sanitize(l); if (t) { run.stderr.push(t); if (run.stderr.length > 20) run.stderr.shift(); addLine(run, "Cảnh báo: " + t); } } });
    child.on("error", (e) => finish(run, null, e.message));
    child.on("close", (code) => finish(run, code));
    child.stdin?.on("error", () => {});
    try { child.stdin?.end(agy ? undefined : intro); } catch {}
    if (minutes > 0) run.timer = setTimeout(() => { if (run.ended) return; run.forced = "timeout"; killTree(child); setTimeout(() => finish(run, null), graceMs).unref?.(); }, minutes * 60000);
    run.timer?.unref?.();
    // Antigravity stream batches / background-task waits can leave minutes without an event: say so in the run log after 30 s instead of looking frozen.
    if (agy) { run.lastEventAt = now(); run.idleTimer = setInterval(() => { if (run.ended || run.idleNoted) return; const gap = Math.round((now() - (run.lastEventAt || now())) / 1000); if (gap < 30) return; run.idleNoted = true; addLine(run, run.lastTool === "manage_task" || run.idleHint ? "Antigravity đang chờ tác vụ nền … (" + gap + " giây chưa có hoạt động mới)" : "Antigravity đang chờ … (" + gap + " giây chưa có hoạt động mới)"); }, 10000); run.idleTimer.unref?.(); }
    return { ok: true, status: 200, run_id: runId, started };
  }

  // The FINAL state of a run that ended outside this runner's own process (the phased image job finishes after its last runner is gone): written into the state file so a
  // restart reads the truth, not the old failure. Done clears any old error / quota text. Creates the state when the file belongs to another run.
  function setFinal(runId, patch) {
    if (cur) return false;
    const base = last && last.run_id === runId ? last : (() => { const s = readState(); return s && s.run_id === runId ? s : null; })();
    const now0 = new Date(now()).toISOString();
    const st = { ...(base || { run_id: runId, mode: "flow", project: "", pid: null, started: now0, exit_code: null, last_text: "", turns: 0, model_in_use: "" }), ...patch, updated: now0 };
    if (patch.status === "done") { st.error = patch.error || ""; delete st.quota_reset; delete st.quota_raw; st.exit_code = 0; }
    last = st; saveState(st); return true;
  }
  function stop() {
    if (!cur && retry) { clearTimeout(retry.timer); retry = null; last = { ...last, status: "stopped", error: "", updated: new Date(now()).toISOString() }; saveState(last); return { ok: true, status: 200, run_id: last.run_id }; }
    if (!cur) return { ok: false, status: 409, error: "No run is active." };
    const run = cur; run.forced = "stopped"; killTree(run.child);
    setTimeout(() => finish(run, null), graceMs).unref?.();
    return { ok: true, status: 200, run_id: run.state.run_id };
  }
  function shutdown() {
    if (retry) { clearTimeout(retry.timer); retry = null; }
    if (!cur) return;
    cur.forced = cur.forced || "stopped"; killTree(cur.child);
    try { rmSync(cur.cfg, { force: true }); } catch {}
    if (cur.agyDir) { try { rmSync(cur.agyDir, { recursive: true, force: true }); } catch {} }
    touch(cur, { status: "stopped" });
  }
  function status() {
    const run = cur, st = run ? run.state : last || readState();
    const shown = st && !run && st.status === "running" ? { ...st, status: "stopped", error: "Ứng dụng đã đóng khi lượt này đang chạy (không phải lỗi của lượt). Bấm chạy lại để tiếp tục." } : st;
    const lines = run ? run.lines : (() => { try { return readFileSync(logFile, "utf8").split("\n").filter(Boolean); } catch { return []; } })();
    return {
      active: !!run || !!(!run && retry), status: !run && retry ? "running" : shown?.status || "idle", run_id: shown?.run_id || "", mode: shown?.mode || "flow", project: shown?.project || "", started: shown?.started || "",
      elapsed_s: shown?.started ? Math.max(0, Math.round(((run ? now() : Date.parse(shown.updated) || now()) - Date.parse(shown.started)) / 1000)) : 0,
      model_in_use: shown?.model_in_use || "", agent: shown?.agent || "", label_ai: shown?.label_ai || "", quota_reset: shown?.quota_reset || "", last_text: !run && retry ? (retry.kind === "net" ? "Mất kết nối với Antigravity: tự chạy lại lúc " : "Antigravity báo model quá tải: tự thử lại lúc ") + new Date(retry.wakeAt).toTimeString().slice(0, 5) + " (lần " + retry.n + "/" + (retry.of || 3) + ")" : shown?.last_text || "", turns: shown?.turns || 0, error: shown?.error || "", updated: shown?.updated || "", tail: lines.slice(-TAIL_LINES),
    };
  }
  return { start, stop, status, shutdown, setFinal, isActive: () => !!cur || !!retry };
}

// Cấu hình, served by Product Review's server: the same steps and settings as core/setup/*.ps1, kept in
// workspace/config.
//   GET /setup[?back=<path>]        the Cấu hình page (page.html, page.js; tool.css from core/assets)
//   POST /api/setup                 the steps (setup-check.ps1 -AsJson)
//   POST /api/setup-step {step}     update-all: Cài / cập nhật tất cả AI (Codex, Antigravity CLI), one result each;
//                                   install: Codex; login: codex login with a one-time code, typed on the sign-in page
//                                   opened in the user's Chrome; site {site}: chatgpt opened there; antigravity: a terminal
//                                   with agy, where /login (/logout first to switch) signs it in
//   GET /api/setup-login            { code } while a sign-in waits for it
//   GET|POST /api/config/ai         Model AI: { settings, models } / save { model, effort }
//   GET /api/usage                  Lượt dùng AI: { rows } per AI and account (usage.mjs)
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { findTool as findIn, runTool, psCommand, psFile, onWindows, killTree, openTerminal, openChrome } from "../platform.mjs";
import { createSetupReader } from "./setup-report.mjs";
import { readUsage, summarizeUsage } from "./usage.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const q = (p) => p.replace(/'/g, "''");

export function createConfigApi({ hubRoot, pwsh, env = process.env }) {
  const readSetup = createSetupReader({ hubRoot, pwsh, args: psFile(join(here, "setup-check.ps1"), ["-AsJson"]), env });
  const findTool = (name) => findIn(name, env);
  const json = (res, status, data) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };
  const body = (req) => new Promise((done) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => { try { done(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { done({}); } }); });
  // A PowerShell command over the setup scripts; it prints one JSON line, errors included ({ error }).
  const ps = (script, extraEnv = {}) => new Promise((done) => {
    const command = `$ErrorActionPreference='Stop'; try { ${script} } catch { @{ error = $_.Exception.Message } | ConvertTo-Json -Compress }`;
    execFile(pwsh, psCommand(command), { cwd: hubRoot, env: { ...env, ...extraEnv }, timeout: 120000, windowsHide: true }, (err, stdout) => {
      try { done(JSON.parse(String(stdout).trim().split(/\r?\n/).pop())); } catch { done({ error: "Chưa đọc được cấu hình." }); }
    });
  });
  const load = (file) => `. '${q(join(here, file))}'`;
  const workspace = q(join(hubRoot, "workspace"));
  // Where agy is: on PATH, in ~/.local/bin, or where Google's Windows installer puts it (%LOCALAPPDATA%\agy\bin).
  const AGY_INSTALLER = "https://antigravity.google/cli/install.ps1";
  const agyFile = () => findTool("agy") || [join(homedir(), ".local", "bin", onWindows ? "agy.exe" : "agy"), ...(onWindows && process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe")] : [])].find((p) => existsSync(p));
  const lastLine = (text) => String(text || "").trim().split(/\r?\n/).pop() || "";
  const runAsync = (cmd, args, opts) => new Promise((done) => runTool(cmd, args, { cwd: hubRoot, timeout: 15 * 60000, env, windowsHide: true, ...opts }, (err, stdout, stderr) => done(err ? { ok: false, message: (lastLine(stderr) || lastLine(stdout) || err.message).slice(0, 300) } : { ok: true, message: lastLine(stdout).slice(0, 200) })));
  // Google's own installer for agy (checks the SHA-512 of what it downloads, puts agy.exe in %LOCALAPPDATA%\agy\bin and
  // sets it up). It is saved to a file and run from there, never piped into PowerShell. agy updates itself afterwards.
  const installAntigravity = async () => {
    if (!onWindows) return { ok: false, message: "Chưa cài tự động được trên máy này. Cài Antigravity thủ công." };
    const had = agyFile();
    let dir = "";
    try {
      const r = await fetch(AGY_INSTALLER, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const script = await r.text();
      if (script.length > 200000 || !script.includes("agy.exe")) throw new Error("Bộ cài trả về nội dung lạ, không chạy.");
      dir = mkdtempSync(join(tmpdir(), "agy-install-"));
      const file = join(dir, "install.ps1");
      writeFileSync(file, script);
      const ran = await new Promise((done) => execFile(pwsh, psFile(file, []), { cwd: dir, env, timeout: 10 * 60000, windowsHide: true }, (err, stdout, stderr) => done({ err, stdout, stderr })));
      if (ran.err && !agyFile()) throw new Error(lastLine(ran.stderr) || lastLine(ran.stdout) || ran.err.message);
      if (!agyFile()) return { ok: false, message: "Đã chạy bộ cài nhưng chưa thấy agy. Mở lại app rồi bấm Kiểm tra lại." };
      return { ok: true, message: had ? "Đã có sẵn, agy tự cập nhật ở nền." : "Đã cài. Bấm Đăng nhập ở Antigravity CLI để đăng nhập Google." };
    } catch (e) { return { ok: false, message: String(e.message || e).slice(0, 300) }; }
    finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
  };
  // A page in the user's own Chrome (the Codex sign-in page).
  const openInChrome = (url, done) => openChrome(url).then((error) => done(error ? { error } : { ok: true }));
  // codex login opens the system's default browser; with --device-auth it prints a page and a code instead, so the
  // page opens in Chrome and Cấu hình shows the code to type there.
  // Đăng nhập again while one waits: that one stops (its answer says so) and a new code comes.
  let loginCode = "", login = null;
  const codexLogin = (codex, done) => {
    if (login) { const old = login; login = null; loginCode = ""; killTree(old.child); old.done({ superseded: true }); }
    const child = spawn(onWindows && /\.cmd$/i.test(codex) ? `"${codex}"` : codex, ["login", "--device-auth"], { cwd: hubRoot, env, windowsHide: true, detached: !onWindows, shell: onWindows && /\.cmd$/i.test(codex) });
    const timer = setTimeout(() => killTree(child), 15 * 60000);
    let out = "", opened = false;
    login = { child, done };
    const current = () => login?.child === child;
    const read = (chunk) => {
      out = (out + chunk).replace(/\x1b\[[0-9;]*m/g, "");
      const url = out.match(/https:\/\/\S+\/device\b\S*/)?.[0], code = out.match(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/)?.[0];
      if (opened || !url || !code || !current()) return;
      opened = true;
      loginCode = code;
      openInChrome(url, (r) => { if (r.error) { loginCode = ""; killTree(child); done({ error: r.error }); } });
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", (e) => { clearTimeout(timer); if (!current()) return; login = null; loginCode = ""; done({ error: e.message }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!current()) return;
      login = null;
      loginCode = "";
      done(code === 0 ? { ok: true } : { error: (out.trim().split(/\r?\n/).pop() || "Chưa đăng nhập được ChatGPT.").slice(0, 300) });
    });
  };

  // The page and its two files, the same from the menu and from every tool's server.
  const PAGE = { "/setup": [join(here, "page.html"), "text/html"], "/setup/page.js": [join(here, "page.js"), "text/javascript"], "/setup/tool.css": [join(here, "..", "assets", "tool.css"), "text/css"] };
  return async function handle(req, res, path) {
    if (PAGE[path] && req.method === "GET") {
      res.writeHead(200, { "content-type": `${PAGE[path][1]}; charset=utf-8`, "cache-control": "no-store" });
      res.end(readFileSync(PAGE[path][0]));
      return true;
    }
    if (path === "/api/setup" && req.method === "POST") {
      const {status, report} = await readSetup();
      json(res, status, report);
      return true;
    }
    if (path === "/api/setup-login") {
      json(res, 200, { code: loginCode });
      return true;
    }
    if (path === "/api/setup-step" && req.method === "POST") {
      // Cài (Codex via npm) or Đăng nhập (opens the browser, waits for the sign-in).
      const { step, site } = await body(req);
      // ChatGPT's sign-in page in Chrome, to sign in or switch accounts there.
      if (step === "site" && site === "chatgpt") {
        openInChrome("https://chatgpt.com/", (r) => json(res, r.error ? 500 : 200, r));
        return true;
      }
      if (step === "antigravity") {
        // Antigravity signs in on its own (not through Chrome), from inside agy.
        const agy = agyFile();
        if (!agy) { json(res, 400, { error: "Chưa cài Antigravity CLI (agy)." }); return true; }
        openTerminal(agy);
        json(res, 200, { ok: true });
        return true;
      }
      if (step === "update-all") {
        // Cài / cập nhật tất cả AI: Codex (npm @latest installs it or brings it up to date), Antigravity CLI (Google's
        // installer; it updates itself after that). ChatGPT is a website in Chrome and needs nothing installed.
        const npmCmd = findTool("npm");
        const results = [];
        results.push({ name: "Codex", ...(npmCmd ? await runAsync(npmCmd, ["install", "-g", "@openai/codex@latest"]) : { ok: false, message: "Chưa có Node.js (npm). Mở lại start-app để cài." }) });
        results.push({ name: "Antigravity CLI", ...(await installAntigravity()) });
        json(res, 200, { results });
        return true;
      }
      const npm = findTool("npm"), codex = findTool("codex");
      if (step === "login") {
        if (!codex) { json(res, 400, { error: "Chưa cài Codex." }); return true; }
        let answered = false;
        codexLogin(codex, (r) => { if (!answered) { answered = true; json(res, r.error ? 500 : 200, r); } });
        return true;
      }
      // Anything else (a site not listed, an unknown step) is refused; only Cài is left below.
      if (step !== "install") { json(res, 400, { error: "Bước không hỗ trợ." }); return true; }
      if (!npm) { json(res, 400, { error: "Chưa có Node.js. Mở lại start-app để cài." }); return true; }
      const [cmd, args] = [npm, ["install", "-g", "@openai/codex"]];
      runTool(cmd, args, { cwd: hubRoot, timeout: 15 * 60000, env, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return json(res, 500, { error: (String(stderr || stdout).trim().split(/\r?\n/).pop() || err.message).slice(0, 300) });
        json(res, 200, { ok: true });
      });
      return true;
    }
    if (path === "/api/usage" && req.method === "GET") {
      json(res, 200, { rows: summarizeUsage(readUsage(join(hubRoot, "workspace", "logs", "ai-usage.jsonl"))) });
      return true;
    }
    if (path === "/api/config/ai") {
      const saved = req.method === "POST" ? await body(req) : null;
      const script = saved
        ? `${load("ai-settings.ps1")}; Set-AiSettings '${q(hubRoot)}' $env:HUB_AI_MODEL $env:HUB_AI_EFFORT; '{"ok":true}'`
        : `${load("ai-settings.ps1")}; [pscustomobject]@{ settings = (Get-AiSettings '${q(hubRoot)}'); models = @(Get-AiModels '${q(hubRoot)}') } | ConvertTo-Json -Depth 6 -Compress`;
      const r = await ps(script, saved ? { HUB_AI_MODEL: String(saved.model || ""), HUB_AI_EFFORT: String(saved.effort || "") } : {});
      json(res, r.error ? 400 : 200, r);
      return true;
    }
    return false;
  };
}

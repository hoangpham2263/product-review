// Claude (Flow) uses its OWN Chrome profile (workspace/chrome-profile), never the person's real Chrome. The person signs in to
// Google there by hand (a normal Chrome window, no automation flags). Nothing is typed or stored for them: the sign-in lives
// only inside the profile. Status = one short headless Chrome on that profile opening Flow: a redirect to accounts.google.com
// means signed out; staying on Flow also needs a live Google session cookie (names and expiry only, never values).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

export const FLOW_URL = "https://flow.google.com/";
export const CHECK_MS = 25000, STABLE_MS = 5000, CACHE_MS = 60000;
export const profileDirOf = (workspace) => join(workspace, "chrome-profile");

// Chrome lock: "lockfile" (Windows) or SingletonLock (macOS/Linux) exists while a Chrome holds the profile.
export function profileLocked(dir, { exists = existsSync } = {}) { return exists(join(dir, "lockfile")) || exists(join(dir, "SingletonLock")); }

export function findChrome({ plat = process.platform, env = process.env, exists = existsSync } = {}) {
  const given = env.PR_CHROME_PATH;
  if (given && exists(given)) return given;
  const list = plat === "win32"
    ? [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean).map((b) => join(b, "Google", "Chrome", "Application", "chrome.exe"))
    : plat === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
  return list.find((p) => exists(p)) || "";
}

const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const kill = (child, plat) => {
  if (!child?.pid) return;
  if (plat === "win32") { try { spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000, stdio: "ignore" }); } catch {} }
  else { try { child.kill("SIGKILL"); } catch {} }
};

// A live Google session cookie in the profile (SID / __Secure-1PSID): names and expiry only. null = could not read.
async function googleCookie(dir) {
  const src = [join(dir, "Default", "Network", "Cookies"), join(dir, "Default", "Cookies")].find((p) => existsSync(p));
  if (!src) return false;
  let Db; try { Db = (await import("node:sqlite")).DatabaseSync; } catch { return null; }
  const tmp = mkdtempSync(join(tmpdir(), "pr-cookies-"));
  try {
    const file = join(tmp, "c.sqlite"); copyFileSync(src, file);
    for (const ext of ["-wal", "-journal"]) if (existsSync(src + ext)) { try { copyFileSync(src + ext, file + ext); } catch {} }
    const db = new Db(file, { readOnly: true });
    try {
      const rows = db.prepare("SELECT CAST(expires_utc / 1000000 AS INTEGER) AS e FROM cookies WHERE name IN ('SID','__Secure-1PSID') AND host_key LIKE '%google.com'").all();
      const nowWin = Math.floor(Date.now() / 1000) + 11644473600;
      return rows.some((r) => Number(r.e) === 0 || Number(r.e) > nowWin);
    } finally { db.close(); }
  } catch { return null; } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch {} }
}


// Google accounts signed in inside a Chrome profile: the emails Chrome keeps in <profile>/Default/Preferences (account_info and
// last username). Emails only, never cookies or tokens. [] when the profile or file is missing / unreadable.
export function profileGoogleAccounts(profileDir, { read = (f) => readFileSync(f, "utf8") } = {}) {
  try {
    const txt = read(join(profileDir, "Default", "Preferences")).replace(/^\uFEFF/, "");
    const found = new Set();
    for (const m of txt.matchAll(/"(?:email|last_username|last_gaia_id_username)"\s*:\s*"([^"\s@]+@[^"\s@]+\.[^"\s@]+)"/g)) found.add(m[1].toLowerCase());
    return [...found].sort();
  } catch { return []; }
}

// The URL the sign-in window opens: with a chosen account, Google's account chooser pre-selecting that signed-in account, then Flow.
// The size and place of every Chrome window the tool opens: compact, not covering the whole screen, never narrower than ~1024x700 (narrower
// windows switch Flow and shop sites to their mobile layouts and cramp Flow). Chrome reads these switches when it STARTS a window of a new
// instance (the own profile); a window added to an already running everyday Chrome may keep that Chrome's last size.
export const WINDOW_SIZE = { width: 1280, height: 800 };
export const WINDOW_ARGS = [`--window-size=${WINDOW_SIZE.width},${WINDOW_SIZE.height}`, "--window-position=80,60"];
export const flowOpenUrl = (email = "") => (/^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/.test(email) ? `https://accounts.google.com/AccountChooser?Email=${encodeURIComponent(email)}&continue=${encodeURIComponent("https://flow.google.com/")}` : FLOW_URL);
export function createFlowLogin({ workspace, runActive = () => false, plat = process.platform, spawnFn = spawn, fetchFn = fetch, now = () => Date.now() }) {
  const dir = profileDirOf(workspace);
  const chosenAccount = () => { try { return String(JSON.parse(readFileSync(join(workspace, "config", "run-settings.json"), "utf8").replace(/^\uFEFF/, "")).flowAccount || ""); } catch { return ""; } };
  let cache = null, checking = null, opened = null;

  async function check() {
    if (runActive()) return { state: "busy", detail: "Đang có lượt Claude chạy, đang dùng Chrome riêng." };
    if (profileLocked(dir)) return { state: "busy", detail: "Chrome riêng đang mở (cửa sổ đăng nhập?). Đóng nó rồi bấm Kiểm tra lại." };
    const chrome = findChrome({ plat });
    if (!chrome) return { state: "error", detail: "Không tìm thấy Google Chrome (đặt PR_CHROME_PATH nếu cài chỗ khác)." };
    if (!existsSync(dir)) return { state: "logged_out", detail: "Chưa có Chrome riêng: bấm Mở Chrome để đăng nhập." };
    let child;
    try {
      const port = await freePort();
      child = spawnFn(chrome, [`--user-data-dir=${dir}`, "--headless=new", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-gpu", FLOW_URL], { windowsHide: true, stdio: "ignore" });
      child.on?.("error", () => {});
      const t0 = now(); let seen = "", since = t0, outcome = "";
      while (now() - t0 < CHECK_MS && !outcome) {
        await new Promise((r) => setTimeout(r, 700));
        let pages = [];
        try { pages = (await (await fetchFn(`http://127.0.0.1:${port}/json/list`)).json()).filter((p) => p.type === "page"); } catch { continue; }
        const urls = pages.map((p) => String(p.url)).filter((u) => /^https?:/.test(u));
        if (urls.some((u) => /^https:\/\/accounts\.google\.com\//.test(u))) { outcome = "out"; break; }
        const cur = urls.join(" ");
        if (cur !== seen) { seen = cur; since = now(); }
        else if (/^https:\/\/([\w-]+\.)?(flow\.google\.com|labs\.google)\//.test(urls[0] || "") && now() - since >= STABLE_MS) outcome = "stay";
      }
      kill(child, plat); child = null;
      await new Promise((r) => setTimeout(r, 1200)); // let the profile unlock and write cookies
      if (outcome === "out") return { state: "logged_out", detail: "Google yêu cầu đăng nhập." };
      if (outcome !== "stay") return { state: "error", detail: "Không mở được Flow trong 25 giây (mạng chậm?). Bấm Kiểm tra lại." };
      const c = await googleCookie(dir);
      if (c === false) return { state: "logged_out", detail: "Flow mở được nhưng chưa có phiên đăng nhập Google." };
      return { state: "logged_in", detail: "Đã đăng nhập Google Flow trong Chrome riêng." };
    } catch (e) { return { state: "error", detail: String(e.message || e).slice(0, 200) }; }
    finally { kill(child, plat); }
  }

  // fresh = bypass the cache. Only logged_in is cached (60 s); one check at a time.
  async function status({ fresh = false } = {}) {
    if (!fresh && cache && now() - cache.at < CACHE_MS) return { state: cache.state, detail: cache.detail };
    if (checking) return checking;
    checking = check().then((r) => { cache = r.state === "logged_in" ? { ...r, at: now() } : null; return r; }).finally(() => { checking = null; });
    return checking;
  }

  // A NORMAL Chrome window (no automation or remote-debugging flags) for the person to sign in by hand.
  function open() {
    if (runActive()) return { ok: false, status: 409, error: "Đang có lượt Claude chạy: chờ xong hoặc bấm Dừng rồi mở Chrome đăng nhập." };
    if (checking) return { ok: false, status: 409, error: "Đang kiểm tra đăng nhập: chờ vài giây rồi thử lại." };
    if (profileLocked(dir)) return { ok: false, status: 409, error: "Chrome riêng đã mở: dùng cửa sổ đó, hoặc đóng nó trước." };
    const chrome = findChrome({ plat });
    if (!chrome) return { ok: false, status: 400, error: "Không tìm thấy Google Chrome (đặt PR_CHROME_PATH nếu cài chỗ khác)." };
    if (opened && now() - opened < 5000) return { ok: false, status: 429, error: "Vừa mở xong, chờ vài giây." };
    try {
      mkdirSync(dir, { recursive: true });
      const p = spawnFn(chrome, [`--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", ...WINDOW_ARGS, flowOpenUrl(chosenAccount())], { detached: true, stdio: "ignore" });
      p.on?.("error", () => {}); p.unref?.(); opened = now(); cache = null;
      return { ok: true, status: 200 };
    } catch (e) { return { ok: false, status: 500, error: String(e.message || e).slice(0, 200) }; }
  }
  return { status, open, dir, locked: () => profileLocked(dir) };
}

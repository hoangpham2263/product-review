// Which browser Claude (Flow) drives: the person's everyday Chrome through the Playwright extension (default, the profile is chosen
// from the profiles installed on this machine) or the tool's own separate Chrome profile (workspace/chrome-profile).
// Saved in workspace/config/flow-browser.json; nothing secret is stored (a mode and a profile folder name).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const PLAYWRIGHT_EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm"; // "Playwright MCP Bridge"
export const DEFAULT_BROWSER = { mode: "extension", profile: "Profile 1" };
const PROFILE_RE = /^(Default|Profile \d{1,3})$/;
const fileOf = (workspace) => join(workspace, "config", "flow-browser.json");

export function readFlowBrowser(workspace) {
  try {
    const j = JSON.parse(readFileSync(fileOf(workspace), "utf8"));
    return { mode: j.mode === "own" ? "own" : "extension", profile: PROFILE_RE.test(String(j.profile || "")) ? j.profile : DEFAULT_BROWSER.profile };
  } catch { return { ...DEFAULT_BROWSER }; }
}

export function saveFlowBrowser(workspace, input = {}) {
  const cur = readFlowBrowser(workspace);
  const mode = input.mode === undefined ? cur.mode : input.mode;
  if (mode !== "own" && mode !== "extension") throw new Error("mode must be own or extension.");
  const profile = input.profile === undefined ? cur.profile : String(input.profile);
  if (!PROFILE_RE.test(profile)) throw new Error("profile must be Default or Profile <number>.");
  const out = { mode, profile };
  mkdirSync(dirname(fileOf(workspace)), { recursive: true });
  writeFileSync(fileOf(workspace), JSON.stringify(out, null, 2));
  return out;
}

export function chromeUserDataDir({ plat = process.platform, env = process.env, home = homedir() } = {}) {
  if (env.PR_CHROME_USER_DATA_DIR) return env.PR_CHROME_USER_DATA_DIR;
  if (plat === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Google", "Chrome", "User Data");
  if (plat === "darwin") return join(home, "Library", "Application Support", "Google", "Chrome");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "google-chrome");
}

// Google accounts signed in inside one profile: <User Data>/<folder>/Preferences account_info[].email (emails only, never cookies or tokens),
// the profile's primary account (Local State user_name) first. Lowercase.
export function profileAccounts(dir, folder, primary = "", { read = (f) => readFileSync(f, "utf8") } = {}) {
  const found = [];
  try { for (const a of JSON.parse(read(join(dir, folder, "Preferences")).replace(/^\uFEFF/, "")).account_info || []) if (a && typeof a.email === "string" && a.email.includes("@")) found.push(a.email.toLowerCase()); } catch {}
  const first = String(primary || "").toLowerCase();
  return [...new Set([...(first ? [first] : []), ...found])];
}

// The Chrome profiles installed on this machine (Local State): [{ folder, name, email, accounts, playwright_extension }].
export function localChromeProfiles({ plat = process.platform, env = process.env, home = homedir(), exists = existsSync, read = (f) => readFileSync(f, "utf8") } = {}) {
  const dir = chromeUserDataDir({ plat, env, home });
  let cache = {};
  try { cache = JSON.parse(read(join(dir, "Local State"))).profile?.info_cache || {}; } catch {}
  const profiles = Object.entries(cache).map(([folder, v]) => ({ folder, name: String(v?.name || v?.gaia_name || ""), email: String(v?.user_name || ""), accounts: profileAccounts(dir, folder, v?.user_name, { read }), playwright_extension: exists(join(dir, folder, "Extensions", PLAYWRIGHT_EXTENSION_ID)) }))
    .sort((a, b) => (a.folder === "Default" ? -1 : b.folder === "Default" ? 1 : a.folder.localeCompare(b.folder, undefined, { numeric: true })));
  return { dir, profiles };
}

// Sessions of Product Review: several app windows from ONE source, each with its own workspace, port, agent and queue.
// - session "" (default) = the existing workspace/ ; any other name = workspace-sessions/<name>/ (env PR_SESSION, or PR_WORKSPACE for a path).
// - Shared on purpose (always <root>/workspace): config/, projects/, source-photos/, chrome-profile/, the AI usage log, the session registry and the locks.
// - Per session: urls.txt, reference-inputs/, output/, temp/, rejected/, exports/, logs/, runs/, tmp/ (see AGENTS.md, "Phiên").
// The registry (workspace/config/sessions.json) lists the running windows (stt, session, port, pid ...); a dead pid is dropped.
// Locks (workspace/config/locks/<kind>-<name>.json): one project, or the own Chrome profile, is used by one live session at a time.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const SESSION_RE = /^[a-z0-9][a-z0-9-]{0,59}$/; // a session named after a project id can be as long as one
export const GROUP_COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

// "" = the default session.
export function currentSession(env = process.env) {
  const s = String(env.PR_SESSION || "").trim().toLowerCase();
  return SESSION_RE.test(s) ? s : "";
}
export const sessionLabel = (session) => session || "default";
export const sharedWorkspace = (root) => join(root, "workspace");
export function sessionWorkspace(root, session, env = process.env) {
  if (env.PR_WORKSPACE) return resolve(env.PR_WORKSPACE);
  return session ? join(root, "workspace-sessions", session) : sharedWorkspace(root);
}

const alive = (pid) => { if (!pid) return false; try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === "EPERM"; } };
const configDir = (root) => join(sharedWorkspace(root), "config");
const registryFile = (root) => join(configDir(root), "sessions.json");

function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { return fallback; } }
function writeJson(file, data) {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}
// Small cross-process lock around a read-modify-write (wx file, stale after 5 s).
function withLock(file, fn) {
  const lock = `${file}.lock`;
  mkdirSync(join(file, ".."), { recursive: true });
  const until = Date.now() + 3000;
  for (;;) {
    try { writeFileSync(lock, String(process.pid), { flag: "wx" }); break; }
    catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 5000) rmSync(lock, { force: true }); } catch {}
      if (Date.now() > until) break; // give up waiting: go on without the lock rather than hang
      const t = Date.now() + 40; while (Date.now() < t) { /* short spin */ }
    }
  }
  try { return fn(); } finally { try { rmSync(lock, { force: true }); } catch {} }
}

// ----- registry -----
export function listSessions(root) {
  const list = readJson(registryFile(root), []);
  return Array.isArray(list) ? list.filter((e) => e && alive(e.pid)) : [];
}
// Gives this window the first free number (1, 2, 3 ...) among the live sessions; kept while the window lives.
export function registerSession(root, { session, port, pid = process.pid, extra = {} }) {
  return withLock(registryFile(root), () => {
    const live = listSessions(root).filter((e) => !(e.session === session));
    const used = new Set(live.map((e) => e.stt));
    let stt = 1; while (used.has(stt)) stt++;
    const entry = { session, stt, port, pid, started: new Date().toISOString(), ...extra };
    writeJson(registryFile(root), [...live, entry].sort((a, b) => a.stt - b.stt));
    return entry;
  });
}
export function updateSession(root, session, pid, patch) {
  return withLock(registryFile(root), () => {
    const list = listSessions(root);
    const e = list.find((x) => x.session === session && x.pid === pid);
    if (!e) return null;
    Object.assign(e, patch);
    writeJson(registryFile(root), list);
    return e;
  });
}
export function unregisterSession(root, session, pid = process.pid) {
  try { withLock(registryFile(root), () => writeJson(registryFile(root), listSessions(root).filter((e) => !(e.session === session && e.pid === pid)))); } catch {}
}

// ----- locks (a project, or the own Chrome profile) -----
const lockFile = (root, kind, name) => join(configDir(root), "locks", `${kind}-${String(name).replace(/[^a-z0-9._-]/gi, "_")}.json`);
// ok:false + holder when ANOTHER live session holds it. The same session may re-claim.
// tag: which runner of the session holds it ("main" or "light"); releaseLocks(..., tag) frees only that runner's locks.
export function claimLock(root, kind, name, session, pid = process.pid, tag = "") {
  const file = lockFile(root, kind, name);
  return withLock(file, () => {
    const cur = readJson(file, null);
    if (cur && alive(cur.pid) && !(cur.session === session && cur.pid === pid)) return { ok: false, holder: cur };
    writeJson(file, { kind, name, session, pid, tag, at: new Date().toISOString() });
    return { ok: true };
  });
}
export function lockHolder(root, kind, name, session, pid = process.pid) {
  const cur = readJson(lockFile(root, kind, name), null);
  return cur && alive(cur.pid) && !(cur.session === session && cur.pid === pid) ? cur : null;
}
export function releaseLocks(root, session, pid = process.pid, tag = "") {
  const dir = join(configDir(root), "locks");
  let files = []; try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return; }
  for (const f of files) {
    const cur = readJson(join(dir, f), null);
    if (cur && cur.session === session && cur.pid === pid && (!tag || cur.tag === tag)) { try { rmSync(join(dir, f), { force: true }); } catch {} }
  }
}

// ----- projects: a window "has" the project selected in its Dự án popup (registry field project); a run on it holds a lock -----
// null when free; else { session, via: "window" | "run" } of ANOTHER live session using it.
export function projectBusyBy(root, project, session, pid = process.pid) {
  const s = listSessions(root).find((e) => e.project === project && !(e.session === session && e.pid === pid));
  if (s) return { session: s.session, via: "window" };
  const h = lockHolder(root, "project", project, session, pid);
  return h ? { session: h.session, via: "run" } : null;
}
export function setSessionProject(root, session, pid, project) { return updateSession(root, session, pid, { project: project || "" }); }

// ----- Chrome tab group of a run: "Product Review · <session> · #<n> · HH:mm" -----
const counterFile = (workspace) => join(workspace, "runs", "group-counter.json");
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
export function groupFor(n, session, now = new Date()) {
  return { n, name: `Product Review · ${sessionLabel(session)} · #${n} · ${hhmm(now)}`, color: GROUP_COLORS[(n - 1) % GROUP_COLORS.length] };
}
export const peekGroup = (workspace, session, now = new Date()) => groupFor((readJson(counterFile(workspace), { n: 0 }).n || 0) + 1, session, now);
export function takeGroup(workspace, session, now = new Date()) {
  const n = (readJson(counterFile(workspace), { n: 0 }).n || 0) + 1;
  writeJson(counterFile(workspace), { n });
  return groupFor(n, session, now);
}

// Text of the window title and header badge.
export const sessionTitle = ({ stt, session, profileLabel, project = "" }) => `Product Review · #${stt || "?"} · ${sessionLabel(session)} · ${profileLabel || ""}`.replace(/ · $/, "") + (project && project !== session ? ` · ${project}` : "");
export const profileLabelOf = (browser, profiles = []) => {
  if (!browser || browser.mode === "own") return "Chrome riêng";
  const p = profiles.find((x) => x.folder === browser.profile);
  return p ? `${p.email || p.name || p.folder} (${p.folder})` : String(browser.profile || "");
};

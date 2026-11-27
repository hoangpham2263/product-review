#!/usr/bin/env node
// Human pacing gate for Google Flow submissions (Product Review) (Flow flags bursts as "unusual activity") + the machine-wide download lock.
//   node core/flow-pace.mjs gate --tag <item id>   BLOCKS until a human-like moment, records the submission, prints one JSON line.
//   node core/flow-pace.mjs status                 prints the recent submissions (no waiting).
//   node core/flow-pace.mjs reset                  clears the record (a new Flow project / a new run).
//   node core/flow-pace.mjs download-lock acquire --tag <id> [--stale-min 5] [--wait-min 10]   BLOCKS until no other window is downloading.
//   node core/flow-pace.mjs download-lock release --tag <id>
//   node core/flow-pace.mjs download-collect --tag <id> [--dest <dir>] [--wait-s 30] [--since-ms t --expect <file title> --tile <label>] (collect prints them)   after the download click: wait for the file, move it to <dest>/<id>.<ext>, check it, release the lock.
// The agent runs `gate` right BEFORE every prompt it submits and submits right after it returns. Nothing else paces the run, so the
// pauses cannot be skipped by writing a faster browser script. Rules (fast, but never a rhythm):
//   - 5-12 s random gap between two prompts;
//   - a group is 2-3 prompts (random, user 2026-11-23), gaps stay random; after a group a further 20-45 s pause (the agent should download/register that group meanwhile);
//   - never more than 8 prompts inside 2 minutes.
// The pace state (workspace/tmp/flow-pace.json of the install) is SHARED by every session on purpose: the Flow rate limit is respected by all
// windows together. Two gates at the same moment cannot race: the read-modify-write happens under a lock file (O_EXCL) and the sleeping happens
// OUTSIDE the lock; the state is written through a temp file + rename.
// The download lock (one file in the OS temp folder, shared by every window of the machine) keeps two windows from taking each other's file out of the
// shared Downloads folder: hold it around each download + move. A lock older than N minutes, or of a dead process, is stale and taken over.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// PER CHROME PROFILE (user 2026-11-23): Google rate-limits per account, and each Flow profile holds one account, so every profile has its
// own pace (gaps, groups of 2-3, max 8 prompts in 2 minutes) and runs on different profiles no longer wait for each other. The state lives
// in the OS temp folder (machine-wide), so both tools (product-review and social-autopilot) on the SAME profile still share one pace.
// The profile: PLAYWRIGHT_MCP_PROFILE_DIR_NAME, else this session's config/flow-browser.json (PR_WORKSPACE); unknown = the old shared file.
function flowProfile() {
  if (process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME) return process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME;
  try {
    const fb = JSON.parse(fs.readFileSync(path.join(process.env.PR_WORKSPACE || path.join(ROOT, 'workspace'), 'config', 'flow-browser.json'), 'utf8').replace(/^﻿/, ''));
    return fb.mode === 'own' ? 'own-chrome' : String(fb.profile || '');
  } catch { return ''; }
}
const PROFILE = flowProfile();
const FILE = process.env.PR_FLOW_PACE_FILE || (PROFILE ? path.join(os.tmpdir(), 'flow-pace', PROFILE.replace(/[^\w.-]+/g, '_') + '.json') : path.join(ROOT, 'workspace', 'tmp', 'flow-pace.json')); // the env overrides are for smoke tests only
const DOWNLOAD_LOCK = process.env.PR_FLOW_DOWNLOAD_LOCK || path.join(os.tmpdir(), 'flow-download.lock');
const rnd = (a, b) => Math.round(a + Math.random() * (b - a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { if (!pid) return false; try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const out = (o) => console.log(JSON.stringify(o));

function load() {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { times: Array.isArray(j.times) ? j.times : [], in_group: j.in_group || 0, group_size: j.group_size || rnd(2, 3), tags: j.tags || [] }; }
  catch { return { times: [], in_group: 0, group_size: rnd(2, 3), tags: [] }; }
}
function save(st) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st));
  fs.renameSync(tmp, FILE);
}

// Lock file created with O_EXCL; a lock older than staleMs (a crashed process) is removed. Resolves fn()'s result.
async function withFileLock(lockPath, fn, { waitMs = 10000, staleMs = 15000 } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); break; }
    catch {
      try { if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) { fs.rmSync(lockPath, { force: true }); continue; } } catch { continue; }
      if (Date.now() > until) throw new Error('flow-pace lock busy');
      await sleep(30 + rnd(0, 40));
    }
  }
  try { return await fn(); } finally { try { fs.rmSync(lockPath, { force: true }); } catch {} }
}

export function requiredWaitMs(st, now = Date.now()) {
  const last = st.times[st.times.length - 1];
  let wait = 0;
  if (last) {
    const sinceLast = now - last;
    const gap = st.in_group >= st.group_size ? rnd(20, 45) * 1000 : rnd(5, 12) * 1000;
    wait = Math.max(0, gap - sinceLast);
  }
  const recent = st.times.filter((t) => now - t < 120000);
  if (recent.length >= 8) wait = Math.max(wait, 120000 - (now - recent[recent.length - 8]) + 1000);
  return wait;
}

async function gate(args) {
  const tag = String(args.tag || '').trim();
  if (!tag) { out({ ok: false, error: 'Thiếu --tag <draft>#<n>.' }); process.exit(1); }
  let waitedMs = 0;
  for (let attempt = 0; attempt < 400; attempt++) {
    // decide (and record when it is time) under the lock; sleep OUTSIDE it, then decide again: another window may have gated meanwhile
    const r = await withFileLock(`${FILE}.lock`, () => {
      const st = load();
      const waitMs = requiredWaitMs(st);
      if (waitMs > 0) return { wait: waitMs };
      const now = Date.now();
      if (st.in_group >= st.group_size) { st.in_group = 0; st.group_size = rnd(2, 3); st.tags = []; }
      st.in_group += 1; st.tags.push(tag);
      st.times = [...st.times.filter((t) => now - t < 600000), now];
      save(st);
      return { done: { ok: true, tag, waited_s: Math.round(waitedMs / 1000), prompt_in_group: st.in_group, group_size: st.group_size, last_of_group: st.in_group >= st.group_size,
        note: st.in_group >= st.group_size ? 'Last prompt of this group: submit it, wait for the group to render, download + register it; the next gate adds a 20-45 s pause.' : 'Submit this prompt now.' } };
    });
    if (r.done) { out(r.done); return; }
    const ms = r.wait + rnd(0, 1500);
    waitedMs += ms;
    await sleep(ms);
  }
  out({ ok: false, error: 'gate gave up waiting (too many windows submitting at once?).' }); process.exit(1);
}

async function downloadLock(action, args) {
  const tag = String(args.tag || '').trim();
  if (!tag) { out({ ok: false, error: 'Thiếu --tag <id>.' }); process.exit(1); }
  if (action === 'release') {
    let cur = null; try { cur = JSON.parse(fs.readFileSync(DOWNLOAD_LOCK, 'utf8')); } catch {}
    if (!cur) { out({ ok: true, released: false, note: 'no lock held' }); return; }
    if (cur.tag !== tag && !args.force) { out({ ok: false, error: `The lock belongs to ${cur.tag}, not ${tag}.` }); process.exit(1); }
    try { fs.rmSync(DOWNLOAD_LOCK, { force: true }); } catch {}
    out({ ok: true, released: true, tag }); return;
  }
  if (action !== 'acquire') { out({ ok: false, error: 'Lệnh: download-lock acquire|release --tag <id>' }); process.exit(1); }
  const staleMs = Math.max(1, Number(args['stale-min']) || 5) * 60000, giveUp = Date.now() + Math.max(1, Number(args['wait-min']) || 10) * 60000;
  const started = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(DOWNLOAD_LOCK, JSON.stringify({ tag, pid: process.ppid || process.pid, session: process.env.PR_SESSION || '', at: new Date().toISOString() }), { flag: 'wx' });
      out({ ok: true, tag, waited_s: Math.round((Date.now() - started) / 1000), note: 'Hold it only for ONE download: click download, move the new file into your own folder at once, then release.' });
      return;
    } catch {
      let cur = null; try { cur = JSON.parse(fs.readFileSync(DOWNLOAD_LOCK, 'utf8')); } catch {}
      let age = 0; try { age = Date.now() - fs.statSync(DOWNLOAD_LOCK).mtimeMs; } catch { continue; }
      // only the age decides: the process that acquired the lock (a short shell command) is gone long before the download ends, so its pid says nothing
      if (age > staleMs) { try { fs.rmSync(DOWNLOAD_LOCK, { force: true }); } catch {} continue; }
      if (Date.now() > giveUp) { out({ ok: false, error: `Download lock still held by ${cur?.tag || '?'} (${cur?.session || 'default'}) after the wait; try again.` }); process.exit(1); }
      await sleep(300 + rnd(0, 200));
    }
  }
}


// download-collect: ONE call after the download click = wait for the new file in Downloads, move it into <dest>/<tag>.<ext>, check it is a real image (size read from its header)
// and RELEASE the download lock (always, so the lock is held only for the click + the move, never while the agent looks at the picture). Pace and lock semantics are unchanged.
function imageInfo(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length;) { if (buf[i] !== 0xff) { i++; continue; } const m = buf[i + 1]; if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: 'jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }; i += 2 + buf.readUInt16BE(i + 2); }
    return { type: 'jpeg', width: 0, height: 0 };
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { type: 'webp', width: 0, height: 0 };
  return null;
}
async function downloadCollect(args) {
  const tag = String(args.tag || '').trim();
  if (!tag) { out({ ok: false, error: 'Thiếu --tag <id>.' }); process.exit(1); }
  const dir = args.dir || process.env.PR_DOWNLOADS_DIR || path.join(os.homedir(), 'Downloads');
  const dest = args.dest || path.join(process.env.PR_WORKSPACE || path.join(ROOT, 'workspace'), 'tmp', 'flow-downloads');
  const since = args['since-ms'] ? Number(args['since-ms']) : Date.now() - 120000, until = Date.now() + Math.max(3, Number(args['wait-s']) || 30) * 1000;
  // --expect <Edit_title_image>: the file name Flow gives the tile collect clicked (collect prints it). A fresh file with ANOTHER title is another item's download:
  // never taken when it competes with others; a single fresh file with a different name is taken but flagged (the naming of Flow is not guaranteed).
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const expect = norm(args.expect === true ? '' : args.expect);
  let found = null, fresh = [];
  try {
    while (!found && Date.now() < until) {
      const cands = [];
      for (const n of fs.readdirSync(dir)) {
        if (!/\.(png|jpe?g|webp)$/i.test(n) || /^pr-ref-.*-[12]\.(png|jpe?g|webp)$/i.test(n)) continue;
        let st; try { st = fs.statSync(path.join(dir, n)); } catch { continue; }
        if (st.isFile() && st.mtimeMs >= since && st.size > 2000) cands.push({ n, mtime: st.mtimeMs, size: st.size, tagged: n.includes(tag), named: !!expect && norm(n).startsWith(expect) });
      }
      cands.sort((a, b) => (b.tagged - a.tagged) || (b.named - a.named) || (b.mtime - a.mtime));
      fresh = cands;
      const c = expect && cands.length > 1 && !cands[0].named && !cands[0].tagged ? null : cands[0];
      if (c) { await sleep(400); try { if (fs.statSync(path.join(dir, c.n)).size === c.size) { found = c; break; } } catch {} }
      else await sleep(400);
    }
    if (!found && fresh.length > 1) { out({ ok: false, error: `Several new images in ${dir} and none is named like the tile (${expect}): not taking a file that may belong to another item. Remove/collect them, then collect this item again.`, cause: 'AMBIGUOUS_DOWNLOAD', files: fresh.map((c) => c.n) }); return; }
    if (!found) { out({ ok: false, error: 'No new image appeared in ' + dir + ' within the wait (is the 1K download menu item clicked?).', cause: 'NO_DOWNLOAD' }); return; }
    fs.mkdirSync(dest, { recursive: true });
    const ext = path.extname(found.n).toLowerCase(), target = path.join(dest, tag + ext);
    try { fs.renameSync(path.join(dir, found.n), target); } catch { fs.copyFileSync(path.join(dir, found.n), target); fs.rmSync(path.join(dir, found.n), { force: true }); }
    const buf = fs.readFileSync(target), info = imageInfo(buf);
    if (!info) { out({ ok: false, error: 'The moved file is not a PNG/JPEG/WebP image.', cause: 'NOT_IMAGE', path: target }); return; }
    const nameMatch = expect ? found.named : null;
    // sidecar <dest>/<tag>.download.json: register-image records where the item's picture came from (and refuses a file collected for another item)
    try { fs.writeFileSync(path.join(dest, tag + '.download.json'), JSON.stringify({ tag, from: found.n, tile: args.tile === true ? '' : String(args.tile || ''), expect, name_match: nameMatch, at: new Date().toISOString() })); } catch {}
    out({ ok: true, tag, path: target, bytes: buf.length, type: info.type, width: info.width, height: info.height, from: found.n, tagged: found.tagged, name_match: nameMatch, lock_released: true,
      ...(nameMatch === false ? { warning: `The file name ${found.n} does not match the tile (${expect}): LOOK carefully that it is THIS item's product and wording.` } : {}),
      next: 'LOOK at the picture once (Read): read the sign from THIS picture, then register-image -Item ' + tag + ' -From <path>' });
  } finally { try { const cur = JSON.parse(fs.readFileSync(DOWNLOAD_LOCK, 'utf8')); if (cur.tag === tag || args.force) fs.rmSync(DOWNLOAD_LOCK, { force: true }); } catch {} }
}

// The Flow project of each Chrome profile (user 2026-11-23: set the project up ONCE and reuse it every run, no new project and no new settings each time):
// workspace/config/flow-projects.json { "<profile>": { "url": "https://flow.google.com/project/<id>", "saved": "<iso time>" } }.
const PROJECTS_FILE = path.join(ROOT, 'workspace', 'config', 'flow-projects.json');
const readProjects = () => { try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8').replace(/^﻿/, '')) || {}; } catch { return {}; } };
function projectCmd(sub, args) {
  const key = PROFILE || 'shared', all = readProjects();
  if (sub === 'get') return out({ ok: true, profile: key, url: all[key]?.url || '', saved: all[key]?.saved || '', note: all[key]?.url ? 'Open this URL directly (it keeps its settings); only if it fails to open, create a new project and run: project set --url <new url>.' : 'No saved project for this profile: create one, then run: project set --url <its url>.' });
  if (sub === 'set') {
    const url = String(args.url || '').trim();
    if (!/^https:\/\/flow\.google\.com\/(?:[a-z]{2}\/)?project\/[\w-]{8,}/i.test(url)) { out({ ok: false, error: 'project set --url <https://flow.google.com/project/<id>>' }); process.exit(1); }
    all[key] = { url: url.split(/[?#]/)[0], saved: new Date().toISOString() };
    fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true }); fs.writeFileSync(PROJECTS_FILE, JSON.stringify(all, null, 2));
    return out({ ok: true, profile: key, url: all[key].url });
  }
  if (sub === 'clear') { delete all[key]; fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true }); fs.writeFileSync(PROJECTS_FILE, JSON.stringify(all, null, 2)); return out({ ok: true, profile: key, cleared: true }); }
  out({ ok: false, error: 'Lệnh: project get | project set --url <url> | project clear' }); process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
const positional = [];
for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) { args[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; } else positional.push(rest[i]); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (cmd === 'gate') await gate(args);
  else if (cmd === 'download-lock') await downloadLock(positional[0], args);
  else if (cmd === 'download-collect') await downloadCollect(args);
  else if (cmd === 'status') { const st = load(); out({ ok: true, profile: PROFILE || 'shared', file: FILE, in_group: st.in_group, group_size: st.group_size, last_2min: st.times.filter((t) => Date.now() - t < 120000).length, total_recorded: st.times.length }); }
  else if (cmd === 'project') projectCmd(rest.find((x) => !x.startsWith('--')), args);
  else if (cmd === 'reset') { save({ times: [], in_group: 0, group_size: rnd(2, 3), tags: [] }); out({ ok: true, reset: true }); }
  else { out({ ok: false, error: 'Lệnh: project get|set --url <url>|clear | gate --tag <item id> | download-lock acquire|release --tag <id> | download-collect --tag <id> [--dest d] | status | reset' }); process.exit(1); }
}

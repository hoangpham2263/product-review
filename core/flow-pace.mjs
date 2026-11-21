#!/usr/bin/env node
// Human pacing gate for Google Flow submissions (Product Review) (Flow flags bursts as "unusual activity") + the machine-wide download lock.
//   node core/flow-pace.mjs gate --tag <item id>   BLOCKS until a human-like moment, records the submission, prints one JSON line.
//   node core/flow-pace.mjs status                 prints the recent submissions (no waiting).
//   node core/flow-pace.mjs reset                  clears the record (a new Flow project / a new run).
//   node core/flow-pace.mjs download-lock acquire --tag <id> [--stale-min 5] [--wait-min 10]   BLOCKS until no other window is downloading.
//   node core/flow-pace.mjs download-lock release --tag <id>
// The agent runs `gate` right BEFORE every prompt it submits and submits right after it returns. Nothing else paces the run, so the
// pauses cannot be skipped by writing a faster browser script. Rules (fast, but never a rhythm):
//   - 5-12 s random gap between two prompts;
//   - a group is 3-4 prompts (random); after a group a further 20-45 s pause (the agent should download/register that group meanwhile);
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
const FILE = process.env.PR_FLOW_PACE_FILE || path.join(ROOT, 'workspace', 'tmp', 'flow-pace.json'); // the env overrides are for smoke tests only
const DOWNLOAD_LOCK = process.env.PR_FLOW_DOWNLOAD_LOCK || path.join(os.tmpdir(), 'flow-download.lock');
const rnd = (a, b) => Math.round(a + Math.random() * (b - a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { if (!pid) return false; try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const out = (o) => console.log(JSON.stringify(o));

function load() {
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { times: Array.isArray(j.times) ? j.times : [], in_group: j.in_group || 0, group_size: j.group_size || rnd(3, 4), tags: j.tags || [] }; }
  catch { return { times: [], in_group: 0, group_size: rnd(3, 4), tags: [] }; }
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
      if (st.in_group >= st.group_size) { st.in_group = 0; st.group_size = rnd(3, 4); st.tags = []; }
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

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
const positional = [];
for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) { args[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; } else positional.push(rest[i]); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (cmd === 'gate') await gate(args);
  else if (cmd === 'download-lock') await downloadLock(positional[0], args);
  else if (cmd === 'status') { const st = load(); out({ ok: true, in_group: st.in_group, group_size: st.group_size, last_2min: st.times.filter((t) => Date.now() - t < 120000).length, total_recorded: st.times.length }); }
  else if (cmd === 'reset') { save({ times: [], in_group: 0, group_size: rnd(3, 4), tags: [] }); out({ ok: true, reset: true }); }
  else { out({ ok: false, error: 'Lệnh: gate --tag <item id> | download-lock acquire|release --tag <id> | status | reset' }); process.exit(1); }
}

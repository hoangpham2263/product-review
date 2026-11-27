// Ready-made Playwright snippets for ONE item in Google Flow (Vietnamese UI), written next to the item's brief by `flow-brief`.
// Why: the agent used ~16 tool calls and ~3.4 min per item, nearly all of it model turns (see docs/flow-ui-notes.md "Speed"). These files fold the proven UI steps of
// docs/flow-ui-notes.md into 4 calls: ready (no side effect), prep (aspect + 2 uploads + 2 chips in order + prompt typed), submit (Enter + warning scan), collect (open the
// result tile + 1K download). The agent runs them with browser_run_code_unsafe { filename: <path> }.
// They never submit by themselves: the pacing gate (`node core/flow-pace.mjs gate --tag <id>`) is a separate command the agent runs between prep and submit, exactly as before.
// One item per snippet, no loops over items, tab brought to front each time.
import fs from 'node:fs';
import path from 'node:path';

const q = (s) => JSON.stringify(String(s));
const HEAD = `await page.bringToFront(); const sleep = (ms) => page.waitForTimeout(ms);
  if (/\\/edit\\//.test(page.url())) { await page.getByRole('button', { name: 'Nút quay lại để quay về trang trước' }).evaluate((b) => b.click()); await sleep(2500); }`;
const WARN = `/bất thường|hạn mức|không thể tạo|vi phạm|chính sách|unusual activity|quota|violate/i`;

// Words that name THIS item (from its id and product name) minus words every sign shares: used to tell result tiles apart ("Edit <title> image" comes from the prompt).
const GENERIC = new Set(['neon', 'sign', 'signs', 'light', 'lights', 'led', 'custom', 'personalized', 'personalised', 'wall', 'decor', 'image', 'edit', 'the', 'and', 'with', 'for', 'your', 'name', 'names', 'art', 'gift', 'photo', 'product']);
export function itemWords(...texts) {
  const out = new Set();
  for (const t of texts) for (const w of String(t || '').toLowerCase().split(/[^a-z]+/)) if (w.length >= 3 && !GENERIC.has(w)) out.add(w);
  return [...out].slice(0, 12);
}

// PICK (shared by ready and collect): which result tile belongs to THIS item. Several prompts can be in flight, and a finished tile can land next to ANOTHER item's
// references (bug 2026-11-26: two items registered a neighbour's picture). Evidence, in order: tiles that existed before this item's submit are not its result (snapshot
// saved by submit in sessionStorage); a tile already collected for another item is not (claimed map); a tile whose title carries another in-flight item's words and not
// this item's is not. Among what is left: the tile next to this item's own references (when no earlier prompt is still uncollected, or its title names this item), else
// the single tile whose title names this item, else the single candidate when no earlier prompt is still uncollected. Anything else = 'ambiguous': never guess, collect again later (other items' collects shrink the set).
const PICK = `const pick = (st, me, words) => {
    const sc = (t, ws) => ws.filter((w) => t.label.toLowerCase().includes(w)).length;
    const log = st.log.filter((e) => e.f2 !== me && !Object.values(st.claimed).includes(e.f2));
    const otherWords = [...new Set(log.flatMap((e) => e.words || []))].filter((w) => !words.includes(w));
    const busy = st.tiles.filter((t) => t.busy).length;
    let c = st.tiles.filter((t) => t.key && !t.busy && (!st.claimed[t.key] || st.claimed[t.key] === me));
    if (st.rec) c = c.filter((t) => !st.rec.before.includes(t.key));
    c = c.filter((t) => !(sc(t, otherWords) > 0 && sc(t, words) === 0));
    if (!c.length) return { wait: true, busy };
    // an earlier prompt still uncollected (submitted in the last 10 minutes) may own the tile next to this item's references: then the tile must name this item
    const earlier = st.rec ? log.filter((e) => e.at < st.rec.at && st.rec.at - e.at < 600000) : log;
    const adj = c.find((t) => t.i === st.own - 1);
    if (adj && (sc(adj, words) > sc(adj, otherWords) || (!earlier.length && sc(adj, otherWords) === 0))) return { tile: adj, why: st.rec ? 'new since this prompt, next to its own references' : 'next to its own references (no submit record)' };
    const named = c.filter((t) => sc(t, words) > 0 && sc(t, words) > sc(t, otherWords));
    if (named.length === 1) return { tile: named[0], why: 'title names this item' };
    if (c.length === 1 && st.rec && !earlier.length) return { tile: c[0], why: 'only new tile since this prompt, no earlier prompt uncollected' };
    return { ambiguous: c.map((t) => ({ index: t.i, label: t.label })), uncollected_earlier: earlier.map((e) => e.f2), busy };
  };`;
// Reads the grid + the per-tab records (sessionStorage of the Flow tab: pr-flow:<f2> = this item's submit snapshot, pr-flow-log = submitted items, pr-flow-claimed = tile -> item).
const STATE = `page.evaluate((f2) => { const gs = [...document.querySelectorAll('[role=group]')]; const own = gs.findIndex((g) => g.getAttribute('aria-label') === f2);
    const tiles = gs.map((g, i) => { const img = g.querySelector('img'); const label = g.getAttribute('aria-label') || ''; return { i, label, key: img && img.naturalWidth > 0 && /^http/.test(img.src || '') ? img.src.split('=')[0] : '', busy: /%/.test(g.innerText) }; }).filter((t) => !/^pr-ref-/.test(t.label));
    const get = (k, d) => { try { return JSON.parse(sessionStorage.getItem(k) || 'null') || d; } catch { return d; } };
    return { own, tiles, rec: get('pr-flow:' + f2, null), log: get('pr-flow-log', []), claimed: get('pr-flow-claimed', {}) }; }`;

export function buildFlowSnippets({ aspect = '', uploads = [], prompt = '', words = [] } = {}) {
  const files = uploads.map((p) => path.basename(String(p)));
  const [f1, f2] = files;
  if (!f1 || !f2 || !prompt) throw new Error('flow snippets need 2 uploads and the prompt');
  const W = JSON.stringify((words || []).map((w) => String(w).toLowerCase()));
  const lib = (name) => `page.locator('[role=group][aria-label=${q(name)}]:has(img[src^="http"])')`;
  const ready = `async (page) => { ${HEAD}
  ${PICK}
  const st = await ${STATE}, ${q(f2)});
  if (st.own < 0) return { item_ready: false, info: { err: 'no upload tile of this item' } };
  const p = pick(st, ${q(f2)}, ${W});
  return { item_ready: !!p.tile, info: p.tile ? { label: p.tile.label, why: p.why } : p }; }`;
  const prep = `async (page) => { ${HEAD}
  await page.keyboard.press('Escape'); await sleep(300);
  const left = await page.locator('img[alt="Hình ảnh thành phần"]').count();
  if (left) return { stop: 'chips-left', chips: left };
  const settings = page.getByRole('button', { name: 'Điều kiện kích hoạt cài đặt' });
  if (${q(aspect)}) { await settings.evaluate((b) => b.click()); await sleep(1000);
    const okA = await page.evaluate((a) => { const b = [...document.querySelectorAll('.cdk-overlay-container button')].find((x) => x.textContent.trim().endsWith(a)); if (b) b.click(); return !!b; }, ${q(aspect)});
    await sleep(500); await settings.evaluate((b) => b.click()); await sleep(500); if (!okA) return { stop: 'no-aspect-chip', aspect: ${q(aspect)} }; }
  const chip = (await settings.innerText()).replace(/\\s+/g, ' ');
  if (!(await ${lib(f1)}.count()) || !(await ${lib(f2)}.count())) {
    let ub = page.getByRole('button', { name: 'Tải nội dung nghe nhìn lên' });
    if (!(await ub.count())) { await page.getByRole('button', { name: 'Thêm thành phần vào ô nhập câu lệnh' }).evaluate((x) => x.click()); await sleep(1000); ub = page.locator('.cdk-overlay-container button', { hasText: 'Tải nội dung nghe nhìn lên' }); }
    try { const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 8000 }), ub.first().evaluate((x) => x.click())]); await fc.setFiles(${q(uploads[0])}); await sleep(600);
      const [fc2] = await Promise.all([page.waitForEvent('filechooser', { timeout: 8000 }), (async () => { await sleep(300); await page.getByRole('button', { name: 'Thêm thành phần vào ô nhập câu lệnh' }).evaluate((x) => x.click()); await sleep(900); await page.locator('.cdk-overlay-container button', { hasText: 'Tải nội dung nghe nhìn lên' }).first().evaluate((x) => x.click()); })()]); await fc2.setFiles(${q(uploads[1])}); }
    catch (e) { return { stop: 'upload-chooser', error: String(e).slice(0, 120), use: 'browser_file_upload with the uploads of flow-brief, then run prep again' }; }
    for (let i = 0; i < 30 && !((await ${lib(f1)}.count()) && (await ${lib(f2)}.count())); i++) await sleep(1500);
    if (!(await ${lib(f1)}.count()) || !(await ${lib(f2)}.count())) return { stop: 'upload-not-ready' };
  }
  const addRef = async (name) => { await page.keyboard.press('Escape'); await sleep(300); const g = page.locator('[role=group][aria-label=' + JSON.stringify(name) + ']:has(img[src^="http"])').first();
    await g.locator('button[aria-label="Tuỳ chọn khác"]').first().evaluate((b) => b.click()); await sleep(900);
    await page.evaluate(() => { const m = [...document.querySelectorAll('.cdk-overlay-container [role=menuitem]')].find((b) => b.textContent.includes('add_2')); if (m) m.click(); }); await sleep(1200); };
  await addRef(${q(f1)}); await addRef(${q(f2)});
  await page.keyboard.press('Escape'); await sleep(300);
  const srcs = await page.locator('img[alt="Hình ảnh thành phần"]').evaluateAll((a) => a.map((i) => (i.src || '').split('=')[0]));
  const base = async (name) => (await page.locator('[role=group][aria-label=' + JSON.stringify(name) + '] img').first().getAttribute('src') || '').split('=')[0];
  const order_ok = srcs.length === 2 && srcs[0] === await base(${q(f1)}) && srcs[1] === await base(${q(f2)});
  if (!order_ok) return { stop: 'chips', chips: srcs.length, order_ok };
  let box = page.locator('div[role=textbox]:not([aria-label="Văn bản có thể chỉnh sửa"])').first();
  if (!(await box.count())) box = page.getByRole('textbox', { name: 'Bạn muốn tạo những gì?' });
  await box.fill(${q(prompt)}); await sleep(600);
  const typed = (await box.innerText()).length;
  return { ok: typed > ${Math.floor(prompt.length * 0.9)}, chips: srcs.length, order_ok, typed, want: ${prompt.length}, settings: chip }; }`;
  const submit = `async (page) => { ${HEAD}
  const before = await page.locator('[role=group]').count();
  const snap = await ${STATE}, ${q(f2)});
  let box = page.locator('div[role=textbox]:not([aria-label="Văn bản có thể chỉnh sửa"])').first();
  if (!(await box.count())) box = page.getByRole('textbox', { name: 'Bạn muốn tạo những gì?' });
  await box.focus(); await page.keyboard.press('Enter');
  // what existed BEFORE this prompt can never be its result; the log lets collect of other items see this one is in flight
  await page.evaluate(({ f2, keys, words }) => { const at = Date.now(); sessionStorage.setItem('pr-flow:' + f2, JSON.stringify({ before: keys, at }));
    let log = []; try { log = JSON.parse(sessionStorage.getItem('pr-flow-log') || '[]'); } catch {}
    log = log.filter((e) => e.f2 !== f2 && at - e.at < 3 * 3600e3); log.push({ f2, words, at }); sessionStorage.setItem('pr-flow-log', JSON.stringify(log)); }, { f2: ${q(f2)}, keys: snap.tiles.filter((t) => t.key).map((t) => t.key), words: ${W} });
  await sleep(3500);
  const text = await page.evaluate(() => document.body.innerText);
  const warn = (text.match(${WARN}) || [])[0] || '';
  const chips = await page.locator('img[alt="Hình ảnh thành phần"]').count();
  return { submitted: chips === 0, chips_left: chips, tiles_before: before, tiles_after: await page.locator('[role=group]').count(), warning: warn }; }`;
  const collect = `async (page) => { ${HEAD}
  ${PICK}
  const st = await ${STATE}, ${q(f2)});
  if (st.own < 0) return { stop: 'not-ready', info: { err: 'no upload tile of this item' } };
  const p = pick(st, ${q(f2)}, ${W});
  if (p.wait) return { stop: 'not-ready', info: p };
  if (!p.tile) return { stop: 'ambiguous', info: p, note: 'Several finished tiles could be this item: do NOT download any of them now. Collect the other items first (or wait for renders), then run collect again.' };
  const info = { label: p.tile.label, why: p.why, index: p.tile.i };
  const okKey = await page.evaluate(({ i, key, f2 }) => { const g = [...document.querySelectorAll('[role=group]')][i]; const img = g && g.querySelector('img'); if (!img || img.src.split('=')[0] !== key) return false;
    let c = {}; try { c = JSON.parse(sessionStorage.getItem('pr-flow-claimed') || '{}'); } catch {} c[key] = f2; sessionStorage.setItem('pr-flow-claimed', JSON.stringify(c)); img.click(); return true; }, { i: p.tile.i, key: p.tile.key, f2: ${q(f2)} });
  if (!okKey) return { stop: 'not-ready', info: { err: 'the grid moved; run collect again' } };
  const clickedAt = Date.now();
  const expect = p.tile.label.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  await sleep(2200);
  const r = await page.evaluate(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const find = () => [...document.querySelectorAll('.cdk-overlay-container button, .cdk-overlay-container [role=menuitem]')].find((b) => /^\\s*1K/.test(b.textContent));
    let b = find(); if (!b) { const d = document.querySelector('button[aria-label="Tải nội dung nghe nhìn xuống"]'); if (!d) return 'no-download-button'; d.click(); for (let i = 0; i < 20 && !(b = find()); i++) await sleep(100); }
    if (!b) return 'no-1k-item'; b.click(); return 'clicked'; });
  return { info, clicked: r, next: 'node core/flow-pace.mjs download-collect --tag <item id> --since-ms ' + (clickedAt - 3000) + (expect ? ' --expect "' + expect + '" --tile "' + p.tile.label.replace(/"/g, '') + '"' : '') + ' (it waits for THIS download, moves it, releases the lock)' }; }`;
  return { ready, prep, submit, collect };
}

// CLI: node core/flow-snippets.mjs write <brief.json> <outDir> <id>  -> writes <id>-flow-{ready,prep,submit,collect}.js, prints the 4 paths as JSON.
export function writeFlowSnippets(brief, outDir, id) {
  const s = buildFlowSnippets({ ...brief, words: brief.words || itemWords(String(id).replace(/^\d+-/, ''), brief.product) });
  fs.mkdirSync(outDir, { recursive: true });
  const res = {};
  for (const [k, code] of Object.entries(s)) { const p = path.join(outDir, `${id}-flow-${k}.js`); fs.writeFileSync(p, code); res[k] = p; }
  return res;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))) {
  const [cmd, briefFile, outDir, id] = process.argv.slice(2);
  if (cmd !== 'write') { console.log(JSON.stringify({ ok: false, error: 'node core/flow-snippets.mjs write <brief.json> <outDir> <id>' })); process.exit(1); }
  try { console.log(JSON.stringify({ ok: true, ...writeFlowSnippets(JSON.parse(fs.readFileSync(briefFile, 'utf8').replace(/^﻿/, '')), outDir, id) })); }
  catch (e) { console.log(JSON.stringify({ ok: false, error: String(e.message || e) })); process.exit(1); }
}

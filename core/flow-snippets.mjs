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

export function buildFlowSnippets({ aspect = '', uploads = [], prompt = '' } = {}) {
  const files = uploads.map((p) => path.basename(String(p)));
  const [f1, f2] = files;
  if (!f1 || !f2 || !prompt) throw new Error('flow snippets need 2 uploads and the prompt');
  const lib = (name) => `page.locator('[role=group][aria-label=${q(name)}]:has(img[src^="http"])')`;
  const ready = `async (page) => { ${HEAD}
  const info = await page.evaluate((f2) => { const gs = [...document.querySelectorAll('[role=group]')]; const i = gs.findIndex((g) => g.getAttribute('aria-label') === f2); if (i < 1) return { err: 'no upload tile of this item' }; const t = gs[i - 1], img = t.querySelector('img'); return { label: t.getAttribute('aria-label') || '', done: !!(img && img.naturalWidth > 0) && !/%/.test(t.innerText), text: t.innerText.replace(/\\s+/g, ' ').slice(0, 60) }; }, ${q(f2)});
  return { item_ready: !!info.done && !/^pr-ref-/.test(info.label || ''), info }; }`;
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
  let box = page.locator('div[role=textbox]:not([aria-label="Văn bản có thể chỉnh sửa"])').first();
  if (!(await box.count())) box = page.getByRole('textbox', { name: 'Bạn muốn tạo những gì?' });
  await box.focus(); await page.keyboard.press('Enter'); await sleep(3500);
  const text = await page.evaluate(() => document.body.innerText);
  const warn = (text.match(${WARN}) || [])[0] || '';
  const chips = await page.locator('img[alt="Hình ảnh thành phần"]').count();
  return { submitted: chips === 0, chips_left: chips, tiles_before: before, tiles_after: await page.locator('[role=group]').count(), warning: warn }; }`;
  const collect = `async (page) => { ${HEAD}
  const info = await page.evaluate((f2) => { const gs = [...document.querySelectorAll('[role=group]')]; const i = gs.findIndex((g) => g.getAttribute('aria-label') === f2); if (i < 1) return { err: 'no upload tile of this item' }; const t = gs[i - 1], img = t.querySelector('img'); return { label: t.getAttribute('aria-label') || '', done: !!(img && img.naturalWidth > 0) && !/%/.test(t.innerText) }; }, ${q(f2)});
  if (info.err || !info.done || /^pr-ref-/.test(info.label)) return { stop: 'not-ready', info };
  await page.evaluate((f2) => { const gs = [...document.querySelectorAll('[role=group]')]; const i = gs.findIndex((g) => g.getAttribute('aria-label') === f2); gs[i - 1].querySelector('img').click(); }, ${q(f2)});
  await sleep(2200);
  const r = await page.evaluate(async () => { const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const find = () => [...document.querySelectorAll('.cdk-overlay-container button, .cdk-overlay-container [role=menuitem]')].find((b) => /^\\s*1K/.test(b.textContent));
    let b = find(); if (!b) { const d = document.querySelector('button[aria-label="Tải nội dung nghe nhìn xuống"]'); if (!d) return 'no-download-button'; d.click(); for (let i = 0; i < 20 && !(b = find()); i++) await sleep(100); }
    if (!b) return 'no-1k-item'; b.click(); return 'clicked'; });
  return { info, clicked: r, next: 'node core/flow-pace.mjs download-collect --tag <item id> (it waits for the file, moves it, releases the lock)' }; }`;
  return { ready, prep, submit, collect };
}

// CLI: node core/flow-snippets.mjs write <brief.json> <outDir> <id>  -> writes <id>-flow-{ready,prep,submit,collect}.js, prints the 4 paths as JSON.
export function writeFlowSnippets(brief, outDir, id) {
  const s = buildFlowSnippets(brief);
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

// Speed helpers of the Flow path (fixtures only, no Flow, no Chrome): the per-item Playwright snippets, download-collect (move + validate + release the lock), and the unchanged pace gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildFlowSnippets, writeFlowSnippets } from "../flow-snippets.mjs";
import { requiredWaitMs } from "../flow-pace.mjs";

const pace = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "flow-pace.mjs");
const png = (w, h) => { const b = Buffer.alloc(3000); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };

test("snippets compile, carry the item's files and prompt, and never submit without the separate gate", () => {
  const s = buildFlowSnippets({ aspect: "3:4", uploads: ["C:/d/pr-ref-r-001-a-1.jpg", "C:/d/pr-ref-r-001-a-2.png"], prompt: 'a "quoted" prompt\nline 2' });
  assert.deepEqual(Object.keys(s), ["ready", "prep", "submit", "collect"]);
  for (const [k, code] of Object.entries(s)) {
    assert.equal(typeof new Function("return (" + code + ")")(), "function", k);
    assert.match(code, /bringToFront/); assert.doesNotMatch(code, /waitForFunction|mouse\.click|flow-pace.mjs gate/);
  }
  assert.match(s.prep, /pr-ref-r-001-a-1\.jpg/); assert.match(s.prep, /pr-ref-r-001-a-2\.png/); assert.match(s.prep, /a \\"quoted\\" prompt\\nline 2/); assert.match(s.prep, /3:4/);
  assert.doesNotMatch(s.prep, /keyboard\.press\('Enter'\)/, "prep never submits");
  assert.match(s.submit, /keyboard\.press\('Enter'\)/);
  assert.throws(() => buildFlowSnippets({ uploads: ["a.jpg"], prompt: "x" }));
});
test("writeFlowSnippets writes the four files of one item", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "snip-")); const r = writeFlowSnippets({ aspect: "1:1", uploads: ["x/1.jpg", "x/2.png"], prompt: "p" }, d, "007-x");
  assert.deepEqual(Object.keys(r), ["ready", "prep", "submit", "collect"]); for (const p of Object.values(r)) assert.ok(fs.existsSync(p));
  assert.ok(fs.existsSync(path.join(d, "007-x-flow-collect.js"))); fs.rmSync(d, { recursive: true, force: true });
});
test("download-collect moves the new image (not the reference uploads), validates it and releases the lock", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dl-")), dl = path.join(base, "Downloads"), dest = path.join(base, "out"), lock = path.join(base, "dl.lock");
  fs.mkdirSync(dl); fs.writeFileSync(path.join(dl, "pr-ref-r-005-x-1.png"), png(10, 10)); fs.writeFileSync(path.join(dl, "pr-ref-r-005-x-2.png"), png(11, 11)); fs.writeFileSync(path.join(dl, "old.png"), png(5, 5));
  fs.utimesSync(path.join(dl, "old.png"), new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  fs.writeFileSync(path.join(dl, "Edit_image_ab12.png"), png(768, 1024)); fs.writeFileSync(lock, JSON.stringify({ tag: "005-x" }));
  const env = { ...process.env, PR_FLOW_DOWNLOAD_LOCK: lock, PR_DOWNLOADS_DIR: dl };
  const r = JSON.parse(execFileSync("node", [pace, "download-collect", "--tag", "005-x", "--dest", dest, "--wait-s", "5"], { env, encoding: "utf8" }).trim());
  assert.equal(r.ok, true); assert.equal(r.width, 768); assert.equal(r.height, 1024); assert.equal(path.basename(r.path), "005-x.png");
  assert.ok(fs.existsSync(r.path)); assert.ok(!fs.existsSync(path.join(dl, "Edit_image_ab12.png"))); assert.ok(fs.existsSync(path.join(dl, "pr-ref-r-005-x-1.png"))); assert.ok(!fs.existsSync(lock), "lock released");
  fs.rmSync(base, { recursive: true, force: true });
});
test("download-collect without a new file reports NO_DOWNLOAD and still releases the lock", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "dl-")), dl = path.join(base, "Downloads"), lock = path.join(base, "dl.lock");
  fs.mkdirSync(dl); fs.writeFileSync(lock, JSON.stringify({ tag: "009-x" }));
  const env = { ...process.env, PR_FLOW_DOWNLOAD_LOCK: lock, PR_DOWNLOADS_DIR: dl };
  const r = JSON.parse(execFileSync("node", [pace, "download-collect", "--tag", "009-x", "--dest", path.join(base, "o"), "--wait-s", "3"], { env, encoding: "utf8" }).trim());
  assert.equal(r.ok, false); assert.equal(r.cause, "NO_DOWNLOAD"); assert.ok(!fs.existsSync(lock)); fs.rmSync(base, { recursive: true, force: true });
});
test("the pace gate is unchanged: 5-12 s inside a group, 20-45 s after a group, max 8 per 2 minutes", () => {
  const now = Date.now();
  for (let i = 0; i < 30; i++) {
    const inGroup = requiredWaitMs({ times: [now], in_group: 1, group_size: 3 }, now), after = requiredWaitMs({ times: [now], in_group: 3, group_size: 3 }, now);
    assert.ok(inGroup >= 5000 && inGroup <= 12000, "in group " + inGroup); assert.ok(after >= 20000 && after <= 45000, "after group " + after);
  }
  const burst = Array.from({ length: 8 }, (_, i) => now - 110000 + i * 1000);
  assert.ok(requiredWaitMs({ times: burst, in_group: 1, group_size: 3 }, now) >= 10000);
});

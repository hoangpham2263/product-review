// src/image/unsparkle.mjs: Google's sparkle is undone (not painted over), a picture without it is left alone, and the
// command line writes a copy.   node --test tests/unsparkle.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { encodePng, decodePng } from "../src/image/png.mjs";
import { removeSparkle, sparkleCover, pillCover } from "../src/image/unsparkle.mjs";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../src/image/unsparkle.mjs");
// A picture with detail (diagonal stripes and a gradient) so that "the detail comes back" means something.
function scene(width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, stripe = ((x + y) % 40 < 3) ? -50 : 0;
    data[i] = 120 + (x / width) * 60 + stripe; data[i + 1] = 90 + (y / height) * 50 + stripe; data[i + 2] = 70 + stripe; data[i + 3] = 255;
  }
  return { width, height, data };
}
// The same picture under the veil of strength alpha.
function veiled(image, alpha) {
  const { cover } = sparkleCover(image.width, image.height), copy = { ...image, data: Uint8Array.from(image.data) };
  for (let p = 0; p < cover.length; p++) if (cover[p] > 0) for (let c = 0; c < 3; c++) { const a = alpha * cover[p], i = p * 4 + c; copy.data[i] = Math.round(copy.data[i] * (1 - a) + 255 * a); }
  return copy;
}
// Largest difference over the pixels the star covers fully, 3 px or more inside its edge (the rim is blended with its surroundings, so it differs a little more).
const inner = (a, b) => { const { cover } = sparkleCover(a.width, a.height); let m = 0; for (let p = 0; p < cover.length; p++) if (cover[p] > 0.99 && [-3, 3].every((d) => cover[p + d] > 0.99 && cover[p + d * a.width] > 0.99)) for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(a.data[p * 4 + c] - b.data[p * 4 + c])); return m; };
const maxDiff = (a, b, box) => { let m = 0; for (let y = box[1]; y <= box[3]; y++) for (let x = box[0]; x <= box[2]; x++) for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(a.data[(y * a.width + x) * 4 + c] - b.data[(y * a.width + x) * 4 + c])); return m; };

test("the sparkle is undone and the detail under it comes back, for several strengths and sizes", () => {
  for (const [size, alpha] of [[1024, 0.3], [1024, 0.48], [1024, 0.2]]) {
    const clean = scene(size, size), marked = veiled(clean, alpha), { box } = sparkleCover(size, size);
    assert.ok(maxDiff(clean, marked, box) > 40, "the veil must be visible before");
    const result = removeSparkle(marked);
    assert.equal(result.applied, true, `size ${size} alpha ${alpha}`);
    assert.ok(Math.abs(result.alpha - alpha) < 0.08, `strength measured ${result.alpha} for ${alpha}`);
    // Inside the star the stripes are back; only the soft edge may differ a little.
    assert.ok(inner(clean, marked) <= 40, `inside the star differs by ${inner(clean, marked)} (size ${size}, alpha ${alpha}, measured ${result.alpha})`);
  }
});

test("pixels away from the corner never change", () => {
  const clean = scene(1024, 1024), marked = veiled(clean, 0.3), copy = Uint8Array.from(marked.data);
  removeSparkle(marked);
  for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) if (x < 850 || y < 850) for (let c = 0; c < 4; c++) assert.equal(marked.data[(y * 1024 + x) * 4 + c], copy[(y * 1024 + x) * 4 + c]);
});

test("a picture without the sparkle, a flat one and a tiny one are left as they are", () => {
  for (const image of [scene(1024, 1024), { width: 1024, height: 1024, data: Uint8Array.from({ length: 1024 * 1024 * 4 }, () => 200) }, scene(100, 100)]) {
    const before = Uint8Array.from(image.data);
    assert.equal(removeSparkle(image).applied, false);
    assert.deepEqual(image.data, before);
  }
});

test("a rectangular picture has the star at its own corner", () => {
  const clean = scene(1280, 720), marked = veiled(clean, 0.3);
  assert.equal(removeSparkle(marked).applied, true);
  const { box } = sparkleCover(1280, 720);
  assert.ok(inner(clean, marked) <= 32 && maxDiff(clean, marked, box) <= 36, `rectangular picture differs by ${inner(clean, marked)} inside, ${maxDiff(clean, marked, box)} overall`);
});

test("the command line writes a cleaned copy, keeps a clean picture byte for byte, and says why it fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "unsparkle-"));
  try {
    const clean = scene(1024, 1024), a = join(dir, "marked.png"), b = join(dir, "clean.png"), out = join(dir, "out.png");
    writeFileSync(a, encodePng(veiled(clean, 0.3))); writeFileSync(b, encodePng(clean));
    const run = (image) => spawnSync(process.execPath, [script, "--image", image, "--out", out], { encoding: "utf8" });
    let r = run(a);
    assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).applied, true);
    assert.notDeepEqual(readFileSync(out), readFileSync(a));
    r = run(b);
    assert.equal(JSON.parse(r.stdout).applied, false);
    assert.deepEqual(readFileSync(out), readFileSync(b));
    writeFileSync(join(dir, "x.png"), "not a picture");
    r = run(join(dir, "x.png"));
    assert.notEqual(r.status, 0); assert.match(r.stderr, /PNG/);
    assert.equal(decodePng(readFileSync(a)).width, 1024, "the input is never written");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- newer Flow files: the star sits at 1/6 of the shorter side from the edges, and some carry the "AI" pill instead ----
function noisy(width, height, base = 110) {   // gradient + deterministic grain + an edge far from the corner, so detail and texture exist
  const data = new Uint8Array(width * height * 4); let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, g = base + (x / width) * 40 + (y / height) * 30 + (x + y < (width + height) * 0.3 ? 25 : 0) + (rnd() - 0.5) * 8;
    data[i] = g; data[i + 1] = g * 0.9; data[i + 2] = g * 0.8; data[i + 3] = 255;
  }
  return { width, height, data };
}
function starAt(image, alpha) {
  const S = Math.min(image.width, image.height), c = Math.round(S / 6), r = 0.034 * S, copy = { ...image, data: Uint8Array.from(image.data) };
  const { cover } = sparkleCover(image.width, image.height, image.width - c, image.height - c, r);
  for (let p = 0; p < cover.length; p++) if (cover[p] > 0) for (let k = 0; k < 3; k++) { const a = alpha * cover[p], i = p * 4 + k; copy.data[i] = Math.round(copy.data[i] * (1 - a) + 255 * a); }
  return { marked: copy, c, r };
}
function pillOn(image) {
  const S = Math.min(image.width, image.height), w = 0.0536 * S, h = 0.039 * S, cx = image.width - 0.0625 * S, cy = image.height - 0.0558 * S;
  const { cover } = pillCover(image.width, image.height, cx, cy, w, h), copy = { ...image, data: Uint8Array.from(image.data) };
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const p = y * image.width + x; if (cover[p] <= 0) continue;
    const letter = Math.abs(y + 0.5 - cy) < h * 0.28 && (Math.abs(x + 0.5 - cx + w * 0.12) < 2 || Math.abs(x + 0.5 - cx - w * 0.12) < 2);
    for (let k = 0; k < 3; k++) { const i = p * 4 + k, v = letter ? 60 : copy.data[i] * 0.55 + 200 * 0.45; copy.data[i] = Math.round(copy.data[i] * (1 - cover[p]) + v * cover[p]); }
  }
  return { marked: copy, cx, cy, w, h };
}
const worst = (a, b, cx, cy, rad) => { let m = 0; for (let y = Math.round(cy - rad); y <= cy + rad; y++) for (let x = Math.round(cx - rad); x <= cx + rad; x++) for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(a.data[(y * a.width + x) * 4 + k] - b.data[(y * a.width + x) * 4 + k])); return m; };

test("the newer star (centre at 1/6 of the shorter side) is removed at every size, on light and dark pictures", () => {
  for (const [w, h, base] of [[512, 512, 110], [382, 512, 40], [896, 1200, 150], [1200, 896, 15], [1376, 768, 90], [1024, 1024, 125]]) {
    const clean = noisy(w, h, base), { marked, c, r } = starAt(clean, 0.3);
    assert.ok(worst(clean, marked, w - c, h - c, r * 0.8) > 12, "the veil must be visible before");
    const result = removeSparkle(marked);
    assert.equal(result.applied, true, `${w}x${h}`); assert.equal(result.kind, "star");
    assert.ok(Math.abs(w - result.right - c) <= 3 || Math.abs(result.right - c) <= 3, `found at ${result.right}, expected ${c}`);
    assert.ok(worst(clean, marked, w - c, h - c, r * 0.7) <= 14, `${w}x${h}: ${worst(clean, marked, w - c, h - c, r * 0.7)} left inside the star`);
  }
});

test("the 'AI' pill is painted out, and the picture away from it is untouched", () => {
  for (const [w, h] of [[896, 1200], [1200, 896]]) {
    const clean = noisy(w, h, 90), { marked, cx, cy, w: pw, h: ph } = pillOn(clean), copy = Uint8Array.from(marked.data);
    assert.ok(worst(clean, marked, cx, cy, ph * 0.4) > 40);
    const result = removeSparkle(marked);
    assert.equal(result.applied, true); assert.equal(result.kind, "pill");
    assert.ok(worst(clean, marked, cx, cy, ph * 0.45) <= 28, `pill left ${worst(clean, marked, cx, cy, ph * 0.45)}`);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.abs(x - cx) > pw / 2 + 6 || Math.abs(y - cy) > ph / 2 + 6) for (let k = 0; k < 4; k++) assert.equal(marked.data[(y * w + x) * 4 + k], copy[(y * w + x) * 4 + k]);
  }
});

test("a clean newer-size picture is left alone, and a faint star on a pale grainy corner is still taken when Flow made the picture", () => {
  for (const [w, h] of [[512, 512], [896, 1200], [1024, 1024]]) {
    const image = noisy(w, h, 100), before = Uint8Array.from(image.data);
    assert.equal(removeSparkle(image).applied, false); assert.deepEqual(image.data, before);
  }
  for (const base of [60, 100, 170, 215]) { const clean = noisy(1024, 1024, base), before = Uint8Array.from(clean.data); assert.equal(removeSparkle(clean, { assumePresent: true }).applied, false, `no star, base ${base}`); assert.deepEqual(clean.data, before); }
  // A pale, grainy corner: the star steps by too little to be proven alone, but its outline still steps by 0.30 all round.
  const { marked } = starAt(noisy(1024, 1024, 170), 0.3);
  assert.equal(removeSparkle({ ...marked, data: Uint8Array.from(marked.data) }).applied, false, "no proof of a star without the Flow hint");
  assert.equal(removeSparkle(marked, { assumePresent: true }).applied, true);
});

test("the command line takes --flow and reports the kind", () => {
  const dir = mkdtempSync(join(tmpdir(), "unsparkle-"));
  try {
    const a = join(dir, "m.png"), out = join(dir, "o.png");
    writeFileSync(a, encodePng(starAt(noisy(512, 512, 100), 0.3).marked));
    const r = spawnSync(process.execPath, [script, "--image", a, "--out", out, "--flow"], { encoding: "utf8" });
    assert.equal(r.status, 0); const j = JSON.parse(r.stdout);
    assert.equal(j.applied, true); assert.equal(j.kind, "star");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

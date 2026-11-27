// Removes the marks Google puts in the bottom right corner of the pictures its web AI makes (Flow, Gemini), in plain Node:
//  - the sparkle: one white veil of fixed shape (a four-point star with curved sides). It is undone, not painted over:
//    shown = bg * (1 - a) + 255 * a, hence bg = (shown - 255 a) / (1 - a), so the detail under the star comes back.
//  - the "AI" pill: a translucent grey rounded label with dark letters. The letters hide the picture, so the pill is
//    inpainted (smooth fill from the ring around it plus matching grain).
// WHERE the star is depends on the download: the older Flow files had it at a fixed ~101 px from the right and bottom edges,
// the newer ones (measured on 40 pictures of 382 x 512 up to 1376 x 768) put its centre at 1/6 of the SHORTER side from both edges
// with a radius of about 3.4 % of that side, so every size has its own pixel position. The star (and the pill, at about 6 % of the
// shorter side from the edges) is therefore searched per picture: every candidate place is scored by the step along its outline
// (inside minus outside) and the best one wins. A picture without a mark is left as it is (applied:false), unless the caller
// knows the picture comes from Flow ({assumePresent:true}); then a weak match is still taken when the lift inside the star is plausible.
//   node unsparkle.mjs --image <png> --out <png> [--flow]     prints {"applied":true|false,"kind":"star"|"pill","alpha":0.31,...}
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./png.mjs";

const MIN_SIDE = 300, LEGACY_CENTER = 101, LEGACY_RADIUS = 25.8, CURVE = 0.66, CORE = 0.98, EDGE_DIST = 2.5;
const STAR_SCORE = 12, PILL_SCORE = 14;           // 15th percentile of the outline step
const ALPHA_LOW = 0.2, ALPHA_HIGH = 0.4, ALPHA_DEFAULT = 0.3, BAND_LOW = 0.22, BAND_HIGH = 0.38, AGREE = 0.06, STRONG_MIX = 0.5;
const STAR_FRACTION = 1 / 6, STAR_RADIUS_FRACTIONS = [0.030, 0.032, 0.034, 0.036, 0.038, 0.040];
const PILL = { w: 0.0536, h: 0.039, right: 0.0625, bottom: 0.0558 };   // fractions of the shorter side (centre from the edges)

// How much of each pixel the star covers (0 to 1, soft at the edge); (cx, cy) is its centre, r its radius. Without a centre: the
// older 1K place (101 px from the right and bottom).
export function sparkleCover(width, height, cx = width - LEGACY_CENTER, cy = height - LEGACY_CENTER, r = LEGACY_RADIUS) {
  const x0 = Math.max(0, Math.floor(cx - r - 4)), x1 = Math.min(width - 1, Math.ceil(cx + r + 4));
  const y0 = Math.max(0, Math.floor(cy - r - 4)), y1 = Math.min(height - 1, Math.ceil(cy + r + 4));
  const cover = new Float32Array(width * height);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const f = Math.pow(Math.abs(x + 0.5 - cx) / r, CURVE) + Math.pow(Math.abs(y + 0.5 - cy) / r, CURVE); // below 1 inside
    cover[y * width + x] = Math.max(0, Math.min(1, ((1 - f) * r * 0.45) / 1.2 + 0.5));
  }
  return { cover, box: [x0, y0, x1, y1] };
}

// How much of each pixel the "AI" pill covers (a stadium: rectangle with fully rounded ends), centre (cx, cy), size w x h.
export function pillCover(width, height, cx, cy, w, h) {
  const x0 = Math.max(0, Math.floor(cx - w / 2 - 3)), x1 = Math.min(width - 1, Math.ceil(cx + w / 2 + 3));
  const y0 = Math.max(0, Math.floor(cy - h / 2 - 3)), y1 = Math.min(height - 1, Math.ceil(cy + h / 2 + 3));
  const cover = new Float32Array(width * height), r = h / 2, half = w / 2 - r;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const px = Math.abs(x + 0.5 - cx), dx = Math.max(0, px - half), d = Math.hypot(dx, y + 0.5 - cy) - r; // negative inside
    cover[y * width + x] = Math.max(0, Math.min(1, 0.5 - d));
  }
  return { cover, box: [x0, y0, x1, y1] };
}

// The shape's outline as sample points (offset from the centre and the unit normal pointing inwards), from its own cover map.
function outlineOf(make, size) {
  const mid = size >> 1, { cover } = make(size, mid), pts = [];
  for (let y = 2; y < size - 2; y++) for (let x = 2; x < size - 2; x++) {
    const c = cover[y * size + x];
    if (c < 0.3 || c > 0.7) continue;
    const gx = cover[y * size + x + 1] - cover[y * size + x - 1], gy = cover[(y + 1) * size + x] - cover[(y - 1) * size + x], g = Math.hypot(gx, gy);
    if (g >= 0.05) pts.push([x - mid, y - mid, gx / g, gy / g]);
  }
  return pts;
}
const starOutline = (r) => outlineOf((size, mid) => sparkleCover(size, size, mid, mid, r), Math.ceil(r * 2 + 24));
const pillOutline = (w, h) => outlineOf((size, mid) => pillCover(size, size, mid, mid, w, h), Math.ceil(w + 24));

const luminance = (image, x0, y0) => {
  const { width: W, height: H, data } = image, lum = new Float32Array(W * H);
  for (let y = y0; y < H; y++) for (let x = x0; x < W; x++) { const i = (y * W + x) * 4; lum[y * W + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; }
  return lum;
};

// Fit of a shape at (cx, cy): the 15th percentile, over its outline, of (luminance just inside - luminance just outside) times sign.
// A veil makes a step of one sign along the whole edge; a natural edge of the picture does not, so a low percentile (not the median)
// keeps a bright object touching the outline from passing for a mark. sign +1 for the star (it lifts), +-1 for the pill (grey).
function fit(lum, W, pts, cx, cy, sign) {
  const cs = new Float32Array(pts.length);
  for (let k = 0; k < pts.length; k++) {
    const [x, y, nx, ny] = pts[k];
    cs[k] = sign * (lum[Math.round(cy + y + EDGE_DIST * ny) * W + Math.round(cx + x + EDGE_DIST * nx)] - lum[Math.round(cy + y - EDGE_DIST * ny) * W + Math.round(cx + x - EDGE_DIST * nx)]);
  }
  cs.sort();
  return cs[Math.floor(cs.length * 0.15)];
}

// Best star: scaled family (centre S/6 from the edges, +-1.5 % of S, radius 3.0..4.0 % of S) and the older fixed 101 px family.
function findStar(image, lum) {
  const { width: W, height: H } = image, S = Math.min(W, H);
  let best = { score: -1e9 }, scaled = { score: -1e9 };
  const mid0 = Math.round(S * STAR_FRACTION);
  const consider = (pts, r, cx, cy, family) => { const score = fit(lum, W, pts, cx, cy, 1); if (score > best.score) best = { score, r, cx, cy, family }; if (family === "scaled" && Math.abs(W - cx - mid0) <= 4 && Math.abs(H - cy - mid0) <= 4 && score > scaled.score) scaled = { score, r, cx, cy, family }; };
  const span = Math.max(3, Math.round(S * 0.015)), mid = Math.round(S * STAR_FRACTION);
  for (const k of STAR_RADIUS_FRACTIONS) {
    const r = k * S, pts = starOutline(r);
    for (let b = mid - span; b <= mid + span; b++) for (let rt = mid - span; rt <= mid + span; rt++) consider(pts, r, W - rt, H - b, "scaled");
  }
  if (S >= 600) {
    const pts = starOutline(LEGACY_RADIUS);
    for (let b = 90; b <= 130; b++) for (let rt = 90; rt <= 130; rt++) if (Math.abs(b - mid) > span + 2 || Math.abs(rt - mid) > span + 2) consider(pts, LEGACY_RADIUS, W - rt, H - b, "legacy");
  }
  return { ...best, scaled };
}

// Best "AI" pill: centre near (PILL.right, PILL.bottom) of S from the edges (+-2 % of S), size 0.85..1.2 times the usual.
function findPill(image, lum) {
  const { width: W, height: H } = image, S = Math.min(W, H);
  let best = { score: -1e9 };
  const span = Math.max(3, Math.round(S * 0.02));
  for (const k of [0.85, 1, 1.2]) {
    const w = PILL.w * S * k, h = PILL.h * S * k, pts = pillOutline(w, h);
    const rt0 = Math.round(PILL.right * S), b0 = Math.round(PILL.bottom * S);
    for (let b = b0 - span; b <= b0 + span; b++) for (let rt = rt0 - span; rt <= rt0 + span; rt++) for (const sign of [1, -1]) {
      const score = fit(lum, W, pts, W - rt, H - b, sign);
      if (score > best.score) best = { score, w, h, cx: W - rt, cy: H - b, sign };
    }
  }
  return best;
}

// Fine position of a star: within +-2 px, the centre where its inside is brightest on average against the ring around it.
function refineStar(lum, W, r, guess) {
  const size = Math.ceil(r * 2 + 24), mid = size >> 1, { cover } = sparkleCover(size, size, mid, mid, r), inner = [], outer = [];
  for (let y = 4; y < size - 4; y++) for (let x = 4; x < size - 4; x++) {
    const c = cover[y * size + x];
    if (c >= CORE) inner.push([x - mid, y - mid]);
    else if (c < 0.02) {
      let near = false;
      for (let dy = -4; dy <= 4 && !near; dy++) for (let dx = -4; dx <= 4; dx++) if (cover[(y + dy) * size + x + dx] >= 0.5) { near = true; break; }
      if (near) outer.push([x - mid, y - mid]);
    }
  }
  let best = { cx: guess.cx, cy: guess.cy, mean: -1e9 };
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const cx = guess.cx + dx, cy = guess.cy + dy;
    let a = 0, b = 0;
    for (const [x, y] of inner) a += lum[(cy + y) * W + cx + x];
    for (const [x, y] of outer) b += lum[(cy + y) * W + cx + x];
    const mean = a / inner.length - b / outer.length;
    if (mean > best.mean) best = { cx, cy, mean };
  }
  return best;
}

// Strength from the star's outline: a = (inside - outside) / (255 - outside), only where the outside is not nearly white; the median.
function edgeAlpha(lum, W, pts, cx, cy, flatOnly = false) {
  const as = [], L = (x, y) => lum[Math.round(y) * W + Math.round(x)];
  for (const [x, y, nx, ny] of pts) {
    if (flatOnly && (Math.abs(L(cx + x - EDGE_DIST * nx, cy + y - EDGE_DIST * ny) - L(cx + x - 7 * nx, cy + y - 7 * ny)) > 10 || Math.abs(L(cx + x + EDGE_DIST * nx, cy + y + EDGE_DIST * ny) - L(cx + x + 7 * nx, cy + y + 7 * ny)) > 10)) continue;
    const lin = L(cx + x + EDGE_DIST * nx, cy + y + EDGE_DIST * ny), lout = L(cx + x - EDGE_DIST * nx, cy + y - EDGE_DIST * ny);
    if (255 - lout >= 40) as.push((lin - lout) / (255 - lout));
  }
  if (as.length < (flatOnly ? 12 : 20)) return null;
  as.sort((a, b) => a - b);
  return as[as.length >> 1];
}

// A smooth guess of the background under a shape: the ring's mean, diffused inwards.
function smoothBackground(image, cover, inside, [x0, y0, x1, y1]) {
  const { width: W, data } = image, at = (x, y) => (y * W + x) * 4;
  const bg = new Float32Array(W * image.height * 3), ring = [0, 0, 0]; let n = 0;
  for (let y = y0 - 1; y <= y1 + 1; y++) for (let x = x0 - 1; x <= x1 + 1; x++) {
    for (let c = 0; c < 3; c++) bg[(y * W + x) * 3 + c] = data[at(x, y) + c];
    if (cover[y * W + x] <= 0.02) { for (let c = 0; c < 3; c++) ring[c] += data[at(x, y) + c]; n++; }
  }
  for (const [x, y] of inside) for (let c = 0; c < 3; c++) bg[(y * W + x) * 3 + c] = ring[c] / n;
  for (let pass = 0; pass < 500; pass++) for (const [x, y] of inside) for (let c = 0; c < 3; c++) {
    const i = (y * W + x) * 3 + c;
    bg[i] = (bg[i - W * 3] + bg[i + W * 3] + bg[i - 3] + bg[i + 3]) / 4;
  }
  return bg;
}

// Strength from the inside: the median lift of the fully covered pixels over the smooth background; also how many were lifted.
function interiorAlpha(image, cover, inside, bg) {
  const { width: W, data } = image, at = (x, y) => (y * W + x) * 4;
  const lifts = []; let lifted = 0, tested = 0;
  for (const [x, y] of inside) {
    if (cover[y * W + x] < CORE) continue;
    for (let c = 0; c < 3; c++) {
      const b = bg[(y * W + x) * 3 + c], v = data[at(x, y) + c];
      if (255 - b < 30) continue;
      lifts.push((v - b) / (255 - b)); tested++; if (v > b) lifted++;
    }
  }
  if (tested < 100) return { alpha: null, share: 0 };
  lifts.sort((p, q) => p - q);
  return { alpha: lifts[lifts.length >> 1], share: lifted / tested };
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const insideOf = (cover, [x0, y0, x1, y1], W) => { const inside = []; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (cover[y * W + x] > 0.02) inside.push([x, y]); return inside; };

function unveilStar(image, lum, star, assumePresent) {
  const { width: W, height: H, data } = image, at = (x, y) => (y * W + x) * 4;
  const clearFit = star.score >= STAR_SCORE;
  // A star that does not show (white or busy corner) is still taken at the usual place when the picture is known to come from Flow.
  const found = clearFit || !assumePresent ? star : star.scaled;
  const pos = refineStar(lum, W, found.r, found), pts = starOutline(found.r);
  const { cover, box } = sparkleCover(W, H, pos.cx, pos.cy, found.r), inside = insideOf(cover, box, W);
  const bgGuess = smoothBackground(image, cover, inside, box), ia = interiorAlpha(image, cover, inside, bgGuess), ea = edgeAlpha(lum, W, pts, pos.cx, pos.cy);
  const plausible = (v, lo, hi) => v !== null && v >= lo && v <= hi;
  const clear = clearFit && ia.share >= 0.9;
  let alpha, method = "detected";
  if (clear) {
    if (!plausible(ia.alpha, 0.1, 0.8) && !plausible(ea, 0.1, 0.8)) return null;
    alpha = plausible(ia.alpha, 0.1, 0.8) ? ia.alpha : ea;
    // Every clean Flow measurement is 0.27..0.33. An estimate outside the band is checked with the outline points that are NOT near a
    // strong edge of the picture; when that agrees with the interior one the veil really is that strong (dark scene) and is kept.
    if (alpha < BAND_LOW || alpha > BAND_HIGH) {
      const ra = edgeAlpha(lum, W, pts, pos.cx, pos.cy, true);
      if (plausible(ra, 0.1, 0.7) && plausible(ia.alpha, 0.1, 0.7) && Math.abs(ra - ia.alpha) <= AGREE) alpha = (ra + ia.alpha) / 2;
      else alpha = plausible(ra, BAND_LOW, BAND_HIGH) ? ra : ALPHA_DEFAULT;
    }
  } else if (assumePresent) {
    // The picture is known to come from Flow and the star only shows weakly (bright or busy corner): take it when the lift is plausible.
    method = "weak";
    alpha = ia.share >= 0.75 && plausible(ia.alpha, ALPHA_LOW, ALPHA_HIGH) ? ia.alpha : plausible(ea, ALPHA_LOW, ALPHA_HIGH) ? ea : ALPHA_DEFAULT;
  } else return null;
  // The newer Flow files carry the veil at one fixed strength (0.30, measured on every one of 40 pictures, 0.28..0.33 along the outline),
  // so the strength is not guessed from the picture there (that guess is what leaves a ghost).
  if (found.family === "scaled") alpha = plausible(ea, 0.26, 0.34) ? ea : 0.30;
  for (const [x, y] of inside) {
    const a = alpha * cover[y * W + x], i = at(x, y);
    for (let c = 0; c < 3; c++) data[i + c] = clamp((data[i + c] - 255 * a) / (1 - a));
  }
  // A strong veil squeezes what lies under it hard: the colour there comes from the smooth background, the detail from the unveil.
  if (alpha > BAND_HIGH) {
    const lumOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
    for (const [x, y] of inside) {
      const i = at(x, y), j = (y * W + x) * 3, w = cover[y * W + x], yr = lumOf(data[i], data[i + 1], data[i + 2]), yb = lumOf(bgGuess[j], bgGuess[j + 1], bgGuess[j + 2]);
      for (let c = 0; c < 3; c++) data[i + c] = clamp(data[i + c] * (1 - w) + (yr * (1 - STRONG_MIX) + yb * STRONG_MIX + (bgGuess[j + c] - yb)) * w);
    }
  }
  // The rim of the star (the pixels within 2 px of its edge, where the measured shape is least certain) takes the mean of the clean pixels
  // around it, so no faint outline is left.
  const rimBox = [Math.max(1, box[0] - 3), Math.max(1, box[1] - 3), Math.min(W - 2, box[2] + 3), Math.min(H - 2, box[3] + 3)];
  const near = (x, y) => { let hi = 0, lo = 1; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const v = cover[(y + dy) * W + x + dx]; if (v > hi) hi = v; if (v < lo) lo = v; } return hi >= 0.5 && lo < 0.99 ? 1 : (hi > 0 && hi < 0.5 && lo < 0.02 ? 1 : 0); };
  const rim = new Uint8Array(W * H), rimPts = [];
  for (let y = rimBox[1] + 2; y <= rimBox[3] - 2; y++) for (let x = rimBox[0] + 2; x <= rimBox[2] - 2; x++) if (near(x, y)) { rim[y * W + x] = 1; rimPts.push([x, y]); }
  const before = Uint8Array.from(data);
  for (const [x, y] of rimPts) {
    const t = [0, 0, 0]; let m = 0;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H || rim[yy * W + xx]) continue;
      const j = at(xx, yy); t[0] += before[j]; t[1] += before[j + 1]; t[2] += before[j + 2]; m++;
    }
    if (!m) continue;
    const i = at(x, y);
    for (let c = 0; c < 3; c++) data[i + c] = clamp(before[i + c] * 0.1 + (t[c] / m) * 0.9);
  }
  return { applied: true, kind: "star", alpha, method, score: found.score, family: found.family, right: W - pos.cx, bottom: H - pos.cy };
}

// The pill hides the picture under its letters, so it is inpainted: smooth fill diffused in from the ring, plus grain like the ring's.
function inpaintPill(image, found) {
  const { width: W, height: H, data } = image, at = (x, y) => (y * W + x) * 4;
  const grow = pillCover(W, H, found.cx, found.cy, found.w + 5, found.h + 5);
  const inside = insideOf(grow.cover, grow.box, W), box = grow.box.map((v, k) => k < 2 ? Math.max(1, v - 1) : Math.min(k === 2 ? W - 2 : H - 2, v + 1));
  const bg = smoothBackground(image, grow.cover, inside, box);
  // grain: spread of the ring's pixel-to-pixel differences
  const diffs = [];
  for (let y = box[1]; y <= box[3]; y++) for (let x = box[0]; x < box[2]; x++) if (grow.cover[y * W + x] <= 0.02 && grow.cover[y * W + x + 1] <= 0.02) diffs.push(Math.abs(data[at(x, y) + 1] - data[at(x + 1, y) + 1]));
  diffs.sort((a, b) => a - b);
  const sigma = diffs.length ? diffs[diffs.length >> 1] * 1.05 : 0;
  let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.73;
  for (const [x, y] of inside) {
    const w = grow.cover[y * W + x], g = gauss() * sigma, i = at(x, y), j = (y * W + x) * 3;
    for (let c = 0; c < 3; c++) data[i + c] = clamp(data[i + c] * (1 - w) + (bg[j + c] + g) * w);
  }
  return { applied: true, kind: "pill", alpha: 0, method: "detected", score: found.score, right: W - found.cx, bottom: H - found.cy };
}

// Returns { applied, kind, alpha, method, score, right, bottom } and changes image.data in place when a mark was there.
// With { assumePresent: true } (the picture comes from Flow, which always stamps one) a weak star match is taken too.
export function removeSparkle(image, { assumePresent = false } = {}) {
  const { width: W, height: H } = image;
  if (Math.min(W, H) < MIN_SIDE) return { applied: false, alpha: 0 };
  const S = Math.min(W, H), x0 = Math.max(0, W - Math.round(S * 0.3) - 40), y0 = Math.max(0, H - Math.round(S * 0.3) - 40);
  const lum = luminance(image, x0, y0);
  const star = findStar(image, lum), pill = findPill(image, lum);
  // The pill and the star never sit together; the better fit decides, and the star must clear its threshold unless the caller knows Flow made it.
  if (pill.score >= PILL_SCORE && pill.score > star.score) return inpaintPill(image, pill);
  const done = unveilStar(image, lum, star, assumePresent);
  if (done) return done;
  return { applied: false, alpha: 0, score: Math.max(star.score, pill.score) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2), get = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ""; };
  const image = get("--image"), out = get("--out"), flow = args.includes("--flow");
  if (image && out) {
    try {
      const picture = decodePng(readFileSync(image));
      const result = removeSparkle(picture, { assumePresent: flow });
      writeFileSync(out, result.applied ? encodePng(picture) : readFileSync(image));
      console.log(JSON.stringify({ applied: result.applied, kind: result.kind || "", method: result.method || "", alpha: Number((result.alpha || 0).toFixed(3)), score: Number((result.score ?? 0).toFixed(1)) }));
    } catch (error) { console.error(String(error.message || error)); process.exit(1); }
  }
}

// product-review-api: stores Product Review's result images in the public GitHub repo product-review-results and
// returns their raw.githubusercontent.com links for the Loox CSV. The app sends no password; this Worker holds the
// GitHub token (secret GITHUB_TOKEN, contents: write on that repo only) and accepts nothing but PNG images.
//   GET  /api/status                                   { ok }: the token is set
//   POST /api/images?batch=<run>&name=<file>&product=  body: PNG → { url, path }
import { Buffer } from "node:buffer";

const REPO = "hoangpham2263/product-review-results";
const MAX_BYTES = 20 * 1024 * 1024;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

// <batch>/<product>/<name>: each part reduced to letters, digits, dot, dash and underscore.
export function resultPath(batch, name, product) {
  const part = (s, max) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, max);
  const b = part(batch, 80), n = part(name, 120), p = part(product, 80) || "product";
  if (!b || !/\.png$/i.test(n)) return "";
  return `${b}/${p}/${n}`;
}

export const isPng = (bytes) => bytes.length > PNG.length && PNG.every((v, i) => bytes[i] === v);

async function github(env, method, path, body) {
  return fetch(`https://api.github.com/repos/${REPO}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, {
    method,
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "product-review-api", "x-github-api-version": "2022-11-28" },
    body: body && JSON.stringify(body),
  });
}

// One commit per image. Commits racing on the branch get 409: try again. The same path again replaces the file.
async function store(env, path, bytes) {
  const content = Buffer.from(bytes).toString("base64");
  let sha;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await github(env, "PUT", path, { message: `Add ${path}`, content, ...(sha ? { sha } : {}) });
    if (r.ok) return;
    if (r.status === 422 && !sha) {
      const existing = await github(env, "GET", path);
      if (existing.ok) { sha = (await existing.json()).sha; continue; }
    }
    if (r.status !== 409 && r.status < 500) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
    await new Promise((done) => setTimeout(done, attempt * 400 + Math.random() * 400));
  }
  throw new Error("GitHub busy");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/status" && req.method === "GET") return json({ ok: !!env.GITHUB_TOKEN });
    if (url.pathname === "/api/images" && req.method === "POST") {
      if (!env.GITHUB_TOKEN) return json({ error: "GITHUB_TOKEN is not set" }, 503);
      const path = resultPath(url.searchParams.get("batch"), url.searchParams.get("name"), url.searchParams.get("product"));
      if (!path) return json({ error: "batch and a .png name are required" }, 400);
      if (Number(req.headers.get("content-length") || 0) > MAX_BYTES) return json({ error: "too large" }, 413);
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > MAX_BYTES) return json({ error: "too large" }, 413);
      if (!isPng(bytes)) return json({ error: "PNG only" }, 415);
      try { await store(env, path, bytes); }
      catch (e) { return json({ error: e.message }, 502); }
      return json({ path, url: `https://raw.githubusercontent.com/${REPO}/main/${path.split("/").map(encodeURIComponent).join("/")}` });
    }
    return json({ error: "not found" }, 404);
  },
};

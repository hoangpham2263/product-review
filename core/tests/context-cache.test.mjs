// The product part of the context is cached by the sha256 of the product photo (PR_CONTEXT_CACHE points the test at a scratch file): the first item of a product writes it,
// context-brief of a sibling item (same photo) answers with cached_context, and "context -Cached" stores that context without a new look. Scratch workspace only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pwsh = process.platform === "win32" ? "powershell" : "pwsh";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("sibling items share the product context through the cache", { skip: spawnSync(pwsh, ["-NoProfile", "-Command", "1"]).status !== 0 }, () => {
  const ws = mkdtempSync(join(tmpdir(), "ctx-cache-"));
  try {
    const run = "agent-20261126000000-aaaa", dir = join(ws, "output", run);
    mkdirSync(join(dir, "logs"), { recursive: true }); mkdirSync(join(dir, "refs"), { recursive: true });
    const photo = join(ws, "p.png"); writeFileSync(photo, png);
    const item = (id) => ({ id, key: id, url: "https://shop.example.com/products/" + id, handle: id, product_image: photo, review_photo: photo });
    writeFileSync(join(dir, "agent-items.json"), JSON.stringify([item("001-a"), item("002-a")]));
    writeFileSync(join(dir, "agent-run.json"), "{}");
    const cache = join(ws, "cache.json");
    const call = (...a) => { const r = spawnSync(pwsh, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "src", "agent.ps1"), ...a], { env: { ...process.env, PR_WORKSPACE: ws, PR_CONTEXT_CACHE: cache }, encoding: "utf8" }); return JSON.parse(String(r.stdout).trim().split("\n").pop() || "{}"); };
    const before = call("context-brief", "-Run", run, "-Item", "001-a");
    assert.ok(!before.cached, JSON.stringify(before));
    const f = join(ws, "ctx.json");
    writeFileSync(f, JSON.stringify({ category_key: "neon-sign", product: "neon wall sign", presentation: "placed", details: "1. tube", lettered: false }));
    const first = call("context", "-Run", run, "-Item", "001-a", "-File", f);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.ok(existsSync(cache));
    const sib = call("context-brief", "-Run", run, "-Item", "002-a");
    assert.equal(sib.cached, true, JSON.stringify(sib));
    const second = call("context", "-Run", run, "-Item", "002-a", "-Cached");
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.context.product, "neon wall sign");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

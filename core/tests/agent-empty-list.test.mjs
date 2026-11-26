// A run the APP prepared (or any continuation) must never look empty to the agent: `prepare` lists every unfinished item (new:false for the ones already there) and `run-summary`
// takes its ids from agent-items.json, so items without an image yet show as needs_image (the DreamyVows run that "found nothing to do" with 40 items on disk).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pwsh = process.platform === "win32" ? "powershell" : "pwsh";
const cli = (ws, ...args) => JSON.parse(String(spawnSync(pwsh, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "src", "agent.ps1"), ...args], { env: { ...process.env, PR_WORKSPACE: ws }, encoding: "utf8", windowsHide: true }).stdout).trim().split("\n").pop());

test("prepare lists every unfinished item and run-summary shows items without an image", { skip: spawnSync(pwsh, ["-NoProfile", "-Command", "1"]).status !== 0 }, () => {
  const ws = mkdtempSync(join(tmpdir(), "agent-empty-")), run = "agent-20261126024001-b796", dir = join(ws, "output", run);
  try {
    mkdirSync(join(dir, "refs"), { recursive: true }); mkdirSync(join(dir, "logs"), { recursive: true }); mkdirSync(join(dir, "images"), { recursive: true });
    writeFileSync(join(ws, "urls.txt"), "");
    const items = [1, 2, 3, 4].map((n) => { const id = "00" + n + "-polo-" + n; return { id, key: "https://shop.example.com/products/polo-" + n + "||", url: "https://shop.example.com/products/polo-" + n, handle: "polo-" + n, product_image: join(dir, "refs", id + "-manual-product.png"), review_photo: join(dir, "refs", id + "-manual-review.png") }; });
    writeFileSync(join(dir, "agent-items.json"), JSON.stringify(items));
    for (const it of items) { writeFileSync(join(dir, "refs", it.id + "-manual-product.png"), "x"); writeFileSync(join(dir, "refs", it.id + "-manual-review.png"), "x"); }
    const prep = cli(ws, "prepare", "-Run", run);
    assert.equal(prep.ok, true); assert.equal(prep.items.length, 4); assert.equal(prep.unfinished, 4); assert.ok(prep.items.every((x) => x.new === false && x.has_image === false));
    const sum = cli(ws, "run-summary", "-Run", run);
    assert.equal(sum.items.filter((x) => x.status === "needs_image").length, 4);
    assert.equal(sum.site, "shop.example.com");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

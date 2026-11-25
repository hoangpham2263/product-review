// `agent.ps1 prepare -Run <fresh id>` creates the run folder and agent-items.json from the queue (the phased image job calls it BEFORE its workers: a fresh id used to fail with
// "Run not found"); a second prepare (Chạy tiếp, or the main run after the workers) finds the same run. Uses a scratch workspace, no real data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pwsh = process.platform === "win32" ? "powershell" : "pwsh";

function prepare(ws, run) {
  const r = spawnSync(pwsh, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "src", "agent.ps1"), "prepare", "-Run", run], { env: { ...process.env, PR_WORKSPACE: ws }, encoding: "utf8", windowsHide: true });
  return JSON.parse(String(r.stdout).trim().split("\n").pop());
}

test("prepare with a fresh run id creates the folder and the items; a second prepare finds the same run", { skip: spawnSync(pwsh, ["-NoProfile", "-Command", "1"]).status !== 0 }, () => {
  const ws = mkdtempSync(join(tmpdir(), "agent-prepare-"));
  try {
    writeFileSync(join(ws, "urls.txt"), "https://shop.example.com/products/item-one\nhttps://shop.example.com/products/item-two\n");
    const run = "agent-20261125081333-ea42";
    const first = prepare(ws, run);
    assert.equal(first.ok, true);
    assert.equal(first.run, run);
    const file = join(ws, "output", run, "agent-items.json");
    assert.ok(existsSync(file));
    assert.equal(first.items.length, 2); // a queue without photos: both links are reported (with their reason), the run exists
    const second = prepare(ws, run);
    assert.equal(second.ok, true);
    assert.equal(second.run, run);
    assert.ok(existsSync(file));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

// Thêm vào hàng chờ during a run: a link added to urls.txt after the run started (queue-add) is never taken by the run (a second prepare = Chạy tiếp keeps the run's own links),
// and the app's queueSave (rpc.ps1) keeps the added link and does not write back a link the run finished. Scratch workspace via PR_WORKSPACE, no AI, no real data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pwsh = process.platform === "win32" ? "powershell" : "pwsh";
const A = "https://shop.example.com/products/item-one", B = "https://shop.example.com/products/item-two", C = "https://shop.example.com/products/added-mid-run";

const prepare = (ws, run) => {
  const r = spawnSync(pwsh, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "src", "agent.ps1"), "prepare", "-Run", run], { env: { ...process.env, PR_WORKSPACE: ws }, encoding: "utf8", windowsHide: true });
  return JSON.parse(String(r.stdout).trim().split("\n").pop());
};
const rpc = (ws, cmd, args) => {
  const r = spawnSync(pwsh, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "src", "mac", "rpc.ps1")], { input: JSON.stringify({ id: 1, cmd, args }) + "\n", env: { ...process.env, PR_WORKSPACE: ws }, encoding: "utf8", windowsHide: true });
  const line = String(r.stdout).split(/\r?\n/).find((l) => l.startsWith("@@RPC "));
  return JSON.parse(line.slice(6));
};
const urls = (ws) => readFileSync(join(ws, "urls.txt"), "utf8").replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

test("a queue-add write during a run: the run keeps its own links, queueSave keeps the added one", { skip: spawnSync(pwsh, ["-NoProfile", "-Command", "1"]).status !== 0 }, () => {
  const ws = mkdtempSync(join(tmpdir(), "queue-add-run-"));
  try {
    writeFileSync(join(ws, "urls.txt"), `${A}\n${B}\n`);
    const run = "agent-20261126010101-ab12";
    const first = prepare(ws, run);
    assert.deepEqual(first.items.map((i) => i.url).sort(), [A, B]);
    // queue-add appends a link while the run is active
    appendFileSync(join(ws, "urls.txt"), `${C}\r\n`);
    const second = prepare(ws, run); // Chạy tiếp / second prepare
    assert.equal(second.ok, true);
    assert.deepEqual(second.items.map((i) => i.url).sort(), [A, B], "the run must not absorb the added link");
    const items = JSON.parse(readFileSync(join(ws, "output", run, "agent-items.json"), "utf8").replace(/^﻿/, ""));
    assert.ok(!JSON.stringify(items).includes("added-mid-run"));
    // the run finishes A (it leaves the queue); the page, still showing A and B, saves after queue-add wrote C
    writeFileSync(join(ws, "urls.txt"), `${B}\n${C}\n`);
    const saved = rpc(ws, "queueSave", { urls: [A, B], base: [A, B], requireReady: false });
    assert.equal(saved.ok, true, saved.error);
    assert.deepEqual(urls(ws), [B, C], "C kept, finished A not written back");
    // a page row removed by the user is removed; a link the page added is kept
    const saved2 = rpc(ws, "queueSave", { urls: [C, "https://shop.example.com/products/new-row"], base: [B, C], requireReady: false });
    assert.equal(saved2.ok, true, saved2.error);
    assert.deepEqual(urls(ws), [C, "https://shop.example.com/products/new-row"]);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

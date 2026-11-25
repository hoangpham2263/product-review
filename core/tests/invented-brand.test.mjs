// Custom-logo products: the sample logo is replaced by an INVENTED brand name (src/agent.ps1 Get-InventedBrandName), different for consecutive items of a run, the same for the same item,
// and the condensed prompt names it (the old "no readable words or initials" rule is gone). The function is cut out of agent.ps1 and run in PowerShell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = readFileSync(join(root, "src", "agent.ps1"), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
const a = src.indexOf("$script:InventedBrandNames = @("), b = src.indexOf("function Get-CondensedFlowPrompt(");
const snippet = src.slice(a, b);
const pwsh = process.platform === "win32" ? "powershell" : "pwsh";
const ps = (extra) => { const r = spawnSync(pwsh, ["-NoProfile", "-Command", snippet + "\n" + extra], { encoding: "utf8", windowsHide: true }); return r.stdout.trim().split(/\r?\n/); };

test("about 60 invented names, no duplicates, no empty", () => {
  const list = [...snippet.slice(0, snippet.indexOf("function Get-InventedBrandName")).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(list.length >= 55, "names: " + list.length);
  assert.equal(new Set(list.map((n) => n.toLowerCase())).size, list.length);
});

test("deterministic per run + item, and consecutive items of a run differ", { skip: spawnSync(pwsh, ["-NoProfile", "-Command", "1"]).status !== 0 }, () => {
  const out = ps(`$k = 'agent-20261125081715-b48e'; 'A=' + (Get-InventedBrandName "$k-001-polo-one"); 'B=' + (Get-InventedBrandName "$k-001-polo-one"); (1..12 | ForEach-Object { Get-InventedBrandName ("$k-{0:D3}-x" -f $_) } | Sort-Object -Unique).Count`);
  assert.equal(out[0].slice(2), out[1].slice(2));
  assert.equal(Number(out[2]), 12);
});

test("the prompt uses the name and the old symbol-only rule is gone", () => {
  assert.ok(src.includes("invented brand name \"' + $logoName + '\""));
  assert.ok(!/no readable words or initials/.test(src));
  assert.match(src, /logo_name = Get-InventedBrandName/);
});

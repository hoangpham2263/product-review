// The random scene pool + used-scene ledger of scan.ps1 (no tags, no scene-index.json): deterministic per seed, no photo repeated across 50 products or across two windows,
// photos held by another product never offered. The real functions are cut out of scan.ps1 and run in PowerShell with a fake library of 300 untagged photos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = readFileSync(join(root, "src", "scan.ps1"), "utf8").replace(/\r\n/g, "\n");
const a = src.indexOf("# ---- Used-scene ledger"), b = src.indexOf("# One pool item through the per-file filters");
assert.ok(a > 0 && b > a, "ledger + pool functions found");
const funcs = src.slice(a, b);

function run(script, dir) {
  const file = join(dir, "t.ps1");
  writeFileSync(file, [
    "$ErrorActionPreference = 'Stop'",
    `$LibraryDir = '${dir.replace(/'/g, "''")}'`,
    "function Get-ScanUrlKey([string]$u) { return $u.Trim().ToLowerInvariant() }",
    "function Read-TextRetry([string]$p) { return [IO.File]::ReadAllText($p) }",
    "function Use-FileLock([string]$p, [scriptblock]$body) { return (& $body) }",
    "function Write-FileAtomic([string]$p, [string]$t, $enc) { [IO.File]::WriteAllText($p, $t, $enc) }",
    "function Get-Stamp { return '2026-01-01 00:00:00' }",
    "function Get-LibraryPhotosCached([string]$g) { return @(1..300 | ForEach-Object { [pscustomobject]@{ name = ('p{0:000}.jpg' -f $_); category = 'x'; md5 = [string]$_ } }) }",
    funcs, script,
  ].join("\n"), "utf8");
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout.trim().split(/\r?\n/);
}

test("same seed = same order, other seed = other order; tags are not needed", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-pool-"));
  try {
    const out = run(`
      $x = (Get-ScenePool 'Áo' '' 'seed-1' '').items | Select-Object -First 16 | ForEach-Object { $_.photo.name }
      $y = (Get-ScenePool 'Áo' '' 'seed-1' '').items | Select-Object -First 16 | ForEach-Object { $_.photo.name }
      $z = (Get-ScenePool 'Áo' '' 'seed-2' '').items | Select-Object -First 16 | ForEach-Object { $_.photo.name }
      ($x -join ',') ; ($y -join ',') ; ($z -join ',')
      (Get-ScenePool 'Áo' '' 'seed-1' '').free`, dir);
    assert.equal(out[0], out[1]);
    assert.notEqual(out[0], out[2]);
    assert.equal(out[3], "300");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("50 products x 4 scenes never repeat a photo, across two windows either; held photos are not offered", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-pool-"));
  try {
    const out = run(`
      $taken = @{}; $dups = 0
      # window A takes products 1-25, window B (a separate pool read, same ledger) takes 26-50
      foreach ($w in 'A', 'B') {
        $from = if ($w -eq 'A') { 1 } else { 26 }
        foreach ($i in $from..($from + 24)) {
          $url = "https://shop/p$i"
          $pool = Get-ScenePool 'Áo' '' ("$w|run") $url
          $names = @($pool.items | Select-Object -First 4 | ForEach-Object { [string]$_.photo.name })
          $held = @(Add-SceneLedger 'Áo' $names $url)
          if ($held.Count) { $dups++; continue }
          foreach ($n in $names) { if ($taken.ContainsKey($n)) { $dups++ }; $taken[$n] = $true }
        }
      }
      "dups=$dups"; "taken=$($taken.Count)"
      $free = (Get-ScenePool 'Áo' '' 'x' 'https://shop/new').free
      "free=$free"
      # a photo held by another product cannot be claimed again, but its own product may re-claim it
      "again=" + @(Add-SceneLedger 'Áo' @($taken.Keys | Select-Object -First 1) 'https://shop/other').Count
      "own=" + @(Add-SceneLedger 'Áo' @('p001.jpg') 'https://shop/p1').Count`, dir);
    const kv = Object.fromEntries(out.map((l) => l.split("=")));
    assert.equal(kv.dups, "0");
    assert.equal(kv.taken, "200");
    assert.equal(kv.free, String(300 - 200));
    assert.equal(kv.again, "1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scene-candidates / scene-apply / scene-auto do not read the tag index", () => {
  const cmds = src.slice(src.indexOf("        'scene-candidates' {"), src.indexOf("        'contact-sheet' {"));
  assert.ok(!/Read-SceneIndex|Get-SceneIndexEntry|scene-index/.test(cmds) && !/Read-SceneIndex/.test(funcs));
});

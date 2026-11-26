// queue-from-prepared (the instant "Thêm vào hàng chờ" from the prepared stock) used to take minutes: the library catalog (thousands of photos) was parsed again for EVERY prepared
// scene while the used scenes were collected, and photos were found by scanning the whole list. The library of a group is now read once per command and looked up by name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "src", "scan.ps1"), "utf8").replace(/\r\n/g, "\n");
const between = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));

test("the used-scenes collection and the scene check read a group's library once, not per prepared row / scene", () => {
  const used = between("function Get-PreparedUsedScenes", "function Test-SceneSet");
  assert.ok(!/Get-LibraryPhotos \(\[string\]\$row\.group\)/.test(used), "Get-PreparedUsedScenes must not re-read the catalog per row");
  assert.ok(/Get-LibraryPhotoByName/.test(used));
  const check = between("function Test-SceneSet", "function Get-ProjectCandidates");
  assert.ok(!/@\(Get-LibraryPhotos \$LibraryGroup\)/.test(check));
  assert.ok(/Get-LibraryPhotosCached/.test(check) && /Get-LibraryPhotoByName/.test(check));
});

test("a failed command shows its reason in Vietnamese, not the raw command line", () => {
  const server = readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."), "src", "mac", "server.mjs"), "utf8");
  assert.ok(/Quá thời gian: /.test(server) && /const cliFailure/.test(server));
  assert.ok(!/error: \(err && err\.message\) \|\| "Không đọc được kết quả của src\/scan\.ps1/.test(server));
});

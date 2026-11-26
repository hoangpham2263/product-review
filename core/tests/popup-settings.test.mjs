// What the person picks in the Dự án and Quét web popups is saved per window (run-settings.json) and restored when the popup opens again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const server = readFileSync(join(root, "src", "mac", "server.mjs"), "utf8");
const app = readFileSync(join(root, "src", "mac", "ui", "app.js"), "utf8");

test("the server validates and stores every popup pick", () => {
  for (const key of ["unusedOnly", "lastProject", "lastCategory", "scanSite", "scanProject", "scanMax"]) assert.ok(server.includes("given." + key) || server.includes('"' + key + '"'), key);
});
test("the popups write them on change and restore them on open", () => {
  for (const key of ["lastProject", "lastCategory", "unusedOnly", "scanSite", "scanMax", "scanProject"]) assert.ok(app.includes(key), key);
  assert.ok(/savedPick\.category/.test(app) && /s\.unusedOnly !== false/.test(app));
});

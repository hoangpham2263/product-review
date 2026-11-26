// The phased image job (src/mac/server.mjs): an image agent that quits after ONE group is run again for the rest, a stuck one stops after two launches without progress, and
// reviews + finish follow the images while it works. The job code is cut out of server.mjs and run against fake runners and a scratch run folder (no real run).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

process.env.PR_FIN_WAITS = "20,20,20,20"; // the upload retry waits, shortened for the test

const serverFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "mac", "server.mjs");
const src = fs.readFileSync(serverFile, "utf8");
const code = src.slice(src.indexOf("let imgJob = null"), src.indexOf("// Everything of the run is there on disk")).replace("function runAgentCli(", "function realRunAgentCli(")
  + "\nreturn { start: startImgJob, tick: jobTick, state: () => ({ imgJob, jobFinal }) };";

async function scenario(mode, reviewAi, opts = {}) {
  const N = 8, base = fs.mkdtempSync(path.join(os.tmpdir(), "job-")), run = "agent-job1", dir = path.join(base, "output", run);
  fs.mkdirSync(path.join(dir, "images"), { recursive: true }); fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  const ids = Array.from({ length: N }, (_, i) => String(i + 1).padStart(3, "0") + "-p");
  fs.writeFileSync(path.join(dir, "agent-items.json"), JSON.stringify(ids.map((id) => ({ id }))));
  let launches = 0;
  const agentRunner = {
    _active: false, _status: { status: "idle" },
    isActive() { return this._active; },
    start() { launches++; this._active = true; const missing = ids.filter((id) => !fs.existsSync(path.join(dir, "images", id + ".png"))), take = mode === "stuck" ? [] : missing.slice(0, 4);
      setTimeout(() => { for (const id of take) fs.writeFileSync(path.join(dir, "images", id + ".png"), "x"); this._active = false; this._status = { status: "done", error: "" }; }, 30); return { ok: true }; },
    status() { return this._status; }, setFinal() {}, stop() {},
  };
  const failures = {}; let busyGiven = false;
  const runAgentCli = async (args) => {
    const id = args[args.indexOf("-Item") + 1];
    if (opts.busyOnce && args[0] === "review-brief" && !busyGiven) { busyGiven = true; return { ok: false, cause: "LOCK_BUSY", error: "Đợi worker khác của lượt này ghi xong, thử lại sau vài giây." }; }
    if (args[0] === "finish" && opts.finishFail) { failures[id] = (failures[id] || 0) + 1; if (opts.finishFail === "always" || failures[id] <= opts.finishFail) return { ok: false, cause: "RESULT_UPLOAD", error: "HTTP 0" }; }
    if (args[0] === "ai-draft") fs.writeFileSync(args[args.indexOf("-File") + 1], "review");
    if (args[0] === "write-review") fs.writeFileSync(path.join(dir, "logs", id + "-review.txt"), "ok");
    if (args[0] === "finish") { const f = path.join(dir, "results.json"); let r = []; try { r = JSON.parse(fs.readFileSync(f, "utf8")); } catch {} r.push({ photo_path: "C:/x/" + id + ".png" }); fs.writeFileSync(f, JSON.stringify(r)); }
    return { ok: true };
  };
  const fakeLight = () => ({ _a: false, isActive() { return this._a; }, start(o) { this._a = true; const part = JSON.parse(fs.readFileSync(o.options.match(/items file: ([^;]+)/)[1], "utf8"));
    for (const id of part) { if (o.mode === "ctx") fs.writeFileSync(path.join(dir, "logs", id + "-context.json"), "{}"); if (o.mode === "rev") fs.writeFileSync(path.join(dir, "logs", id + "-review.txt"), "ok"); }
    setTimeout(() => { this._a = false; }, 20); return { ok: true }; }, stop() {}, status() { return {}; } });
  const names = ["workspace", "readFileSync", "existsSync", "join", "dirname", "mkdirSync", "writeFileSync", "newRunId", "shardFiles", "cleanShardFiles", "clampThreads", "runAgentCli", "agentRunner", "lightPool", "setInterval", "clearInterval", "setImmediate", "readdirSync"];
  const vals = [base, fs.readFileSync, fs.existsSync, path.join, path.dirname, fs.mkdirSync, fs.writeFileSync, () => "x-0000", [], () => {}, (v) => Math.min(4, Math.max(1, v | 0)), runAgentCli, agentRunner, [fakeLight(), fakeLight(), fakeLight(), fakeLight()], () => 0, () => {}, () => {}, fs.readdirSync];
  const job = new Function(...names, code)(...vals);
  job.start(run, 2, "antigravity", "antigravity", reviewAi);
  for (let i = 0; i < 600; i++) { await job.tick(); if (!job.state().imgJob) break; await new Promise((r) => setTimeout(r, 10)); }
  const out = { jobLines: job.state().jobFinal ? job.state().jobFinal.tail : [], launches, images: ids.filter((id) => fs.existsSync(path.join(dir, "images", id + ".png"))).length, reviews: ids.filter((id) => fs.existsSync(path.join(dir, "logs", id + "-review.txt"))).length, final: job.state().jobFinal };
  fs.rmSync(base, { recursive: true, force: true });
  return out;
}

test("an image agent that quits after one group is launched again until every item has its image, reviews by an explicit AI follow", async () => {
  const r = await scenario("group", "claude");
  assert.equal(r.launches, 2); assert.equal(r.images, 8); assert.equal(r.reviews, 8); assert.equal(r.final.status, "done");
});
test("the agent AI reviews (rev workers) and the finish step follow too", async () => {
  const r = await scenario("group", "auto");
  assert.equal(r.images, 8); assert.equal(r.reviews, 8); assert.equal(r.final.status, "done");
});
test("a busy per-run lock is a short wait, not a failed attempt", async () => {
  const r = await scenario("group", "claude", { busyOnce: true });
  assert.equal(r.reviews, 8); assert.equal(r.final.status, "done");
  assert.equal(r.jobLines.filter((l) => /đợi worker khác ghi/.test(l)).length, 1);
});
test("a results upload that fails for a moment (network) is retried and the run completes", async () => {
  const r = await scenario("group", "claude", { finishFail: 2 });
  assert.equal(r.final.status, "done"); assert.equal(r.final.error, "");
});
test("when only the upload keeps failing the run is done with an amber note, not a failure", async () => {
  const r = await scenario("group", "claude", { finishFail: "always" });
  assert.equal(r.images, 8); assert.equal(r.reviews, 8);
  assert.equal(r.final.status, "done"); assert.match(r.final.error, /chưa tải lên kho: bấm Chạy tiếp/);
});
test("an agent that makes nothing is not run forever and the run is never reported done", async () => {
  const r = await scenario("stuck", "claude");
  assert.equal(r.launches, 2); assert.equal(r.final.status, "failed"); assert.match(r.final.error, /chưa có ảnh/);
});

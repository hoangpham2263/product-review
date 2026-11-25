// A dropped agy connection ("the connection to the agent was interrupted ... subscriber fell behind updates") is transient: the run starts again by itself and finishes. Quota text
// is never classified as transient, an ordinary failure is not retried. Fake agy process, no real run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

process.env.PR_NET_WAITS = "30";
const { createAgentRunner, isTransientAgyError } = await import("../setup/agent-run.mjs");
const DROP = "the connection to the agent was interrupted before the response finished: conversation update stream lost: subscriber fell behind updates, stalled for 10s";

test("what counts as transient", () => {
  assert.equal(isTransientAgyError(DROP), true);
  assert.equal(isTransientAgyError("read ECONNRESET"), true);
  assert.equal(isTransientAgyError("429 RESOURCE_EXHAUSTED: You have exhausted your capacity on this model. reset after 3h"), false);
  assert.equal(isTransientAgyError("Please sign in"), false);
});

function setup(outcomes, events = 8) { // events = tool steps each launch gets through before it ends (progress resets the retry count)
  const base = mkdtempSync(join(tmpdir(), "agy-net-")), tool = join(base, "tool"), ws = join(base, "ws");
  mkdirSync(join(tool, "docs"), { recursive: true }); mkdirSync(join(ws, "config"), { recursive: true });
  writeFileSync(join(tool, "docs", "scan-prompt.md"), "```text\nT {{RUN}}\n```\n");
  writeFileSync(join(ws, "config", "run-settings.json"), JSON.stringify({ agentBackend: "antigravity", scanAgent: "antigravity" }));
  let spawns = 0;
  const spawnFn = () => {
    const kid = new EventEmitter(); kid.stdout = new PassThrough(); kid.stderr = new PassThrough(); kid.stdin = new PassThrough(); kid.pid = ++spawns;
    const outcome = outcomes[Math.min(spawns - 1, outcomes.length - 1)];
    setTimeout(() => {
      for (let i = 1; i <= events; i++) kid.stdout.write(JSON.stringify({ event: "step_update", step_update: { step_index: i, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "echo " + i } } } }) + "\n");
      kid.stdout.write(JSON.stringify({ event: "result", result: outcome === "ok" ? { status: "SUCCESS", response: "ok", num_turns: 1 } : { status: "ERROR", error: outcome } }) + "\n");
      setTimeout(() => kid.emit("close", outcome === "ok" ? 0 : 1), 5);
    }, 10);
    return kid;
  };
  const runner = createAgentRunner({ toolRoot: tool, workspace: ws, kind: "main", getBrowser: () => ({ mode: "own" }), spawnFn, npxOk: () => true, killTree: () => {}, findAgyCli: () => ({ found: true, path: "agy.exe" }), graceMs: 10 });
  runner.start({ run: "scan-net1", mode: "scan", site: "https://example.com" });
  return { runner, spawns: () => spawns, done: () => { runner.stop(); rmSync(base, { recursive: true, force: true }); } };
}
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await new Promise((r) => setTimeout(r, 15)); } return false; };

test("a dropped connection mid-run is retried and the run completes", async () => {
  const f = setup([DROP, "ok"]);
  assert.ok(await until(() => !f.runner.isActive()));
  const st = f.runner.status();
  assert.equal(st.status, "done"); assert.equal(f.spawns(), 2);
  assert.ok(st.tail.some((l) => /Mất kết nối với Antigravity, tự chạy lại \(lần 1\/5/.test(l)));
  f.done();
});
test("an ordinary failure is not retried", async () => {
  const f = setup(["Something else went wrong"]);
  assert.ok(await until(() => !f.runner.isActive()));
  assert.equal(f.runner.status().status, "failed"); assert.equal(f.spawns(), 1);
  f.done();
});
test("the retries are bounded (5) and then the run fails with the error", async () => {
  const f = setup([DROP], 0); // no progress in any launch
  assert.ok(await until(() => !f.runner.isActive(), 6000));
  const st = f.runner.status();
  assert.equal(st.status, "failed"); assert.equal(f.spawns(), 6); assert.match(st.error, /connection to the agent was interrupted/);
  f.done();
});

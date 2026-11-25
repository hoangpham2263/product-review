// Antigravity capacity 429: only its own error sources stop a run. The text of an old 429 inside a run_command / view_file result (a run-summary echoing error files of an
// earlier incident) or in the agent's prose must NEVER stop a healthy run. Fake agy process, no real run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

process.env.PR_CAP_WAITS = "5000";
const { createAgentRunner } = await import("../setup/agent-run.mjs");
const TXT = "[CAUSE:QUOTA] HTTP 429 RESOURCE_EXHAUSTED: You have exhausted your capacity on this model. Your quota will reset after 3h28m59s";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "agy-quota-")), tool = join(base, "tool"), ws = join(base, "ws");
  mkdirSync(join(tool, "docs"), { recursive: true }); mkdirSync(join(ws, "config"), { recursive: true });
  writeFileSync(join(tool, "docs", "scan-prompt.md"), "```text\nT {{RUN}}\n```\n");
  writeFileSync(join(ws, "config", "run-settings.json"), JSON.stringify({ agentBackend: "antigravity", scanAgent: "antigravity" }));
  let kid, killed = 0;
  const spawnFn = () => { kid = new EventEmitter(); kid.stdout = new PassThrough(); kid.stderr = new PassThrough(); kid.stdin = new PassThrough(); kid.pid = 1; return kid; };
  const runner = createAgentRunner({ toolRoot: tool, workspace: ws, kind: "main", getBrowser: () => ({ mode: "own" }), spawnFn, npxOk: () => true, killTree: (c) => { killed++; setTimeout(() => c.emit("close", 1), 3); }, findAgyCli: () => ({ found: true, path: "agy.exe" }), graceMs: 10 });
  runner.start({ run: "scan-quota1", mode: "scan", site: "https://example.com" });
  return { runner, kid: () => kid, killed: () => killed, done: () => { runner.stop(); rmSync(base, { recursive: true, force: true }); } };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (f, o) => f.kid().stdout.write(JSON.stringify(o) + "\n");
const tool = (name, info, i) => ({ event: "step_update", step_update: { step_index: i, state: "DONE", step_type: "tool", tool_name: name, tool_info: info } });
const reacted = (f) => f.killed() > 0 || f.runner.status().tail.some((l) => /tự thử lại lần/.test(l));

test("old 429 text in a run_command output, a tool error, a file view or the agent's prose does not stop the run", async () => {
  const f = fixture();
  send(f, tool("run_command", { output: "Command output: " + JSON.stringify({ ok: true, cause: TXT }) }, 1));
  send(f, tool("run_command", { error: { message: TXT } }, 2));
  send(f, tool("view_file", { output: TXT }, 3));
  send(f, { event: "step_update", step_update: { step_index: 4, state: "ACTIVE", step_type: "agent_response", text_delta: TXT } });
  await wait(80);
  assert.equal(reacted(f), false);
  assert.equal(f.runner.isActive(), true);
  f.done();
});

test("a real 429 from stderr, an error event, a failed result or the subagent step does", async () => {
  const cases = [
    (f) => f.kid().stderr.write("429 RESOURCE_EXHAUSTED: You have exhausted your capacity on this model. Your quota will reset after 3h28m59s\n"),
    (f) => send(f, { event: "error", error: { message: "RESOURCE_EXHAUSTED: exhausted your capacity. reset after 3h" } }),
    (f) => send(f, { event: "result", result: { status: "ERROR", error: "RESOURCE_EXHAUSTED: You have exhausted your capacity. reset after 1h" } }),
    (f) => send(f, { event: "step_update", step_update: { step_index: 9, state: "ERROR", step_type: "subagent", tool_name: "invoke_subagent", subagent_info: { subagents: [{ type_name: "image-generator", error: "RESOURCE_EXHAUSTED: exhausted your capacity, reset after 2h" }] } } }),
  ];
  for (const fire of cases) { const f = fixture(); fire(f); await wait(80); assert.equal(reacted(f), true); f.done(); await wait(20); }
});

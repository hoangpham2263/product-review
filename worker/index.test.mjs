import test from "node:test";
import assert from "node:assert/strict";
import worker, { resultPath, isPng } from "./index.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test("result paths keep only safe characters", () => {
  assert.equal(resultPath("20261104-101500", "item-1.png", "Bàn gỗ / tự nhiên"), "20261104-101500/Ban-go-tu-nhien/item-1.png");
  assert.equal(resultPath("../x", "a.png", ""), "x/product/a.png");
  assert.equal(resultPath("", "a.png", "p"), "");
  assert.equal(resultPath("b", "a.jpg", "p"), "");
});

test("only PNG bytes pass", () => {
  assert.ok(isPng(png));
  assert.ok(!isPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0])));
});

test("an image is committed and its raw link returned", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init.method, JSON.parse(init.body)]); return new Response("{}", { status: 201 }); };
  const r = await worker.fetch(new Request("https://w/api/images?batch=run1&name=a.png&product=p", { method: "POST", body: png }), { GITHUB_TOKEN: "t" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { path: "run1/p/a.png", url: "https://raw.githubusercontent.com/hoangpham2263/product-review-results/main/run1/p/a.png" });
  assert.equal(calls[0][1], "PUT");
  assert.match(calls[0][0], /\/contents\/run1\/p\/a\.png$/);
  assert.equal(calls[0][2].content, Buffer.from(png).toString("base64"));
});

test("a racing commit (409) is tried again", async () => {
  let n = 0;
  globalThis.fetch = async () => new Response("{}", { status: ++n === 1 ? 409 : 201 });
  const r = await worker.fetch(new Request("https://w/api/images?batch=b&name=a.png", { method: "POST", body: png }), { GITHUB_TOKEN: "t" });
  assert.equal(r.status, 200);
  assert.equal(n, 2);
});

test("non-PNG bodies and a missing token are refused", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0]);
  assert.equal((await worker.fetch(new Request("https://w/api/images?batch=b&name=a.png", { method: "POST", body: jpeg }), { GITHUB_TOKEN: "t" })).status, 415);
  assert.equal((await worker.fetch(new Request("https://w/api/images?batch=b&name=a.png", { method: "POST", body: png }), {})).status, 503);
  assert.deepEqual(await (await worker.fetch(new Request("https://w/api/status"), {})).json(), { ok: false });
});

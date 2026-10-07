import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, plugin, sse, t } from "../src/index.ts";

const quiet = { log: false as const };
const req = (path: string, init?: RequestInit) => new Request(`http://api.test${path}`, init);

const app = inkan({ ...quiet, bodyLimit: 1000 })
  .get("/teas/:id", { params: t.object({ id: t.int() }), response: { 200: t.object({ id: t.int(), name: t.string() }) } }, ({ params }) => ({
    id: params.id,
    name: "Sencha",
    secret: "kept back",
  }))
  .post("/teas", { body: t.object({ name: t.string().min(1) }), response: { 201: t.object({ name: t.string() }) } }, ({ body, reply }) => reply(201, body))
  .get("/ticks", () =>
    sse(async function* () {
      for (let i = 0; ; i++) yield { event: "tick", data: i };
    }),
  );

test("app.fetch: a Request in, a Response out, with the contract applied", async () => {
  const res = await app.fetch(req("/teas/7?x=1"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.ok(res.headers.get("x-request-id"));
  assert.deepEqual(await res.json(), { id: 7, name: "Sencha" });
});

test("app.fetch: bodies are read and checked, problems come back as problems", async () => {
  const ok = await app.fetch(req("/teas", { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"Mio"}' }));
  assert.equal(ok.status, 201);
  assert.deepEqual(await ok.json(), { name: "Mio" });

  const bad = await app.fetch(req("/teas", { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":""}' }));
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("content-type"), "application/problem+json");
  assert.equal(((await bad.json()) as any).errors[0].path, "name");

  const nf = await app.fetch(req("/nowhere"));
  assert.equal(nf.status, 404);
  assert.equal(((await nf.json()) as any).type, "not-found");
});

test("app.fetch: the body limit holds, also without a content-length", async () => {
  const big = "x".repeat(2000);
  const declared = await app.fetch(req("/teas", { method: "POST", headers: { "content-type": "application/json" }, body: big }));
  assert.equal(declared.status, 413);
  const streamed = new ReadableStream({
    start(c) {
      for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode("y".repeat(100)));
      c.close();
    },
  });
  const chunked = await app.fetch(req("/teas", { method: "POST", headers: { "content-type": "application/json" }, body: streamed, duplex: "half" } as RequestInit));
  assert.equal(chunked.status, 413);
  assert.equal(((await chunked.json()) as any).type, "body-too-large");
});

test("app.fetch: HEAD has the length and no body", async () => {
  const res = await app.fetch(req("/teas/1", { method: "HEAD" }));
  assert.equal(res.status, 200);
  assert.ok(Number(res.headers.get("content-length")) > 0);
  assert.equal(await res.text(), "");
});

test("app.fetch: a stream stays a stream, and cancelling it stops the source", async () => {
  const res = await app.fetch(req("/ticks"));
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("data: 2")) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.match(text, /event: tick\ndata: 0/);
});

test("app.fetch: the inspector stays shut without a loopback address, and opens with one", async () => {
  const dev = inkan({ ...quiet, dev: true }).get("/x", () => ({ ok: 1 }));
  assert.equal((await dev.fetch(req("/_inkan"))).status, 404);
  assert.equal((await dev.fetch(req("/_inkan"), { remote: "203.0.113.9" })).status, 404);
  assert.equal((await dev.fetch(req("/_inkan"), { remote: "127.0.0.1" })).status, 200);
  assert.equal((await dev.fetch(req("/docs"))).status, 200, "the docs page is for everybody");
});

test("app.fetch waits for plugins, and onResponse runs once the answer is out", async () => {
  const seen: number[] = [];
  const later = inkan(quiet)
    .onResponse((_ctx, done) => void seen.push(done.status))
    .register(
      plugin(async (scope) => {
        await new Promise((r) => setTimeout(r, 5));
        scope.get("/late", () => ({ ok: 1 }));
      }),
    );
  const res = await later.fetch(req("/late"));
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [200]);
});

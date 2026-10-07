// One set of requests every way of serving an inkan app has to answer alike: node:http,
// app.fetch and every adapter in adapters/. A server is handed in as `start(app)`, which
// listens and says where.

import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, sse, t, type App } from "../../src/index.ts";

export type Started = { url: string; close: () => Promise<void> };

export function conformance(name: string, start: (app: App) => Promise<Started>) {
  const events: string[] = [];
  const build = () =>
    inkan({ log: false, gracefulShutdown: false, bodyLimit: 1000 })
      .get("/teas/:id", { params: t.object({ id: t.int() }), response: { 200: t.object({ id: t.int(), name: t.string() }) } }, ({ params }) => ({
        id: params.id,
        name: "Sencha",
        secret: "kept back",
      }))
      .post("/teas", { body: t.object({ name: t.string().min(1) }), response: { 201: t.object({ name: t.string() }) } }, ({ body, reply }) =>
        reply(201, body, { location: "/teas/1" }),
      )
      .get("/echo", ({ query, headers }) => ({ query, ua: (headers as Record<string, string>)["x-test"] }))
      .get("/ticks", () =>
        sse(async function* () {
          for (let i = 0; ; i++) yield { event: "tick", data: i };
        }),
      )
      .onListen(() => void events.push("listen"))
      .onClose(() => void events.push("close"));

  test(`${name}: answers like every other way of serving inkan`, { timeout: 20_000 }, async (t) => {
    const server = await start(build());
    const at = (p: string) => server.url + p;
    try {
      await t.test("a route with params, trimmed to its contract, with a request id", async () => {
        const r = await fetch(at("/teas/7"));
        assert.equal(r.status, 200);
        assert.match(r.headers.get("content-type") ?? "", /application\/json/);
        assert.ok(r.headers.get("x-request-id"));
        assert.deepEqual(await r.json(), { id: 7, name: "Sencha" });
      });
      await t.test("a body is read and checked; headers set by the handler go out", async () => {
        const ok = await fetch(at("/teas"), { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"Mio"}' });
        assert.equal(ok.status, 201);
        assert.equal(ok.headers.get("location"), "/teas/1");
        assert.deepEqual(await ok.json(), { name: "Mio" });
        const bad = await fetch(at("/teas"), { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":""}' });
        assert.equal(bad.status, 400);
        assert.equal(bad.headers.get("content-type"), "application/problem+json");
      });
      await t.test("query and headers arrive", async () => {
        const r = await fetch(at("/echo?a=1&a=2&b=x%20y"), { headers: { "x-test": "hi" } });
        assert.deepEqual(await r.json(), { query: { a: ["1", "2"], b: "x y" }, ua: "hi" });
      });
      await t.test("404 and 405 are problems; HEAD has the length and no body", async () => {
        assert.equal((await fetch(at("/nowhere"))).status, 404);
        const wrong = await fetch(at("/teas/1"), { method: "DELETE" });
        assert.equal(wrong.status, 405);
        assert.match(wrong.headers.get("allow") ?? "", /GET/);
        const head = await fetch(at("/teas/1"), { method: "HEAD" });
        assert.equal(head.status, 200);
        assert.ok(Number(head.headers.get("content-length")) > 0);
        assert.equal(await head.text(), "");
      });
      await t.test("the body limit holds, declared or streamed", async () => {
        const big = await fetch(at("/teas"), { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(5000) });
        assert.equal(big.status, 413);
        const chunks = new ReadableStream({
          start(c) {
            for (let i = 0; i < 30; i++) c.enqueue(new TextEncoder().encode("y".repeat(100)));
            c.close();
          },
        });
        const streamed = await fetch(at("/teas"), { method: "POST", headers: { "content-type": "application/json" }, body: chunks, duplex: "half" } as RequestInit);
        assert.equal(streamed.status, 413);
      });
      await t.test("an endless event stream arrives piece by piece and stops when the client leaves", async () => {
        const ac = new AbortController();
        const r = await fetch(at("/ticks"), { signal: ac.signal });
        assert.equal(r.headers.get("content-type"), "text/event-stream; charset=utf-8");
        const reader = r.body!.getReader();
        let text = "";
        while (!text.includes("data: 2")) text += new TextDecoder().decode((await reader.read()).value);
        ac.abort();
        assert.match(text, /event: tick\ndata: 0/);
      });
    } finally {
      await server.close();
    }
    assert.deepEqual(events, ["listen", "close"], "onListen and onClose run");
  });
}

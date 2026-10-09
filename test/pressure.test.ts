import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { inkan, t, type App } from "../src/index.ts";

const quiet = { log: false, gracefulShutdown: false } as const;

test("pressure: an injected check turns requests away with a 503 and retry-after; exempt paths and inkan's pages still answer", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let busy = false;
    const app: App = inkan({ ...quiet, pressure: { check: () => busy, retryAfter: 7, exempt: ["/health"] } })
      .get("/hello", {}, () => "hi")
      .get("/health", {}, () => app.pressure());
    assert.equal((await app.inject({ url: "/hello" })).status, 200);

    busy = true;
    assert.equal((await app.inject({ url: "/hello" })).status, 200, "nothing changes before the next sample");
    mock.timers.tick(1000);
    const res = await app.inject({ url: "/hello" });
    assert.equal(res.status, 503);
    assert.equal(res.headers["retry-after"], "7");
    assert.equal(res.headers["content-type"], "application/problem+json");
    assert.equal(res.body.type, "under-pressure");
    assert.equal((await app.inject({ url: "/nowhere" })).status, 503, "an unknown path too: nothing is routed");

    const health = await app.inject({ url: "/health" });
    assert.equal(health.status, 200);
    assert.equal(health.body.under, true);
    assert.equal(health.body.reason, "check");
    assert.equal((await app.inject({ url: "/docs" })).status, 200);
    assert.equal((await app.inject({ url: "/openapi.json" })).status, 200);

    busy = false;
    mock.timers.tick(1000);
    assert.equal((await app.inject({ url: "/hello" })).status, 200);
    assert.equal(app.pressure()!.under, false);
    await app.stopped();
  } finally {
    mock.timers.reset();
  }
});

test("pressure: samples of the event loop, the heap (bytes or a share) and rss", () => {
  const app = inkan({ ...quiet, pressure: { eventLoopDelay: 100, heapUsed: "90%", rss: 5000 } });
  const gauge = app._gauge!;
  const sample = { eventLoopDelay: 10, heapUsed: 100, heapLimit: 1000, rss: 1000 };
  gauge.measure = () => sample;
  const reason = () => (gauge.tick(), app.pressure()!.reason);

  assert.equal(reason(), undefined);
  assert.equal(gauge.under, false);
  sample.eventLoopDelay = 250;
  assert.equal(reason(), "eventLoopDelay");
  assert.equal(app.pressure()!.eventLoopDelay, 250);
  sample.eventLoopDelay = 10;
  sample.heapUsed = 901;
  assert.equal(reason(), "heapUsed");
  sample.heapUsed = 899;
  sample.rss = 6000;
  assert.equal(reason(), "rss");
  sample.rss = 10;
  assert.equal(reason(), undefined);

  const bytes = inkan({ ...quiet, pressure: { heapUsed: 500 } });
  bytes._gauge!.measure = () => ({ ...sample, heapUsed: 501 });
  bytes._gauge!.tick();
  assert.equal(bytes.pressure()!.reason, "heapUsed");
  app._gauge!.stop();
  bytes._gauge!.stop();
});

test("pressure: over HTTP the 503 goes out before the body is read; app.fetch does the same", async () => {
  let ran = 0;
  const app = inkan({ ...quiet, pressure: { check: () => true } }).post("/items", { body: t.object({ name: t.string() }) }, () => (ran++, "ok"));
  app._gauge!.tick();
  const server = createServer(app.listener);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "10");
    assert.equal(((await res.json()) as { type: string }).type, "under-pressure");

    const web = await app.fetch(new Request("http://x/items", { method: "POST", body: "{}" }));
    assert.equal(web.status, 503);
    assert.equal(ran, 0);
  } finally {
    server.close();
    app._gauge!.stop();
  }
});

test("pressure: off by default, with no sampler and no sample", () => {
  const app = inkan(quiet);
  assert.equal(app._gauge, undefined);
  assert.equal(app.pressure(), undefined);
});

test("pressure: a check that throws counts as no pressure", () => {
  const error = mock.method(console, "error", () => {});
  try {
    const app = inkan({ ...quiet, pressure: { check: () => { throw new Error("boom"); } } });
    app._gauge!.tick();
    app._gauge!.tick();
    assert.equal(app.pressure()!.under, false);
    assert.equal(error.mock.callCount(), 1, "said once");
    app._gauge!.stop();
  } finally {
    error.mock.restore();
  }
});

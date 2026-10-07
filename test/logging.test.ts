import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, problem, type RequestLog } from "../src/index.ts";

const quiet = { log: false, gracefulShutdown: false } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("every answer carries a request id, fresh or passed on", async () => {
  const app = inkan(quiet).get("/x", ({ id }) => ({ id }));
  const fresh = await app.inject({ url: "/x" });
  assert.match(fresh.headers["x-request-id"], UUID);
  assert.equal(fresh.body.id, fresh.headers["x-request-id"], "the handler sees the same id");

  const passed = await app.inject({ url: "/x", headers: { "x-request-id": "edge-42.a:b" } });
  assert.equal(passed.headers["x-request-id"], "edge-42.a:b");
});

test("an id that could smuggle into logs is replaced", async () => {
  const app = inkan(quiet).get("/x", () => "ok");
  for (const bad of ["two words", "line\nbreak", "x".repeat(200), "<script>"]) {
    const res = await app.inject({ url: "/x", headers: { "x-request-id": bad } });
    assert.match(res.headers["x-request-id"], UUID, JSON.stringify(bad));
  }
});

test("problem documents name the request id", async () => {
  const app = inkan(quiet).get("/gone", () => {
    throw problem(410, "gone");
  });
  const res = await app.inject({ url: "/gone", headers: { "x-request-id": "abc-1" } });
  assert.equal(res.body.requestId, "abc-1");
  const missing = await app.inject({ url: "/nowhere" });
  assert.equal(missing.body.requestId, missing.headers["x-request-id"], "built-in problems too");
});

test("the header name can change, or the id can be switched off", async () => {
  const custom = inkan({ ...quiet, requestId: "X-Correlation-Id" }).get("/x", () => "ok");
  const res = await custom.inject({ url: "/x", headers: { "x-correlation-id": "c-7" } });
  assert.equal(res.headers["x-correlation-id"], "c-7");
  assert.equal(res.headers["x-request-id"], undefined);

  const off = inkan({ ...quiet, requestId: false }).get("/x", () => {
    throw problem(418, "teapot");
  });
  const r = await off.inject({ url: "/x" });
  assert.equal(r.headers["x-request-id"], undefined);
  assert.equal(r.body.requestId, undefined);
});

test("log: 'json' writes one JSON line per request", async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (line: string) => void lines.push(line);
  try {
    const app = inkan({ log: "json", gracefulShutdown: false }).get("/teas/:id", () => ({}));
    await app.inject({ url: "/teas/7?full=1", headers: { "x-request-id": "r-1" } });
  } finally {
    console.log = orig;
  }
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.id, "r-1");
  assert.equal(entry.method, "GET");
  assert.equal(entry.path, "/teas/7?full=1");
  assert.equal(entry.route, "/teas/:id");
  assert.equal(entry.status, 200);
  assert.ok(typeof entry.ms === "number" && !Number.isNaN(Date.parse(entry.time)));
});

test("production logs JSON by default, development the short line", () => {
  assert.equal(inkan({ dev: false }).options.log, "json");
  assert.equal(inkan({ dev: true }).options.log, "pretty");
});

test("a logger takes every entry instead of the console", async () => {
  const seen: RequestLog[] = [];
  const orig = console.log;
  let printed = 0;
  console.log = () => void printed++;
  try {
    const app = inkan({ logger: (e) => seen.push(e), gracefulShutdown: false }).post("/x", () => {});
    await app.inject({ method: "POST", url: "/x" });
  } finally {
    console.log = orig;
  }
  assert.equal(printed, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, 204);
  assert.match(seen[0].id!, UUID);
});

test("the inspector keeps the request id", async () => {
  const app = inkan(quiet).get("/x", () => "ok");
  await app.inject({ url: "/x", headers: { "x-request-id": "find-me" } });
  const [entry] = (await app.inject({ url: "/_inkan/log.json" })).body;
  assert.equal(entry.requestId, "find-me");
});

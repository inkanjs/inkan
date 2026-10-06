import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, problem, reply, routes, t } from "../src/index.ts";
import { Router } from "../src/router.ts";

const quiet = { log: false, gracefulShutdown: false } as const;

test("router: statics beat params, params beat wildcards, 405 lists what is allowed", () => {
  const r = new Router<string>();
  r.add("GET", "/users/:id", "user");
  r.add("GET", "/users/me", "me");
  r.add("GET", "/files/*path", "file");
  r.add("POST", "/users/:id", "update");
  assert.deepEqual(r.match("GET", "/users/me"), { kind: "found", route: "me", params: {} });
  assert.deepEqual(r.match("GET", "/users/7"), { kind: "found", route: "user", params: { id: "7" } });
  assert.deepEqual(r.match("GET", "/files/a/b.txt"), { kind: "found", route: "file", params: { path: "a/b.txt" } });
  assert.deepEqual(r.match("HEAD", "/users/7"), { kind: "found", route: "user", params: { id: "7" } });
  assert.deepEqual(r.match("DELETE", "/users/7"), { kind: "method", allow: ["GET", "POST", "HEAD"] });
  assert.deepEqual(r.match("GET", "/nope"), { kind: "none" });
  assert.throws(() => r.add("GET", "/users/me", "again"), /defined twice/);
});

test("params and query arrive typed and coerced", async () => {
  const app = inkan(quiet).get(
    "/items/:id",
    { params: t.object({ id: t.int() }), query: t.object({ full: t.boolean().default(false) }) },
    ({ params, query }) => ({ id: params.id, double: params.id * 2, full: query.full }),
  );
  const res = await app.inject({ url: "/items/21?full=true" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: 21, double: 42, full: true });
});

test("bad input is one 400 problem that lists every issue", async () => {
  const app = inkan(quiet).post(
    "/users/:id",
    { params: t.object({ id: t.int() }), body: t.object({ name: t.string().min(2), age: t.int() }) },
    () => ({ ok: true }),
  );
  const res = await app.inject({ method: "POST", url: "/users/x", body: { name: "a" } });
  assert.equal(res.status, 400);
  assert.equal(res.headers["content-type"], "application/problem+json");
  assert.equal(res.body.type, "validation");
  assert.equal(res.body.instance, "/users/x");
  assert.deepEqual(
    res.body.errors.map((e: { in: string; path: string }) => `${e.in}:${e.path}`),
    ["params:id", "body:name", "body:age"],
  );
});

test("broken JSON and wrong media types get their own problems", async () => {
  const app = inkan(quiet).post("/x", { body: t.object({ a: t.int() }) }, () => ({}));
  const broken = await app.inject({ method: "POST", url: "/x", body: "{nope", headers: { "content-type": "application/json" } });
  assert.equal(broken.body.type, "invalid-json");
  const text = await app.inject({ method: "POST", url: "/x", body: "hi", headers: { "content-type": "text/plain" } });
  assert.equal(text.status, 415);
  const form = await app.inject({ method: "POST", url: "/x", body: "a=5", headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(form.status, 200, "form bodies are coerced like a query");
});

test("404 and 405 are problems too", async () => {
  const app = inkan(quiet).get("/only-get", () => "hi");
  const missing = await app.inject({ url: "/nowhere" });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.type, "not-found");
  const wrong = await app.inject({ method: "PUT", url: "/only-get" });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.allow, "GET, HEAD, OPTIONS");
});

test("problem() and thrown errors", async () => {
  const app = inkan({ ...quiet, onError: () => {} })
    .get("/teapot", () => {
      throw problem(418, "teapot", "I am a teapot", { brewing: "sencha" });
    })
    .get("/boom", () => {
      throw new Error("database on fire");
    });
  const tea = await app.inject({ url: "/teapot" });
  assert.deepEqual(tea.body, { type: "teapot", title: "I'm a Teapot", status: 418, detail: "I am a teapot", brewing: "sencha", instance: "/teapot" });
  const boom = await app.inject({ url: "/boom" });
  assert.equal(boom.status, 500);
  assert.equal(boom.body.detail, "database on fire", "dev mode shows the message");
  const prod = inkan({ ...quiet, dev: false, onError: () => {} }).get("/boom", () => {
    throw new Error("database on fire");
  });
  assert.equal((await prod.inject({ url: "/boom" })).body.detail, "Something went wrong on our side");
});

test("a response that breaks its contract becomes a 500 in development", async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    const app = inkan(quiet).get("/me", { response: { 200: t.object({ name: t.string() }) } }, () => ({ name: 5 }) as never);
    const res = await app.inject({ url: "/me" });
    assert.equal(res.status, 500);
    assert.equal(res.body.type, "response-contract");
  } finally {
    console.error = origError;
  }
});

test("keys the contract does not list never leave the server", async () => {
  const app = inkan(quiet).get("/me", { response: { 200: t.object({ name: t.string() }) } }, () => {
    const row = { name: "Mio", passwordHash: "$2b$..." };
    return row;
  });
  assert.deepEqual((await app.inject({ url: "/me" })).body, { name: "Mio" });
});

test("default statuses, reply() and ctx.reply()", async () => {
  const app = inkan(quiet)
    .post("/a", { response: { 201: t.object({ id: t.int() }) } }, () => ({ id: 1 }))
    .post("/b", () => {})
    .post("/c", { response: { 202: t.object({ queued: t.boolean() }) } }, ({ reply }) => reply(202, { queued: true }, { "Retry-After": "5" }))
    .get("/d", () => reply(301, undefined, { location: "/a" }))
    .get("/e", ({ status }) => {
      status(418);
      return "short and stout";
    });
  assert.equal((await app.inject({ method: "POST", url: "/a" })).status, 201);
  assert.equal((await app.inject({ method: "POST", url: "/b" })).status, 204);
  const c = await app.inject({ method: "POST", url: "/c" });
  assert.equal(c.status, 202);
  assert.equal(c.headers["retry-after"], "5");
  assert.equal((await app.inject({ url: "/d" })).headers.location, "/a");
  const e = await app.inject({ url: "/e" });
  assert.equal(e.status, 418);
  assert.equal(e.headers["content-type"], "text/plain; charset=utf-8");
});

test("middleware runs in order, around the handler, and can stop early", async () => {
  const seen: string[] = [];
  const app = inkan(quiet)
    .use(async (ctx, next) => {
      seen.push("outer in");
      await next();
      seen.push("outer out");
      ctx.header("x-took", "fast");
    })
    .use(async (ctx, next) => {
      if (ctx.headers["x-block"]) throw problem(401, "unauthorized");
      ctx.state.user = "mio";
      await next();
    })
    .get("/me", ({ state }) => {
      seen.push("handler");
      return { user: state.user };
    });
  const res = await app.inject({ url: "/me" });
  assert.deepEqual(res.body, { user: "mio" });
  assert.equal(res.headers["x-took"], "fast");
  assert.deepEqual(seen, ["outer in", "handler", "outer out"]);
  assert.equal((await app.inject({ url: "/me", headers: { "x-block": "1" } })).status, 401);
});

test("groups mount under a prefix and bring their middleware", async () => {
  const admin = routes()
    .use(async (ctx, next) => {
      ctx.state.admin = true;
      await next();
    })
    .get("/stats", ({ state }) => ({ admin: state.admin }));
  const app = inkan(quiet).mount("/admin", admin).get("/open", ({ state }) => ({ admin: state.admin ?? false }));
  assert.deepEqual((await app.inject({ url: "/admin/stats" })).body, { admin: true });
  assert.deepEqual((await app.inject({ url: "/open" })).body, { admin: false });
});

test("HEAD answers like GET without a body", async () => {
  const app = inkan(quiet).get("/x", () => ({ a: 1 }));
  const res = await app.inject({ method: "HEAD", url: "/x" });
  assert.equal(res.status, 200);
  assert.equal(res.text, "");
});

test("docs, openapi and the inspector are served by the app", async () => {
  const app = inkan(quiet).get("/x", () => ({}));
  assert.match((await app.inject({ url: "/docs" })).text, /<!doctype html>/);
  assert.equal((await app.inject({ url: "/openapi.json" })).body.openapi, "3.1.0");
  await app.inject({ url: "/x" });
  const log = await app.inject({ url: "/_inkan/log.json" });
  assert.equal(log.body.length, 1);
  assert.equal(log.body[0].path, "/x");
  const prod = inkan({ ...quiet, dev: false });
  assert.equal((await prod.inject({ url: "/_inkan" })).status, 404, "no inspector in production");
});

test("the inspector hides secret headers", async () => {
  const app = inkan(quiet).get("/x", () => ({}));
  await app.inject({ url: "/x", headers: { authorization: "Bearer secret", cookie: "sid=1", "x-visible": "yes" } });
  const [entry] = (await app.inject({ url: "/_inkan/log.json" })).body;
  assert.equal(entry.request.headers.authorization, "•••");
  assert.equal(entry.request.headers.cookie, "•••");
  assert.equal(entry.request.headers["x-visible"], "yes");
});

test("a real socket: listen, body limit, loopback inspector", async () => {
  const app = inkan({ ...quiet, bodyLimit: 16 }).post("/echo", { body: t.object({ a: t.string() }) }, ({ body }) => body);
  const server = await app.listen(0, "127.0.0.1");
  const { port } = server.address() as { port: number };
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":"hi"}' });
    assert.deepEqual(await ok.json(), { a: "hi" });
    const big = await fetch(`http://127.0.0.1:${port}/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: "x".repeat(100) }) });
    assert.equal(big.status, 413);
    const inspector = await fetch(`http://127.0.0.1:${port}/_inkan/log.json`);
    assert.equal(inspector.status, 200, "loopback may see the inspector");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpProblem, inkan, plugin, problem, rateLimit, t, type Outgoing } from "../src/index.ts";

const quiet = { log: false as const };

test("hooks run in request order, and preHandler sees the checked input", async () => {
  const seen: string[] = [];
  const app = inkan(quiet)
    .onRequest((ctx) => void seen.push(`onRequest ${ctx.route?.path}`))
    .preHandler((ctx) => void seen.push(`preHandler grams=${typeof (ctx.body as { grams: unknown }).grams}`))
    .onSend((_ctx, a) => void seen.push(`onSend ${a.status}`))
    .onResponse((_ctx, done) => void seen.push(`onResponse ${done.status} ${typeof done.ms}`))
    .post("/teas", { body: t.object({ grams: t.int() }) }, () => {
      seen.push("handler");
      return { ok: true };
    });
  const r = await app.inject({ method: "POST", url: "/teas", body: { grams: 5 } });
  assert.equal(r.status, 200);
  assert.deepEqual(seen, ["onRequest /teas", "preHandler grams=number", "handler", "onSend 200", "onResponse 200 number"]);
});

test("onRequest runs before the body is checked, and a value it returns is the answer", async () => {
  let handled = false;
  const app = inkan(quiet)
    .onRequest((ctx) => ((ctx.headers as Record<string, string>)["x-cached"] ? { from: "cache" } : undefined))
    .post("/teas", { body: t.object({ grams: t.int() }) }, () => ((handled = true), { from: "handler" }));
  const cached = await app.inject({ method: "POST", url: "/teas", headers: { "x-cached": "1" }, body: { grams: "not even a number" } });
  assert.deepEqual(cached.body, { from: "cache" });
  assert.equal(handled, false);
  const plain = await app.inject({ method: "POST", url: "/teas", body: { grams: 1 } });
  assert.deepEqual(plain.body, { from: "handler" });
});

test("a problem thrown in a hook is a problem like any other: onProblem and onSend see it", async () => {
  const app = inkan(quiet)
    .onRequest((ctx) => {
      if (!(ctx.headers as Record<string, string>).authorization) throw problem(401, "unauthorized", "Who is asking?");
    })
    .onProblem((_ctx, p) => {
      p.extra.help = "https://example.test/docs/errors#" + p.type;
    })
    .onSend((_ctx, a) => {
      a.headers["x-seen"] = "yes";
    })
    .get("/me", () => ({ me: true }));
  const r = await app.inject({ url: "/me" });
  assert.equal(r.status, 401);
  assert.equal(r.body.type, "unauthorized");
  assert.equal(r.body.help, "https://example.test/docs/errors#unauthorized");
  assert.equal(r.headers["x-seen"], "yes");
  assert.equal(r.headers["content-type"], "application/problem+json");
});

test("onProblem may hand back another problem, and sees 404s and errors that were never problems", async () => {
  const errors: unknown[] = [];
  const app = inkan({ ...quiet, onError: (e) => void errors.push(e) })
    .onProblem((_ctx, p) => (p.status === 404 ? new HttpProblem(404, "nothing-here", "Try /teas") : undefined))
    .get("/boom", () => {
      throw new Error("a bug");
    });
  const nf = await app.inject({ url: "/nowhere" });
  assert.equal(nf.body.type, "nothing-here");
  const boom = await app.inject({ url: "/boom" });
  assert.equal(boom.status, 500);
  assert.equal(errors.length, 1, "a real error is still reported once");
});

test("onSend may replace the answer, an envelope for example", async () => {
  const app = inkan(quiet)
    .onSend((_ctx, a): Outgoing | void => {
      if (!a.headers["content-type"]?.startsWith("application/json")) return;
      return { ...a, body: `{"data":${a.body}}` };
    })
    .get("/tea", { response: { 200: t.object({ name: t.string() }) } }, () => ({ name: "Sencha" }));
  const r = await app.inject({ url: "/tea" });
  assert.deepEqual(r.body, { data: { name: "Sencha" } });
});

test("a hook that breaks after the answer is written is reported, not thrown", async () => {
  const errors: unknown[] = [];
  const app = inkan({ ...quiet, onError: (e) => void errors.push(e) })
    .onResponse(() => {
      throw new Error("metrics are down");
    })
    .get("/x", () => ({ ok: 1 }));
  const r = await app.inject({ url: "/x" });
  assert.equal(r.status, 200);
  assert.equal(errors.length, 1);
});

test("a plugin's hooks and decorations stay inside it; the app's reach into every plugin", async () => {
  const seen: string[] = [];
  const admin = plugin((app) => {
    app.decorate("role", "admin");
    app.onRequest((ctx) => void seen.push(`admin hook on ${ctx.path}`));
    app.get("/stats", (ctx) => ({ role: (ctx as unknown as { role: string }).role, db: (ctx as unknown as { db: string }).db }));
  });
  const app = inkan(quiet)
    .decorate("db", "the pool")
    .onRequest((ctx) => void seen.push(`app hook on ${ctx.path}`))
    .register(admin, { prefix: "/admin" })
    .get("/public", (ctx) => ({ role: (ctx as unknown as { role?: string }).role ?? "none" }));
  await app.ready();

  assert.deepEqual((await app.inject({ url: "/admin/stats" })).body, { role: "admin", db: "the pool" });
  assert.deepEqual((await app.inject({ url: "/public" })).body, { role: "none" });
  assert.deepEqual(seen, ["app hook on /admin/stats", "admin hook on /admin/stats", "app hook on /public"]);
  assert.ok(app.routes().some((r) => r.path === "/admin/stats"), "a plugin's routes are routes like any other");
  assert.ok((app.openapi().paths as Record<string, unknown>)["/admin/stats"]);
});

test("a shared plugin adds to the scope it is registered in", async () => {
  const stamp = plugin((app) => void app.onSend((_ctx, a) => void (a.headers["x-stamp"] = "1")), { shared: true });
  const app = inkan(quiet).register(stamp).get("/a", () => ({ a: 1 }));
  await app.ready();
  assert.equal((await app.inject({ url: "/a" })).headers["x-stamp"], "1");
});

test("decorate refuses names the context has, and names given twice", () => {
  const app = inkan(quiet).decorate("db", 1);
  assert.throws(() => app.decorate("db", 2), /already has a db/);
  assert.throws(() => inkan(quiet).decorate("params", 1), /already has a params/);
  assert.throws(() => inkan(quiet).decorate("reply", 1), /already has a reply/);
});

test("decorations are typed on the handler's context", async () => {
  const app = inkan(quiet)
    .decorate("db", { find: (id: number) => ({ id, name: "Sencha" }) })
    .get("/teas/:id", { params: t.object({ id: t.int() }) }, (ctx) => ctx.db.find(ctx.params.id));
  assert.deepEqual((await app.inject({ url: "/teas/7" })).body, { id: 7, name: "Sencha" });
  // @ts-expect-error a decoration that was never made is not on the context
  inkan(quiet).get("/x", (ctx) => ctx.db);
});

test("plugins load in order, ready() waits for them, and one that fails stops listen()", async () => {
  const order: string[] = [];
  const slow = plugin(async (app) => {
    await new Promise((r) => setTimeout(r, 10));
    order.push("slow");
    app.get("/slow", () => ({ ok: 1 }));
  });
  const fast = plugin((app) => {
    order.push("fast");
    app.get("/fast", () => ({ ok: 1 }));
  });
  const app = inkan(quiet).register(slow).register(fast);
  assert.equal((await app.inject({ url: "/fast" })).status, 200, "inject waits for the plugins");
  assert.deepEqual(order, ["slow", "fast"]);

  const broken = inkan({ ...quiet, gracefulShutdown: false }).register(async () => {
    throw new Error("no database");
  });
  await assert.rejects(broken.ready(), /no database/);
  await assert.rejects(broken.listen(0), /no database/);
});

test("rateLimit: the request after max gets a 429 with retry-after", async () => {
  const app = inkan(quiet)
    .register(rateLimit({ max: 2, window: 60_000 }))
    .get("/tea", () => ({ ok: 1 }));
  const a = await app.inject({ url: "/tea" });
  assert.equal(a.headers["x-ratelimit-remaining"], "1");
  assert.equal((await app.inject({ url: "/tea" })).status, 200);
  const third = await app.inject({ url: "/tea" });
  assert.equal(third.status, 429);
  assert.equal(third.body.type, "rate-limited");
  assert.ok(Number(third.headers["retry-after"]) > 0);
});

test("rateLimit inside a plugin limits only that plugin's routes", async () => {
  const api = plugin((app) => {
    app.register(rateLimit({ max: 1 }));
    app.get("/limited", () => ({ ok: 1 }));
  });
  const app = inkan(quiet).register(api).get("/free", () => ({ ok: 1 }));
  await app.ready();
  await app.inject({ url: "/limited" });
  assert.equal((await app.inject({ url: "/limited" })).status, 429);
  for (let i = 0; i < 3; i++) assert.equal((await app.inject({ url: "/free" })).status, 200);
});

test("an app with no hooks keeps the plain path, and a hook added later still applies", async () => {
  const app = inkan(quiet).get("/x", () => ({ ok: 1 }));
  assert.equal((await app.inject({ url: "/x" })).headers["x-late"], undefined);
  app.onSend((_ctx, a) => void (a.headers["x-late"] = "1"));
  assert.equal((await app.inject({ url: "/x" })).headers["x-late"], "1");
});

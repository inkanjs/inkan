import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compress, inkan, parseCookies, plugin, rateLimit, serializeCookie, t, type Plugin } from "../src/index.ts";

// what a plugin would write to name the meta it reads
declare module "../src/index.ts" {
  interface RouteMeta {
    auth?: { roles: string[] };
  }
}

const quiet = { log: false as const };

// ---------- per-request decorations ----------

test("decorateRequest: made on first read, once per request, and never for a request that does not ask", async () => {
  let made = 0;
  const app = inkan(quiet)
    .decorateRequest("user", (ctx) => ({ n: ++made, name: (ctx.headers as Record<string, string>)["x-user"] ?? "anon" }))
    .get("/me", (ctx) => ({ name: ctx.user.name, again: ctx.user.n === ctx.user.n, n: ctx.user.n }))
    .get("/free", () => ({ ok: 1 }));
  assert.deepEqual((await app.inject({ url: "/me", headers: { "x-user": "ada" } })).body, { name: "ada", again: true, n: 1 });
  assert.deepEqual((await app.inject({ url: "/me" })).body, { name: "anon", again: true, n: 2 }, "a fresh value for every request");
  await app.inject({ url: "/free" });
  assert.equal(made, 2, "a request that never reads it never makes it");
});

test("decorateRequest: hooks see it too, a set value wins, and it can use other decorations", async () => {
  const app = inkan(quiet)
    .decorate("prefix", "user:")
    .decorateRequest("who", (ctx) => ctx.prefix + (ctx.cookies.sid ?? "none"))
    .onRequest((ctx) => {
      if (ctx.query && (ctx.query as Record<string, string>).as) ctx.who = "forced";
    })
    .onSend((ctx, a) => void (a.headers["x-who"] = ctx.who))
    .get("/who", (ctx) => ({ who: ctx.who }));
  const r = await app.inject({ url: "/who", headers: { cookie: "sid=42" } });
  assert.deepEqual(r.body, { who: "user:42" });
  assert.equal(r.headers["x-who"], "user:42");
  assert.deepEqual((await app.inject({ url: "/who?as=1" })).body, { who: "forced" });
});

test("decorateRequest stays inside its plugin, and refuses names the context has", async () => {
  const inner = plugin((app) => {
    app.decorateRequest("tenant", () => "acme");
    app.get("/inside", (ctx) => ({ tenant: (ctx as unknown as { tenant: string }).tenant }));
  });
  const app = inkan(quiet)
    .register(inner)
    .get("/outside", (ctx) => ({ tenant: (ctx as unknown as { tenant?: string }).tenant ?? "none" }));
  assert.deepEqual((await app.inject({ url: "/inside" })).body, { tenant: "acme" });
  assert.deepEqual((await app.inject({ url: "/outside" })).body, { tenant: "none" });

  assert.throws(() => inkan(quiet).decorateRequest("ip", () => 1), /already has a ip/);
  assert.throws(() => inkan(quiet).decorate("db", 1).decorateRequest("db", () => 2), /already has a db/);
  assert.throws(() => inkan(quiet).decorateRequest("db", () => 2).decorate("db", 1), /already has a db/);
});

// ---------- types out of shared plugins ----------

type User = { id: number; roles: string[] };

test("a shared plugin's decorations are typed on the routes after register()", async () => {
  const auth = plugin(
    (app, o: { header: string }) =>
      app.decorate("realm", "tea").decorateRequest("user", (ctx): User | undefined => {
        const id = (ctx.headers as Record<string, string | undefined>)[o.header];
        return id ? { id: Number(id), roles: ["admin"] } : undefined;
      }),
    { shared: true, name: "auth" },
  );
  const app = inkan(quiet)
    .register(auth, { header: "x-user" })
    .get("/me", (ctx) => ({ id: ctx.user?.id ?? 0, realm: ctx.realm.toUpperCase() }));
  assert.deepEqual((await app.inject({ url: "/me", headers: { "x-user": "7" } })).body, { id: 7, realm: "TEA" });

  // @ts-expect-error the options are checked
  inkan(quiet).register(auth, { header: 1 });
  // @ts-expect-error user is a User or undefined, never a string
  inkan(quiet).register(auth, { header: "x" }).get("/x", (ctx) => ctx.user.toUpperCase());

  // a plugin with a scope of its own keeps its decorations to itself, in the types too
  const own = plugin((app) => app.decorate("secret", 1));
  // @ts-expect-error not shared: nothing on the context outside it
  inkan(quiet).register(own).get("/x", (ctx) => ctx.secret);
});

test("an async shared plugin hands its types on too, and a typed Plugin can say what it adds", async () => {
  const db = plugin(
    async (app) => {
      await new Promise((r) => setTimeout(r, 5));
      return app.decorate("db", { count: () => 3 });
    },
    { shared: true },
  );
  const declared: Plugin<{}, {}, { clock: () => number }> = plugin((app) => app.decorate("clock", () => 1), { shared: true });
  const app = inkan(quiet)
    .register(db)
    .register(declared)
    .get("/n", (ctx) => ({ n: ctx.db.count() + ctx.clock() }));
  assert.deepEqual((await app.inject({ url: "/n" })).body, { n: 4 });
});

// ---------- route metadata ----------

test("ctx.route carries the route's security and meta, the same object on every request", async () => {
  const seen: unknown[] = [];
  const app = inkan(quiet)
    .onRequest((ctx) => {
      seen.push(ctx.route);
      const roles = ctx.route?.meta.auth?.roles ?? [];
      if (roles.includes("admin") && (ctx.headers as Record<string, string>)["x-role"] !== "admin") return ctx.text("no", 403);
    })
    .get("/open", () => ({ ok: 1 }))
    .get("/admin", { security: "bearer", meta: { auth: { roles: ["admin"] } } }, () => ({ ok: 1 }));
  await app.inject({ url: "/open" });
  await app.inject({ url: "/open" });
  assert.deepEqual(seen[0], { method: "GET", path: "/open", security: [], meta: {} });
  assert.equal(seen[0], seen[1], "one object per route, made once");
  assert.equal((await app.inject({ url: "/admin", headers: { authorization: "Bearer x" } })).status, 403);
  assert.deepEqual(seen[2], { method: "GET", path: "/admin", security: ["bearer"], meta: { auth: { roles: ["admin"] } } });
  assert.equal((await app.inject({ url: "/admin", headers: { authorization: "Bearer x", "x-role": "admin" } })).status, 200);

  // @ts-expect-error roles is a list, as the augmented RouteMeta says
  inkan(quiet).get("/x", { meta: { auth: { roles: "admin" } } }, () => ({}));
});

test("ctx.route.security is the group's, and empty where a route opens itself with false", async () => {
  const seen: Record<string, unknown> = {};
  const app = inkan(quiet)
    .security({ apiKey: "x-key" })
    .onRequest((ctx) => void (seen[ctx.path] = ctx.route?.security))
    .get("/a", () => ({}))
    .get("/b", { security: false }, () => ({}));
  await app.inject({ url: "/a", headers: { "x-key": "k" } });
  await app.inject({ url: "/b" });
  assert.deepEqual(seen, { "/a": [{ apiKey: "x-key" }], "/b": [] });
});

// ---------- OpenAPI from plugins ----------

test("describe(): a plugin adds parameters, answers and scheme details to its routes only", async () => {
  const auth = plugin(
    (app) => {
      app.describe((op, route, components) => {
        if (!route.security?.includes("bearer")) return;
        components.securitySchemes!.bearer!.bearerFormat = "JWT";
        op.responses["403"] ??= { description: "The token does not allow this" };
        (op.parameters ??= []).push({ name: "x-tenant", in: "header", required: false, schema: { type: "string" } });
      });
      app.get("/me", { security: "bearer" }, () => ({}));
      app.get("/ping", () => ({}));
    },
    { name: "auth" },
  );
  const app = inkan(quiet).register(auth).get("/other", { security: "bearer" }, () => ({}));
  await app.ready();
  const doc = app.openapi() as any;
  const me = doc.paths["/me"].get;
  assert.equal(me.responses["403"].description, "The token does not allow this");
  assert.deepEqual(me.parameters, [{ name: "x-tenant", in: "header", required: false, schema: { type: "string" } }]);
  assert.deepEqual(doc.components.securitySchemes.bearer, { type: "http", scheme: "bearer", bearerFormat: "JWT" });
  assert.equal(doc.paths["/ping"].get.responses["403"], undefined);
  assert.equal(doc.paths["/other"].get.responses["403"], undefined, "a route outside the plugin is left alone");
});

test("describe(): outer scopes first, new sections kept, and a hook added late still reaches the document", () => {
  const order: string[] = [];
  const inner = plugin((app) => {
    app.describe(() => void order.push("inner"));
    app.get("/x", () => ({}));
  });
  const app = inkan(quiet).describe(() => void order.push("app")).register(inner);
  const before = app.openapi() as any;
  assert.equal(before.components, undefined);
  assert.deepEqual(order, ["app", "inner"]);

  app.describe((op, _r, components) => {
    (components.responses ??= {}).Forbidden = { description: "Not for you" };
    op.responses["403"] = { $ref: "#/components/responses/Forbidden" };
  });
  const after = app.openapi() as any;
  assert.notEqual(after, before, "the document is written again");
  assert.deepEqual(after.components, { responses: { Forbidden: { description: "Not for you" } } });
  assert.deepEqual(after.paths["/x"].get.responses["403"], { $ref: "#/components/responses/Forbidden" });
});

// ---------- trustProxy ----------

const whoIs = (options: Parameters<typeof inkan>[0]) =>
  inkan({ ...quiet, ...options }).get("/ip", { headers: t.object({}) }, (ctx) => ({ ip: ctx.ip ?? null }));
const ipOf = async (app: ReturnType<typeof whoIs>, headers: Record<string, string>, remote = "10.0.0.2") =>
  ((await (await app.fetch(new Request("http://x/ip", { headers }), { remote })).json()) as { ip: string | null }).ip;

test("trustProxy: off by default, so a forwarded address is not believed", async () => {
  assert.equal(await ipOf(whoIs({}), { "x-forwarded-for": "1.2.3.4" }), "10.0.0.2");
});

test("trustProxy: true, a number of hops, or a function", async () => {
  const xff = { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 10.0.0.1" };
  assert.equal(await ipOf(whoIs({ trustProxy: true }), xff), "1.1.1.1");
  assert.equal(await ipOf(whoIs({ trustProxy: true }), {}), "10.0.0.2", "nothing forwarded: the socket");
  assert.equal(await ipOf(whoIs({ trustProxy: 1 }), xff), "10.0.0.1");
  assert.equal(await ipOf(whoIs({ trustProxy: 2 }), xff), "2.2.2.2");
  assert.equal(await ipOf(whoIs({ trustProxy: 9 }), xff), "1.1.1.1", "more hops than there are: the first address");
  const ours = (ip: string) => ip.startsWith("10.");
  assert.equal(await ipOf(whoIs({ trustProxy: ours }), xff), "2.2.2.2");
  assert.equal(await ipOf(whoIs({ trustProxy: ours }), xff, "8.8.8.8"), "8.8.8.8", "a socket that is not ours is the client");
});

test("trustProxy reads forwarded when there is no x-forwarded-for, and a header schema does not hide either", async () => {
  const app = whoIs({ trustProxy: true });
  assert.equal(await ipOf(app, { forwarded: "for=192.0.2.60;proto=http;by=203.0.113.43" }), "192.0.2.60");
  assert.equal(await ipOf(app, { forwarded: 'for="[2001:db8:cafe::17]:4711", for=10.0.0.1' }), "2001:db8:cafe::17");
  assert.equal(await ipOf(app, { forwarded: 'For="192.0.2.43:47011"' }), "192.0.2.43");
});

test("rateLimit counts by ctx.ip, so behind a trusted proxy it counts each client", async () => {
  const app = inkan({ ...quiet, trustProxy: 1 })
    .register(rateLimit({ max: 1 }))
    .get("/ip", () => ({ ok: 1 }));
  const call = (client: string) => app.fetch(new Request("http://x/ip", { headers: { "x-forwarded-for": client } }), { remote: "10.0.0.1" });
  assert.equal((await call("1.1.1.1")).status, 200);
  assert.equal((await call("2.2.2.2")).status, 200);
  assert.equal((await call("1.1.1.1")).status, 429);
});

// ---------- onSend order ----------

test("an onSend hook added after compress, or in a plugin inside it, still sees the body unpacked", async () => {
  const big = { text: "sencha ".repeat(500) };
  const etag = plugin(
    (app) =>
      void app.onSend((_ctx, out) => {
        if (typeof out.body === "string") out.headers.etag = `"${createHash("sha1").update(out.body).digest("hex")}"`;
      }),
    { shared: true },
  );
  const api = plugin((app) => {
    app.register(etag);
    app.get("/big", () => big);
  });
  const app = inkan(quiet).register(compress()).register(api);
  const r = await app.inject({ url: "/big", headers: { "accept-encoding": "gzip" } });
  assert.equal(r.headers["content-encoding"], "gzip");
  assert.equal(r.headers.etag, `"${createHash("sha1").update(JSON.stringify(big)).digest("hex")}"`);
});

test("onSend { last: true } hooks run after the others, outermost first", async () => {
  const seen: string[] = [];
  const inner = plugin((app) => {
    app.onSend(() => void seen.push("inner last"), { last: true });
    app.onSend(() => void seen.push("inner"));
    app.get("/x", () => ({}));
  });
  const app = inkan(quiet)
    .onSend(() => void seen.push("app last"), { last: true })
    .onSend(() => void seen.push("app"))
    .register(inner);
  await app.inject({ url: "/x" });
  assert.deepEqual(seen, ["app", "inner", "app last", "inner last"]);
});

// ---------- cookie helpers ----------

test("the cookie helpers are exported for plugins", () => {
  const set = serializeCookie("sid", "a b", { secure: true, maxAge: 60 });
  assert.equal(set, "sid=a%20b; Path=/; Max-Age=60; Secure; HttpOnly; SameSite=Lax");
  assert.deepEqual({ ...parseCookies("sid=a%20b; x=1") }, { sid: "a b", x: "1" });
});

// ---------- raw headers, secure, protocol ----------

test("ctx.rawHeaders keeps every header a header schema strips from ctx.headers", async () => {
  const app = inkan(quiet).get("/h", { headers: t.object({ "x-keep": t.string() }) }, (ctx) => ({
    headers: ctx.headers,
    raw: { keep: ctx.rawHeaders["x-keep"], other: ctx.rawHeaders["x-other"] },
  }));
  const r = await app.inject({ url: "/h", headers: { "X-Keep": "1", "x-other": "2" } });
  assert.deepEqual(r.body, { headers: { "x-keep": "1" }, raw: { keep: "1", other: "2" } });
  const hooked = inkan(quiet)
    .onRequest((ctx) => void ctx.header("x-seen", String(ctx.rawHeaders["x-other"])))
    .get("/h", { headers: t.object({}) }, () => ({ ok: 1 }));
  assert.equal((await hooked.inject({ url: "/h", headers: { "x-other": "yes" } })).headers["x-seen"], "yes");
});

const whereFrom = (options: Parameters<typeof inkan>[0] = {}) =>
  inkan({ ...quiet, ...options }).get("/p", { headers: t.object({}) }, (ctx) => ({ secure: ctx.secure, protocol: ctx.protocol, url: ctx.url.origin }));
const protoOf = async (app: ReturnType<typeof whereFrom>, url: string, headers: Record<string, string> = {}, remote = "10.0.0.2") =>
  (await (await app.fetch(new Request(url, { headers }), { remote })).json()) as { secure: boolean; protocol: string; url: string };

test("ctx.secure and ctx.protocol: false over a plain socket, the URL's scheme through fetch", async () => {
  const app = whereFrom();
  const server = await app.listen(0, "127.0.0.1");
  try {
    const { port } = server.address() as { port: number };
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/p`)).json(), { secure: false, protocol: "http", url: `http://127.0.0.1:${port}` });
  } finally {
    server.closeAllConnections();
    server.close();
  }
  assert.deepEqual(await protoOf(app, "https://api.example/p"), { secure: true, protocol: "https", url: "https://localhost" });
  assert.deepEqual(await protoOf(app, "http://api.example/p"), { secure: false, protocol: "http", url: "http://localhost" });
  assert.equal((await app.inject({ url: "/p" })).body.secure, false);
});

test("ctx.secure believes x-forwarded-proto and forwarded proto= only from trusted proxies", async () => {
  const https = { "x-forwarded-proto": "https" };
  assert.equal((await protoOf(whereFrom(), "http://x/p", https)).secure, false, "not without trustProxy");
  assert.equal((await protoOf(whereFrom({ trustProxy: true }), "http://x/p", https)).protocol, "https");
  assert.equal((await protoOf(whereFrom({ trustProxy: true }), "https://x/p", { "x-forwarded-proto": "http" })).secure, false, "the proxy's word over the hop's");
  assert.equal((await protoOf(whereFrom({ trustProxy: true }), "https://x/p")).secure, true, "nothing forwarded: the connection's own");
  assert.equal((await protoOf(whereFrom({ trustProxy: true }), "http://x/p", { forwarded: "for=1.1.1.1;proto=https" })).secure, true);
  const ours = (ip: string) => ip.startsWith("10.");
  assert.equal((await protoOf(whereFrom({ trustProxy: ours }), "http://x/p", https)).secure, true);
  assert.equal((await protoOf(whereFrom({ trustProxy: ours }), "http://x/p", https, "8.8.8.8")).secure, false, "a socket that is not ours");
  // two proxies, each appending the scheme it was reached over: the client came in over https
  const chain = { "x-forwarded-for": "1.1.1.1, 10.0.0.1", "x-forwarded-proto": "https, http" };
  assert.equal((await protoOf(whereFrom({ trustProxy: 2 }), "http://x/p", chain)).secure, true);
  assert.equal((await protoOf(whereFrom({ trustProxy: 1 }), "http://x/p", chain)).secure, false, "one hop: how 10.0.0.1 reached the nearest proxy");
});

test("describe(): ref() lists a schema under components.schemas and refers to it", () => {
  const Conflict = t.object({ key: t.string() });
  const Named = t.object({ n: t.number() }).named("Named");
  const app = inkan(quiet)
    .describe((op, _route, _components, ref) => {
      op.responses["409"] = { description: "Replayed", content: { "application/json": { schema: ref(Conflict, "Conflict") } } };
      op["x-named"] = ref(Named);
      assert.throws(() => ref(Conflict), /Name the schema/);
    })
    .get("/a", () => ({ ok: 1 }))
    .get("/b", () => ({ ok: 1 }));
  const doc = app.openapi() as any;
  assert.deepEqual(doc.paths["/a"].get.responses["409"].content["application/json"].schema, { $ref: "#/components/schemas/Conflict" });
  assert.deepEqual(doc.paths["/b"].get["x-named"], { $ref: "#/components/schemas/Named" });
  assert.deepEqual(doc.components.schemas.Conflict, { type: "object", properties: { key: { type: "string" } }, required: ["key"] });
  assert.deepEqual(Object.keys(doc.components.schemas).sort(), ["Conflict", "Named"]);
});

// ---------- what a plugin can read ----------

test("describe(): the route is ctx.route's view plus its spec, frozen", async () => {
  const AUTH = Symbol("auth");
  const seen: any[] = [];
  const app = inkan(quiet)
    .describe((op, route) => {
      seen.push(route);
      if (route.security.length && route.meta.auth) op["x-roles"] = route.meta.auth.roles;
    })
    .get("/me", { security: "bearer", summary: "Who am I", tags: ["users"], meta: { auth: { roles: ["admin"] }, [AUTH]: true } }, (ctx) => ({ sym: ctx.route?.meta[AUTH] === true }));
  const doc = app.openapi() as any;
  assert.deepEqual(doc.paths["/me"].get["x-roles"], ["admin"]);
  const [r] = seen;
  assert.equal(r.method, "GET");
  assert.equal(r.path, "/me");
  assert.deepEqual(r.security, ["bearer"]);
  assert.equal(r.meta[AUTH], true, "symbol keys are kept");
  assert.equal(r.spec.summary, "Who am I");
  assert.deepEqual(r.spec.tags, ["users"]);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.security));
  assert.equal(r.box, undefined, "internals stay out");
  assert.deepEqual((await app.inject({ url: "/me", headers: { authorization: "Bearer x" } })).body, { sym: true });

  seen.length = 0;
  app.describe(() => {});
  app.openapi();
  assert.deepEqual(seen[0].security, ["bearer"], "the same view after the first request");
});

test("scope.dev and scope.prefix: the app's mode and each scope's prefix, read-only", async () => {
  const got: Record<string, unknown>[] = [];
  const inner = plugin((app) => void got.push({ dev: app.dev, prefix: app.prefix }));
  const outer = plugin((app) => {
    got.push({ dev: app.dev, prefix: app.prefix });
    app.register(inner, { prefix: "/admin" });
  });
  const app = inkan({ ...quiet, dev: false }).register(outer, { prefix: "/v1" }).register(inner);
  await app.ready();
  assert.equal(app.dev, false);
  assert.equal(app.prefix, "");
  assert.deepEqual(got, [
    { dev: false, prefix: "/v1" },
    { dev: false, prefix: "/v1/admin" },
    { dev: false, prefix: "" },
  ]);
  assert.equal(inkan({ ...quiet, dev: true }).dev, true);
  assert.throws(() => ((app as any).prefix = "/x"), TypeError);
});

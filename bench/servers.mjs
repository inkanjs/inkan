// The same routes in every server, doing the same work, so the numbers compare like
// with like. Fastify and inkan check input and shape output with schemas, Elysia checks
// input with its own; Express, Hono, Koa, hapi, h3, NestJS and bare node:http do the same
// checks by hand (see data.mjs).
//
//   GET  /hello                     a fixed JSON answer
//   GET  /users/:id?fields=…        a typed path param and a query
//   POST /users                     a small JSON body, checked; 400 when it is wrong
//   GET  /teas                      a big answer: 100 nested objects
//   POST /teas/bulk                 a big body: 50 objects, each checked
//   GET  /p199/:id/items/:item      a router holding 400 routes
//   GET  /mw                        three middlewares before the handler
//   GET  /async/:id                 a handler that waits one event-loop hop
//   anything else                   404
//
//   node servers.mjs <node|express|fastify|hono|koa|hapi|h3|elysia|nest|inkan|inkan-sealed|
//                     inkan-cluster|inkan-uws|inkan-dev|inkan-base|inkan-noid> <port>
//
// nest is NestJS on its default platform (Express); elysia runs on Node through @elysiajs/node.
//
// inkan-noid is a diagnostic: inkan without request ids (requestId: false), which no other
// server makes. PIN=<mask> (Windows) keeps the server on those logical CPUs, for a noisy machine.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { isBulk, isUser, LIST, ROUTE_COUNT, user } from "./data.mjs";

const [name, port] = process.argv.slice(2);
if (process.env.PIN && process.platform === "win32") {
  const { execFileSync } = await import("node:child_process");
  execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${process.pid}).ProcessorAffinity = ${Number(process.env.PIN)}`]);
}
const ready = () => console.log("ready");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const int = (s) => (/^-?\d+$/.test(s) ? Number(s) : NaN);

if (name === "node") {
  const json = (res, status, body, extra = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...extra });
    res.end(text);
  };
  const readJson = (req) =>
    new Promise((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(b));
        } catch {
          resolve(undefined);
        }
      });
    });
  const routeRe = /^\/p(\d+)\/(-?\d+)\/items\/(-?\d+)$/;
  http
    .createServer(async (req, res) => {
      const q = req.url.indexOf("?");
      const path = q < 0 ? req.url : req.url.slice(0, q);
      if (req.method === "GET") {
        if (path === "/hello") return json(res, 200, { hello: "world" });
        if (path === "/teas") return json(res, 200, LIST);
        if (path === "/mw") return json(res, 200, { n: 3 }, { "x-a": "1", "x-b": "1", "x-c": "1" });
        let m = /^\/users\/([^/]+)$/.exec(path);
        if (m) {
          const id = int(m[1]);
          if (Number.isNaN(id)) return json(res, 400, { error: "id" });
          return json(res, 200, user(id, q < 0 ? undefined : new URLSearchParams(req.url.slice(q + 1)).get("fields") ?? undefined));
        }
        m = /^\/async\/([^/]+)$/.exec(path);
        if (m) {
          await tick();
          return json(res, 200, { id: int(m[1]) });
        }
        m = routeRe.exec(path);
        if (m && Number(m[1]) < ROUTE_COUNT) return json(res, 200, { id: Number(m[2]), item: Number(m[3]) });
      }
      if (req.method === "POST" && path === "/users") {
        const body = await readJson(req);
        return isUser(body) ? json(res, 201, { id: 1, name: body.name, age: body.age }) : json(res, 400, { error: "body" });
      }
      if (req.method === "POST" && path === "/teas/bulk") {
        const body = await readJson(req);
        return isBulk(body) ? json(res, 201, { count: body.items.length }) : json(res, 400, { error: "body" });
      }
      json(res, 404, { error: "not found" });
    })
    .listen(port, "127.0.0.1", ready);
}

if (name === "express") {
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const stamp = (h) => (req, res, next) => {
    res.set(`x-${h}`, "1");
    req.n = (req.n ?? 0) + 1;
    next();
  };
  app.get("/hello", (req, res) => res.json({ hello: "world" }));
  app.get("/users/:id", (req, res) => {
    const id = int(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "id" });
    res.json(user(id, req.query.fields));
  });
  app.post("/users", (req, res) => (isUser(req.body) ? res.status(201).json({ id: 1, name: req.body.name, age: req.body.age }) : res.status(400).json({ error: "body" })));
  app.get("/teas", (req, res) => res.json(LIST));
  app.post("/teas/bulk", (req, res) => (isBulk(req.body) ? res.status(201).json({ count: req.body.items.length }) : res.status(400).json({ error: "body" })));
  app.get("/mw", stamp("a"), stamp("b"), stamp("c"), (req, res) => res.json({ n: req.n }));
  app.get("/async/:id", async (req, res) => {
    await tick();
    res.json({ id: int(req.params.id) });
  });
  for (let i = 0; i < ROUTE_COUNT; i++) {
    app.get(`/static/s${i}`, (req, res) => res.json({ i }));
    app.get(`/p${i}/:id/items/:item`, (req, res) => res.json({ id: int(req.params.id), item: int(req.params.item) }));
  }
  app.use((req, res) => res.status(404).json({ error: "not found" }));
  app.listen(Number(port), "127.0.0.1", ready);
}

if (name === "hono") {
  const { Hono } = await import("hono");
  const { serve } = await import("@hono/node-server");
  const app = new Hono();
  const stamp = (h) => async (c, next) => {
    c.header(`x-${h}`, "1");
    c.set("n", (c.get("n") ?? 0) + 1);
    await next();
  };
  const body = async (c) => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };
  app.get("/hello", (c) => c.json({ hello: "world" }));
  app.get("/users/:id", (c) => {
    const id = int(c.req.param("id"));
    return Number.isNaN(id) ? c.json({ error: "id" }, 400) : c.json(user(id, c.req.query("fields")));
  });
  app.post("/users", async (c) => {
    const b = await body(c);
    return isUser(b) ? c.json({ id: 1, name: b.name, age: b.age }, 201) : c.json({ error: "body" }, 400);
  });
  app.get("/teas", (c) => c.json(LIST));
  app.post("/teas/bulk", async (c) => {
    const b = await body(c);
    return isBulk(b) ? c.json({ count: b.items.length }, 201) : c.json({ error: "body" }, 400);
  });
  app.get("/mw", stamp("a"), stamp("b"), stamp("c"), (c) => c.json({ n: c.get("n") }));
  app.get("/async/:id", async (c) => {
    await tick();
    return c.json({ id: int(c.req.param("id")) });
  });
  for (let i = 0; i < ROUTE_COUNT; i++) {
    app.get(`/static/s${i}`, (c) => c.json({ i }));
    app.get(`/p${i}/:id/items/:item`, (c) => c.json({ id: int(c.req.param("id")), item: int(c.req.param("item")) }));
  }
  app.notFound((c) => c.json({ error: "not found" }, 404));
  serve({ fetch: app.fetch, port: Number(port), hostname: "127.0.0.1" }, ready);
}

if (name === "fastify") {
  const { default: Fastify } = await import("fastify");
  const app = Fastify();
  const obj = (properties, required) => ({ type: "object", properties, ...(required ? { required } : {}) });
  const Item = obj({
    id: { type: "integer" },
    name: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    price: { type: "number" },
    inStock: { type: "boolean" },
    meta: obj({ created: { type: "string" }, updated: { type: "string" } }),
  });
  const Tea = obj(
    { name: { type: "string", minLength: 1 }, kind: { enum: ["green", "black", "oolong"] }, grams: { type: "integer", minimum: 1 }, price: { type: "number", minimum: 0 } },
    ["name", "kind", "grams", "price"],
  );
  const stamp = (h) => async (req, reply) => {
    reply.header(`x-${h}`, "1");
    req.n = (req.n ?? 0) + 1;
  };
  app.decorateRequest("n", 0);
  app.get("/hello", { schema: { response: { 200: obj({ hello: { type: "string" } }) } } }, async () => ({ hello: "world" }));
  app.get(
    "/users/:id",
    {
      schema: {
        params: obj({ id: { type: "integer" } }, ["id"]),
        querystring: obj({ fields: { type: "string" } }),
        response: { 200: obj({ id: { type: "integer" }, fields: { type: ["string", "null"] } }) },
      },
    },
    async (req) => user(req.params.id, req.query.fields),
  );
  app.post(
    "/users",
    {
      schema: {
        body: obj({ name: { type: "string", minLength: 1 }, age: { type: "integer" } }, ["name", "age"]),
        response: { 201: obj({ id: { type: "integer" }, name: { type: "string" }, age: { type: "integer" } }) },
      },
    },
    async (req, reply) => reply.code(201).send({ id: 1, ...req.body }),
  );
  app.get("/teas", { schema: { response: { 200: { type: "array", items: Item } } } }, async () => LIST);
  app.post(
    "/teas/bulk",
    { schema: { body: obj({ items: { type: "array", items: Tea, maxItems: 500 } }, ["items"]), response: { 201: obj({ count: { type: "integer" } }) } } },
    async (req, reply) => reply.code(201).send({ count: req.body.items.length }),
  );
  app.get("/mw", { onRequest: [stamp("a"), stamp("b"), stamp("c")], schema: { response: { 200: obj({ n: { type: "integer" } }) } } }, async (req) => ({ n: req.n }));
  app.get("/async/:id", { schema: { params: obj({ id: { type: "integer" } }, ["id"]), response: { 200: obj({ id: { type: "integer" } }) } } }, async (req) => {
    await tick();
    return { id: req.params.id };
  });
  for (let i = 0; i < ROUTE_COUNT; i++) {
    app.get(`/static/s${i}`, async () => ({ i }));
    app.get(
      `/p${i}/:id/items/:item`,
      { schema: { params: obj({ id: { type: "integer" }, item: { type: "integer" } }, ["id", "item"]), response: { 200: obj({ id: { type: "integer" }, item: { type: "integer" } }) } } },
      async (req) => ({ id: req.params.id, item: req.params.item }),
    );
  }
  await app.listen({ port: Number(port), host: "127.0.0.1" });
  ready();
}

if (name === "koa") {
  const { default: Koa } = await import("koa");
  const { default: Router } = await import("@koa/router");
  const { bodyParser } = await import("@koa/bodyparser");
  const app = new Koa();
  const router = new Router();
  app.use(bodyParser());
  const stamp = (h) => async (ctx, next) => {
    ctx.set(`x-${h}`, "1");
    ctx.state.n = (ctx.state.n ?? 0) + 1;
    await next();
  };
  const send = (ctx, status, body) => {
    ctx.status = status;
    ctx.body = body;
  };
  router.get("/hello", (ctx) => (ctx.body = { hello: "world" }));
  router.get("/users/:id", (ctx) => {
    const id = int(ctx.params.id);
    Number.isNaN(id) ? send(ctx, 400, { error: "id" }) : send(ctx, 200, user(id, ctx.query.fields));
  });
  router.post("/users", (ctx) => {
    const b = ctx.request.body;
    isUser(b) ? send(ctx, 201, { id: 1, name: b.name, age: b.age }) : send(ctx, 400, { error: "body" });
  });
  router.get("/teas", (ctx) => (ctx.body = LIST));
  router.post("/teas/bulk", (ctx) => {
    const b = ctx.request.body;
    isBulk(b) ? send(ctx, 201, { count: b.items.length }) : send(ctx, 400, { error: "body" });
  });
  router.get("/mw", stamp("a"), stamp("b"), stamp("c"), (ctx) => (ctx.body = { n: ctx.state.n }));
  router.get("/async/:id", async (ctx) => {
    await tick();
    ctx.body = { id: int(ctx.params.id) };
  });
  for (let i = 0; i < ROUTE_COUNT; i++) {
    router.get(`/static/s${i}`, (ctx) => (ctx.body = { i }));
    router.get(`/p${i}/:id/items/:item`, (ctx) => (ctx.body = { id: int(ctx.params.id), item: int(ctx.params.item) }));
  }
  app.use(router.routes());
  app.use((ctx) => send(ctx, 404, { error: "not found" }));
  app.listen(Number(port), "127.0.0.1", ready);
}

if (name === "hapi") {
  const Hapi = await import("@hapi/hapi");
  const server = Hapi.server({ port: Number(port), host: "127.0.0.1" });
  // a route's own onPreHandler extensions are hapi's middlewares; the response does not exist yet there
  const stamp = (h) => (request, t) => {
    (request.app.stamps ??= []).push(`x-${h}`);
    request.app.n = (request.app.n ?? 0) + 1;
    return t.continue;
  };
  const route = (method, path, handler, options) => server.route({ method, path, handler, options });
  route("GET", "/hello", () => ({ hello: "world" }));
  route("GET", "/users/{id}", (request, h) => {
    const id = int(request.params.id);
    return Number.isNaN(id) ? h.response({ error: "id" }).code(400) : user(id, request.query.fields);
  });
  route("POST", "/users", (request, h) => {
    const b = request.payload;
    return isUser(b) ? h.response({ id: 1, name: b.name, age: b.age }).code(201) : h.response({ error: "body" }).code(400);
  });
  route("GET", "/teas", () => LIST);
  route("POST", "/teas/bulk", (request, h) =>
    isBulk(request.payload) ? h.response({ count: request.payload.items.length }).code(201) : h.response({ error: "body" }).code(400),
  );
  route(
    "GET",
    "/mw",
    (request, h) => {
      const res = h.response({ n: request.app.n });
      for (const s of request.app.stamps) res.header(s, "1");
      return res;
    },
    { ext: { onPreHandler: [{ method: stamp("a") }, { method: stamp("b") }, { method: stamp("c") }] } },
  );
  route("GET", "/async/{id}", async (request) => {
    await tick();
    return { id: int(request.params.id) };
  });
  for (let i = 0; i < ROUTE_COUNT; i++) {
    route("GET", `/static/s${i}`, () => ({ i }));
    route("GET", `/p${i}/{id}/items/{item}`, (request) => ({ id: int(request.params.id), item: int(request.params.item) }));
  }
  route("*", "/{any*}", (request, h) => h.response({ error: "not found" }).code(404));
  await server.start();
  ready();
}

if (name === "h3") {
  const { H3, serve, readBody, getQuery, getRouterParam } = await import("h3");
  const app = new H3();
  const stamp = (h) => (event, next) => {
    event.res.headers.set(`x-${h}`, "1");
    event.context.n = (event.context.n ?? 0) + 1;
    return next();
  };
  const send = (event, status, body) => {
    event.res.status = status;
    return body;
  };
  const body = (event) => readBody(event).catch(() => undefined);
  app.get("/hello", () => ({ hello: "world" }));
  app.get("/users/:id", (event) => {
    const id = int(getRouterParam(event, "id"));
    return Number.isNaN(id) ? send(event, 400, { error: "id" }) : user(id, getQuery(event).fields);
  });
  app.post("/users", async (event) => {
    const b = await body(event);
    return isUser(b) ? send(event, 201, { id: 1, name: b.name, age: b.age }) : send(event, 400, { error: "body" });
  });
  app.get("/teas", () => LIST);
  app.post("/teas/bulk", async (event) => {
    const b = await body(event);
    return isBulk(b) ? send(event, 201, { count: b.items.length }) : send(event, 400, { error: "body" });
  });
  app.get("/mw", (event) => ({ n: event.context.n }), { middleware: [stamp("a"), stamp("b"), stamp("c")] });
  app.get("/async/:id", async (event) => {
    await tick();
    return { id: int(getRouterParam(event, "id")) };
  });
  for (let i = 0; i < ROUTE_COUNT; i++) {
    app.get(`/static/s${i}`, () => ({ i }));
    app.get(`/p${i}/:id/items/:item`, (event) => ({ id: int(getRouterParam(event, "id")), item: int(getRouterParam(event, "item")) }));
  }
  app.all("/**", (event) => send(event, 404, { error: "not found" }));
  const server = serve(app, { port: Number(port), hostname: "127.0.0.1", silent: true });
  await server.ready();
  ready();
}

if (name === "elysia") {
  const { Elysia, t } = await import("elysia");
  const { node } = await import("@elysiajs/node");
  const Tea = t.Object({
    name: t.String({ minLength: 1 }),
    kind: t.UnionEnum(["green", "black", "oolong"]),
    grams: t.Integer({ minimum: 1 }),
    price: t.Number({ minimum: 0 }),
  });
  const stamp = (h) => (ctx) => {
    ctx.set.headers[`x-${h}`] = "1";
    ctx.n = (ctx.n ?? 0) + 1;
  };
  const app = new Elysia({ adapter: node() })
    // Elysia answers a failed schema with 422; the others say 400
    .onError(({ code, set }) => {
      if (code === "VALIDATION" || code === "PARSE") {
        set.status = 400;
        return { error: "body" };
      }
      if (code === "NOT_FOUND") {
        set.status = 404;
        return { error: "not found" };
      }
    })
    .get("/hello", () => ({ hello: "world" }))
    .get("/users/:id", ({ params, query }) => user(params.id, query.fields), {
      params: t.Object({ id: t.Integer() }),
      query: t.Object({ fields: t.Optional(t.String()) }),
    })
    .post(
      "/users",
      ({ body, set }) => {
        set.status = 201;
        return { id: 1, name: body.name, age: body.age };
      },
      { body: t.Object({ name: t.String({ minLength: 1 }), age: t.Integer() }) },
    )
    .get("/teas", () => LIST)
    .post(
      "/teas/bulk",
      ({ body, set }) => {
        set.status = 201;
        return { count: body.items.length };
      },
      { body: t.Object({ items: t.Array(Tea, { maxItems: 500 }) }) },
    )
    .get("/mw", (ctx) => ({ n: ctx.n }), { beforeHandle: [stamp("a"), stamp("b"), stamp("c")] })
    .get(
      "/async/:id",
      async ({ params }) => {
        await tick();
        return { id: params.id };
      },
      { params: t.Object({ id: t.Integer() }) },
    );
  const pair = t.Object({ id: t.Integer(), item: t.Integer() });
  for (let i = 0; i < ROUTE_COUNT; i++) {
    app.get(`/static/s${i}`, () => ({ i }));
    app.get(`/p${i}/:id/items/:item`, ({ params }) => ({ id: params.id, item: params.item }), { params: pair });
  }
  app.listen({ port: Number(port), hostname: "127.0.0.1" });
  // the Node adapter calls back before the socket listens, so wait for it
  const { connect } = await import("node:net");
  const open = () =>
    new Promise((resolve) => {
      const socket = connect(Number(port), "127.0.0.1");
      socket.on("connect", () => resolve(true) || socket.destroy()).on("error", () => resolve(false));
    });
  while (!(await open())) await new Promise((r) => setTimeout(r, 20));
  ready();
}

if (name === "nest") {
  // NestJS on its default platform, Express. Plain JS has no decorator syntax, so they are applied by hand.
  await import("reflect-metadata");
  const { Body, Controller, Get, HttpException, Module, Param, Post, Query, Req } = await import("@nestjs/common");
  const { NestFactory } = await import("@nestjs/core");
  const fail = (error) => {
    throw new HttpException({ error }, 400);
  };
  class Api {
    hello() {
      return { hello: "world" };
    }
    user(raw, fields) {
      const id = int(raw);
      return Number.isNaN(id) ? fail("id") : user(id, fields);
    }
    create(b) {
      return isUser(b) ? { id: 1, name: b.name, age: b.age } : fail("body");
    }
    teas() {
      return LIST;
    }
    bulk(b) {
      return isBulk(b) ? { count: b.items.length } : fail("body");
    }
    mw(req) {
      return { n: req.n };
    }
    async later(id) {
      await tick();
      return { id: int(id) };
    }
  }
  const route = (key, method, params = []) => {
    params.forEach((p, i) => p(Api.prototype, key, i));
    method(Api.prototype, key, Object.getOwnPropertyDescriptor(Api.prototype, key));
  };
  route("hello", Get("hello"));
  route("user", Get("users/:id"), [Param("id"), Query("fields")]);
  route("create", Post("users"), [Body()]);
  route("teas", Get("teas"));
  route("bulk", Post("teas/bulk"), [Body()]);
  route("mw", Get("mw"), [Req()]);
  route("later", Get("async/:id"), [Param("id")]);
  for (let i = 0; i < ROUTE_COUNT; i++) {
    Api.prototype[`s${i}`] = () => ({ i });
    Api.prototype[`p${i}`] = (id, item) => ({ id: int(id), item: int(item) });
    route(`s${i}`, Get(`static/s${i}`));
    route(`p${i}`, Get(`p${i}/:id/items/:item`), [Param("id"), Param("item")]);
  }
  Controller()(Api);
  const stamp = (h) => (req, res, next) => {
    res.setHeader(`x-${h}`, "1");
    req.n = (req.n ?? 0) + 1;
    next();
  };
  class App {
    configure(consumer) {
      consumer.apply(stamp("a"), stamp("b"), stamp("c")).forRoutes("mw");
    }
  }
  Module({ controllers: [Api] })(App);
  const app = await NestFactory.create(App, { logger: false });
  await app.listen(Number(port), "127.0.0.1");
  ready();
}

if (name.startsWith("inkan")) {
  // inkan-base is another version of inkan, checked out at $INKAN_BASE: the one a change is measured against
  const from = name === "inkan-base" ? pathToFileURL(join(process.env.INKAN_BASE ?? "", "bench/inkan-app.mjs")).href : "./inkan-app.mjs";
  const { app } = await import(from);
  // inkan-sealed runs on the seal `inkan seal seal-entry.mjs -o inkan.seal.js` writes
  const seal = name === "inkan-sealed" ? (await import("./inkan.seal.js")).default : undefined;
  if (name === "inkan-uws") {
    // the same app on uWebSockets.js, through @inkanjs/uws (github.com/inkanjs/integrations)
    const { serve } = await import("@inkanjs/uws");
    await serve(app(false), { port: Number(port), host: "127.0.0.1" });
    ready();
  } else if (name === "inkan-cluster") {
    // two workers on one port; the first process only looks after them, so it says ready once both listen
    const { default: cluster } = await import("node:cluster");
    if (cluster.isPrimary) {
      let n = 0;
      cluster.on("listening", () => ++n === 2 && ready());
    }
    await app(false, undefined, 2).listen(Number(port), "127.0.0.1");
  } else {
    await app(name === "inkan-dev", seal, undefined, name === "inkan-noid" ? { requestId: false } : {}).listen(Number(port), "127.0.0.1");
    ready();
  }
}

// The same routes in every server, doing the same work, so the numbers compare like
// with like. Fastify and inkan check input and shape output with schemas; Express,
// Hono and bare node:http do the same checks by hand (see data.mjs).
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
//   node servers.mjs <node|express|fastify|hono|inkan|inkan-sealed|inkan-cluster|inkan-uws|inkan-dev> <port>

import http from "node:http";
import { isBulk, isUser, LIST, ROUTE_COUNT, user } from "./data.mjs";

const [name, port] = process.argv.slice(2);
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

if (name.startsWith("inkan")) {
  const { app } = await import("./inkan-app.mjs");
  // inkan-sealed runs on the seal `inkan seal seal-entry.mjs -o inkan.seal.js` writes
  const seal = name === "inkan-sealed" ? (await import("./inkan.seal.js")).default : undefined;
  if (name === "inkan-uws") {
    // the same app on uWebSockets.js, through the adapter in adapters/uws
    const { serve } = await import("../adapters/uws/index.js");
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
    await app(name === "inkan-dev", seal).listen(Number(port), "127.0.0.1");
    ready();
  }
}

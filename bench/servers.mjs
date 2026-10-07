// The same three routes in every server, so the numbers compare like with like:
//   GET  /hello                    a fixed JSON answer
//   GET  /users/:id?fields=…       a typed path param and query, a JSON answer
//   POST /users                    a JSON body, checked, answered with 201
// Express gets the same checks by hand; Fastify and inkan get them from schemas.
//
//   node servers.mjs <node|express|fastify|inkan|inkan-dev> <port>

import http from "node:http";

const [name, port] = process.argv.slice(2);
const user = (id, fields) => ({ id, fields: fields ?? null });
const ready = () => console.log("ready");

if (name === "node") {
  http
    .createServer((req, res) => {
      const [path, search] = req.url.split("?");
      if (req.method === "GET" && path === "/hello") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"hello":"world"}');
      }
      const m = /^\/users\/(\d+)$/.exec(path);
      if (req.method === "GET" && m) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(user(Number(m[1]), new URLSearchParams(search).get("fields") ?? undefined)));
      }
      if (req.method === "POST" && path === "/users") {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
          const body = JSON.parse(b);
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: 1, name: body.name, age: body.age }));
        });
        return;
      }
      res.writeHead(404).end();
    })
    .listen(port, "127.0.0.1", ready);
}

if (name === "express") {
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.get("/hello", (req, res) => res.json({ hello: "world" }));
  app.get("/users/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).end();
    res.json(user(id, req.query.fields));
  });
  app.post("/users", (req, res) => {
    const { name: n, age } = req.body ?? {};
    if (typeof n !== "string" || !n || !Number.isInteger(age)) return res.status(400).end();
    res.status(201).json({ id: 1, name: n, age });
  });
  app.listen(Number(port), "127.0.0.1", ready);
}

if (name === "fastify") {
  const { default: Fastify } = await import("fastify");
  const app = Fastify();
  const obj = (properties, required) => ({ type: "object", properties, ...(required ? { required } : {}) });
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
  await app.listen({ port: Number(port), host: "127.0.0.1" });
  ready();
}

if (name.startsWith("inkan")) {
  const { app } = await import("./inkan-app.mjs");
  await app(name === "inkan-dev").listen(Number(port), "127.0.0.1");
  ready();
}

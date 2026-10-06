import { test } from "node:test";
import assert from "node:assert/strict";
import { cors, inkan, problem, t } from "../src/index.ts";

const quiet = { log: false, gracefulShutdown: false } as const;
const preflight = (origin: string, extra: Record<string, string> = {}) => ({
  method: "OPTIONS",
  url: "/teas/1",
  headers: { origin, "access-control-request-method": "PUT", ...extra },
});

const shop = () =>
  inkan(quiet)
    .get("/teas/:id", { params: t.object({ id: t.int() }), response: { 200: t.object({ id: t.int() }), 404: t.problem() } }, ({ params }) => {
      if (params.id !== 1) throw problem(404, "tea-not-found", "no such tea");
      return { id: 1 };
    })
    .put("/teas/:id", () => ({ ok: true }));

test("OPTIONS answers on its own, with Allow and no contract note", async () => {
  const app = shop();
  const res = await app.inject({ method: "OPTIONS", url: "/teas/1" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.allow, "GET, PUT, HEAD, OPTIONS");
  assert.equal(res.text, "");
  assert.equal((await app.inject({ method: "OPTIONS", url: "/nowhere" })).status, 404);
});

test("cors: any origin by default, preflight echoes the asked headers", async () => {
  const app = shop().use(cors());
  const pre = await app.inject(preflight("https://a.example", { "access-control-request-headers": "content-type, x-tea" }));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers["access-control-allow-origin"], "*");
  assert.match(pre.headers["access-control-allow-methods"], /PUT/);
  assert.equal(pre.headers["access-control-allow-headers"], "content-type, x-tea");
  assert.equal(pre.headers.vary, undefined);

  const get = await app.inject({ url: "/teas/1", headers: { origin: "https://a.example" } });
  assert.equal(get.status, 200);
  assert.equal(get.headers["access-control-allow-origin"], "*");
});

test("cors: one origin or a list, others get no headers", async () => {
  const one = shop().use(cors({ origin: "https://shop.example", maxAge: 600 }));
  const ok = await one.inject(preflight("https://shop.example"));
  assert.equal(ok.headers["access-control-allow-origin"], "https://shop.example");
  assert.equal(ok.headers.vary, "origin");
  assert.equal(ok.headers["access-control-max-age"], "600");
  const no = await one.inject(preflight("https://evil.example"));
  assert.equal(no.status, 204);
  assert.equal(no.headers["access-control-allow-origin"], undefined);

  const many = shop().use(cors({ origin: ["https://a.example", "https://b.example"] }));
  assert.equal((await many.inject(preflight("https://b.example"))).headers["access-control-allow-origin"], "https://b.example");
  assert.equal((await many.inject(preflight("https://c.example"))).headers["access-control-allow-origin"], undefined);
});

test("cors: credentials echo the origin instead of *, error answers keep the headers", async () => {
  const app = shop().use(cors({ credentials: true, exposeHeaders: ["x-total"] }));
  const res = await app.inject({ url: "/teas/9", headers: { origin: "https://a.example" } });
  assert.equal(res.status, 404);
  assert.equal(res.headers["content-type"], "application/problem+json");
  assert.equal(res.headers["access-control-allow-origin"], "https://a.example");
  assert.equal(res.headers["access-control-allow-credentials"], "true");
  assert.equal(res.headers["access-control-expose-headers"], "x-total");
});

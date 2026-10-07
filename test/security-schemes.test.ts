import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, plugin, routes, t } from "../src/index.ts";

const quiet = { log: false as const };

test("a route that asks for a bearer token refuses a request without one, before anything else", async () => {
  const app = inkan(quiet).post("/teas", { security: "bearer", body: t.object({ name: t.string() }) }, () => ({ ok: 1 }));
  const none = await app.inject({ method: "POST", url: "/teas", body: { name: 5 } });
  assert.equal(none.status, 401, "401 before the 400 the body would get");
  assert.equal(none.body.type, "unauthorized");
  assert.equal(none.body.detail, "This route needs a bearer token in authorization");
  assert.equal(none.headers["www-authenticate"], "Bearer");
  assert.equal((await app.inject({ method: "POST", url: "/teas", headers: { authorization: "Bearer" }, body: { name: "x" } })).status, 401);
  assert.equal((await app.inject({ method: "POST", url: "/teas", headers: { authorization: "Basic abc" }, body: { name: "x" } })).status, 401);
  assert.equal((await app.inject({ method: "POST", url: "/teas", headers: { authorization: "Bearer abc" }, body: { name: "x" } })).status, 200);
});

test("api keys in a header, the query or a cookie, and alternatives where any one will do", async () => {
  const app = inkan(quiet)
    .get("/h", { security: { apiKey: "X-Api-Key" } }, () => ({ ok: 1 }))
    .get("/q", { security: { apiKey: "key", in: "query" } }, () => ({ ok: 1 }))
    .get("/c", { security: { apiKey: "session", in: "cookie" } }, () => ({ ok: 1 }))
    .get("/either", { security: ["bearer", "basic"] }, () => ({ ok: 1 }));
  assert.equal((await app.inject({ url: "/h" })).status, 401);
  assert.equal((await app.inject({ url: "/h", headers: { "x-api-key": "k" } })).status, 200);
  assert.equal((await app.inject({ url: "/q?key=k" })).status, 200);
  assert.equal((await app.inject({ url: "/q?key=" })).status, 401);
  assert.equal((await app.inject({ url: "/c", headers: { cookie: "a=1; session=s3cret" } })).status, 200);
  assert.equal((await app.inject({ url: "/c", headers: { cookie: "sessions=x; session=" } })).status, 401);
  const either = await app.inject({ url: "/either" });
  assert.equal(either.body.detail, "This route needs a bearer token in authorization or basic credentials in authorization");
  assert.equal(either.headers["www-authenticate"], 'Bearer, Basic realm="api"');
  assert.equal((await app.inject({ url: "/either", headers: { authorization: "Basic dTpw" } })).status, 200);
});

test("security for a group, a plugin and the whole app; false opens a route again", async () => {
  const admin = routes().security("bearer").get("/stats", () => ({ ok: 1 }));
  const app = inkan(quiet)
    .security({ apiKey: "x-api-key" })
    .get("/private", () => ({ ok: 1 }))
    .get("/health", { security: false }, () => ({ ok: 1 }))
    .mount("/admin", admin)
    .register(plugin((p) => void p.security("basic").get("/report", () => ({ ok: 1 }))));
  await app.ready();
  assert.equal((await app.inject({ url: "/private" })).status, 401);
  assert.equal((await app.inject({ url: "/health" })).status, 200);
  assert.equal((await app.inject({ url: "/admin/stats", headers: { "x-api-key": "k" } })).status, 401, "the group asks for its own");
  assert.equal((await app.inject({ url: "/admin/stats", headers: { authorization: "Bearer t" } })).status, 200);
  assert.equal((await app.inject({ url: "/report", headers: { authorization: "Basic x" } })).status, 200);
});

test("OpenAPI lists the schemes, which operation asks for which, an implied 401 and response headers", async () => {
  const app = inkan(quiet)
    .post(
      "/teas",
      {
        security: ["bearer", { apiKey: "x-api-key" }],
        body: t.object({ name: t.string() }),
        response: { 201: t.object({ name: t.string() }) },
        responseHeaders: { 201: { location: t.string().describe("Where the new tea lives"), "x-trace": t.string().optional() } },
      },
      ({ body, reply }) => reply(201, body, { location: "/teas/1" }),
    )
    .get("/open", () => ({ ok: 1 }))
    .get("/q", { security: { apiKey: "key", in: "query" } }, () => ({ ok: 1 }));
  const doc = app.openapi() as any;
  assert.deepEqual(doc.components.securitySchemes, {
    bearer: { type: "http", scheme: "bearer" },
    "x-api-key": { type: "apiKey", in: "header", name: "x-api-key" },
    "key-query": { type: "apiKey", in: "query", name: "key" },
  });
  const post = doc.paths["/teas"].post;
  assert.deepEqual(post.security, [{ bearer: [] }, { "x-api-key": [] }]);
  assert.equal(post.responses["401"]["x-inkan-implied"], true);
  assert.deepEqual(post.responses["201"].headers, {
    location: { schema: { type: "string", description: "Where the new tea lives" }, required: true, description: "Where the new tea lives" },
    "x-trace": { schema: { type: "string" }, required: false },
  });
  assert.equal(doc.paths["/open"].get.security, undefined);
  assert.equal(doc.paths["/open"].get.responses["401"], undefined);
});

test("in development an answer has to carry the headers its status promises", async () => {
  const build = (dev: boolean, sendLocation: boolean) =>
    inkan({ ...quiet, dev }).post(
      "/teas",
      { response: { 201: t.object({ id: t.int() }) }, responseHeaders: { 201: { location: t.string(), "retry-after": t.int().optional() } } },
      ({ reply }) => reply(201, { id: 1 }, sendLocation ? { location: "/teas/1", "retry-after": "5" } : {}),
    );
  const errors = console.error;
  console.error = () => {};
  try {
    const broken = await build(true, false).inject({ method: "POST", url: "/teas" });
    assert.equal(broken.status, 500);
    assert.equal(broken.body.type, "response-contract");
    assert.deepEqual(broken.body.errors, [{ in: "response headers", path: "location", message: "is required" }]);
    assert.equal((await build(true, true).inject({ method: "POST", url: "/teas" })).status, 201, "a number header is read like a query");
    assert.equal((await build(false, false).inject({ method: "POST", url: "/teas" })).status, 201, "production does not check, as with bodies");
  } finally {
    console.error = errors;
  }
});

test("examples with credentials pass inkan check, and the 401 counts as implied", async () => {
  const app = inkan(quiet).get(
    "/me",
    { security: "bearer", response: { 200: t.object({ me: t.boolean() }) }, examples: [{ name: "with a token", headers: { authorization: "Bearer test" } }] },
    () => ({ me: true }),
  );
  const report = await app.check({ strict: true });
  assert.equal(report.ok, true, JSON.stringify(report));
});

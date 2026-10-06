import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReport, inkan, partialMatch, t } from "../src/index.ts";

process.env.INKAN_NO_LISTEN = "1"; // the example calls listen(); here it only gets read
const { app: shop, beforeEach } = await import("../examples/shop.ts");
delete process.env.INKAN_NO_LISTEN;

const quiet = { log: false, gracefulShutdown: false } as const;

test("every example in the tea shop keeps its promise", async () => {
  const report = await shop.check({ beforeEach });
  const broken = report.results.filter((r) => !r.ok).map((r) => `${r.method} ${r.path} ${r.example}: ${r.problems.join("; ")}`);
  assert.deepEqual(broken, []);
  assert.equal(report.unchecked.length, 0);
});

test("check catches a handler that drifted from its examples", async () => {
  const app = inkan(quiet)
    .get(
      "/users/:id",
      {
        params: t.object({ id: t.int() }),
        response: { 200: t.object({ id: t.int(), name: t.string() }), 404: t.problem() },
        examples: [
          { name: "found", params: { id: 1 }, expect: { name: "Mio" } },
          { name: "missing", params: { id: 2 }, status: 404 },
        ],
      },
      ({ params }) => ({ id: params.id, name: "Rin" }), // forgot the 404, renamed the user
    )
    .get("/untested", () => "ok");
  const report = await app.check();
  assert.equal(report.ok, false);
  assert.equal(report.failed, 2);
  assert.match(report.results[0].problems[0], /body\.name: expected "Mio", got "Rin"/);
  assert.match(report.results[1].problems[0], /answered 200, expected 404/);
  assert.deepEqual(report.unchecked, ["GET /untested"]);
});

test("check lists promised statuses no example covers, and --strict fails on them", async () => {
  const app = inkan(quiet).get(
    "/teas/:id",
    {
      params: t.object({ id: t.int() }),
      response: { 200: t.object({ id: t.int() }), 400: t.problem(), 404: t.problem() },
      examples: [{ name: "found", params: { id: 1 } }],
    },
    ({ params }) => ({ id: params.id }),
  );
  const report = await app.check();
  assert.equal(report.ok, true);
  assert.deepEqual(report.uncovered, [
    { method: "GET", path: "/teas/:id", status: 400 },
    { method: "GET", path: "/teas/:id", status: 404 },
  ]);
  assert.match(formatReport(report), /404 is in the contract, but no example answers with it/);
  assert.match(formatReport(report), /2 statuses uncovered/);
  assert.equal((await app.check({ strict: true })).ok, false);
});

test("partialMatch compares only what the example names", () => {
  assert.equal(partialMatch({ a: 1 }, { a: 1, b: 2 }), undefined);
  assert.equal(partialMatch([{ a: 1 }], [{ a: 1, z: 0 }]), undefined);
  assert.match(partialMatch({ a: { b: 1 } }, { a: { b: 2 } })!, /body\.a\.b/);
  assert.match(partialMatch([1, 2], [1])!, /2 items/);
});

test("OpenAPI comes out of the same schemas", () => {
  const doc = shop.openapi() as any;
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.title, "Tea Shop");
  const get = doc.paths["/teas/{id}"].get;
  assert.equal(get.operationId, "getTeasById");
  assert.deepEqual(get.parameters[0], {
    name: "id",
    in: "path",
    required: true,
    schema: { type: "integer", minimum: 1 },
    examples: { found: { value: 1 }, missing: { value: 99 }, "not a number": { value: "abc" } },
  });
  assert.deepEqual(get.responses["200"].content["application/json"].schema, { $ref: "#/components/schemas/Tea" });
  assert.ok(get.responses["404"].content["application/problem+json"]);
  assert.ok(get.responses["400"], "input routes promise a 400 without being told");
  assert.ok(doc.components.schemas.Tea);
  assert.ok(doc.components.schemas.Problem);
  assert.equal(doc.paths["/teas"].post.requestBody.content["application/json"].examples["a new oolong"].value.name, "Da Hong Pao");
});

test("hidden routes stay out of the document", () => {
  const app = inkan(quiet).get("/secret", { hidden: true }, () => ({}));
  assert.deepEqual((app.openapi() as any).paths, {});
});

// ---- types: these only have to compile ----

test("types follow the contract", () => {
  inkan(quiet).get(
    "/a/:id",
    { params: t.object({ id: t.int() }), query: t.object({ q: t.string().optional() }), response: { 200: t.object({ n: t.int() }) } },
    ({ params, query }) => {
      const n: number = params.id;
      const q: string | undefined = query.q;
      void q;
      return { n };
    },
  );
  inkan(quiet).get(
    "/a2",
    { response: { 200: t.object({ n: t.int() }) } },
    // @ts-expect-error the contract says n is a number
    () => ({ n: "nope" }),
  );
  inkan(quiet).get("/b/:slug/*rest", ({ params }) => {
    const s: string = params.slug + params.rest; // read from the path itself
    // @ts-expect-error there is no :id in this path
    void params.id;
    return s;
  });
  inkan(quiet).post(
    "/c",
    { body: t.object({ name: t.string() }), response: { 201: t.object({ id: t.int() }), 409: t.problem() } },
    ({ body, reply }) => {
      const name: string = body.name;
      void name;
      // @ts-expect-error 418 is not in the contract
      void reply(418, {});
      return reply(201, { id: 1 });
    },
  );
  assert.ok(true);
});

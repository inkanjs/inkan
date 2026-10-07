import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, problem, t, type Example } from "../src/index.ts";
import { substitute } from "../src/check.ts";

const quiet = { log: false, gracefulShutdown: false } as const;

test("substitute: a placeholder alone keeps its type, inside text it becomes text", () => {
  const kept = { id: 7, slug: "da-hong-pao" };
  assert.deepEqual(substitute({ params: { id: "{id}" }, headers: { link: "/teas/{id}/{slug}" }, list: ["{id}"], left: "{nope}" }, kept), {
    params: { id: 7 },
    headers: { link: "/teas/7/da-hong-pao" },
    list: [7],
    left: "{nope}",
  });
});

// A shop where ids keep counting, so an example can only find what an earlier one made.
function shop(examples: { post?: Example[]; get?: Example[]; del?: Example[] }) {
  let teas: { id: number; name: string }[] = [];
  let next = 1;
  let resets = 0;
  const app = inkan(quiet)
    .post(
      "/teas",
      { body: t.object({ name: t.string().min(1) }), response: { 201: t.object({ id: t.int(), name: t.string() }) }, examples: examples.post },
      ({ body, reply }) => {
        const tea = { id: next++, name: body.name };
        teas.push(tea);
        return reply(201, tea, { location: `/teas/${tea.id}` });
      },
    )
    .get(
      "/teas/:id",
      { params: t.object({ id: t.int() }), response: { 200: t.object({ id: t.int(), name: t.string() }), 404: t.problem() }, examples: examples.get },
      ({ params }) => teas.find((x) => x.id === params.id) ?? Promise.reject(problem(404, "gone")),
    )
    .delete(
      "/teas/:id",
      { params: t.object({ id: t.int() }), response: { 204: t.empty() }, examples: examples.del },
      ({ params }) => void (teas = teas.filter((x) => x.id !== params.id)),
    );
  const beforeEach = () => {
    resets++;
    teas = [];
    next = 100; // nothing to find unless an example made it
  };
  return { app, beforeEach, resets: () => resets };
}

test("keep and after: create, then fetch what was created", async () => {
  const { app, beforeEach, resets } = shop({
    post: [{ name: "add", body: { name: "Sencha" }, keep: { id: "body.id", where: "headers.location" } }],
    get: [
      { name: "the new one", after: "POST /teas > add", params: { id: "{id}" }, expect: { id: 100, name: "Sencha" } },
      { name: "gone once removed", after: "DELETE /teas/:id > remove it", params: { id: "{id}" }, status: 404 },
    ],
    del: [{ name: "remove it", after: "POST /teas > add", params: { id: "{id}" }, status: 204 }],
  });
  const report = await app.check({ beforeEach });
  assert.deepEqual(report.results.filter((r) => !r.ok), []);
  assert.equal(report.passed, 4);
  assert.equal(resets(), 4, "beforeEach once per example and its chain, not once per step");
});

test("a step that fails says which one and why", async () => {
  const { app, beforeEach } = shop({
    post: [{ name: "add nothing", body: { name: "" } }],
    get: [{ name: "needs it", after: "POST /teas > add nothing", params: { id: 1 } }],
  });
  const report = await app.check({ beforeEach });
  const needs = report.results.find((r) => r.example === "needs it")!;
  assert.equal(needs.ok, false);
  assert.match(needs.problems[0], /needs "POST \/teas > add nothing" first, which answered 400, expected 201/);
});

test("after pointing nowhere, or in a circle, is a clear failure", async () => {
  const { app, beforeEach } = shop({
    get: [
      { name: "nowhere", after: "POST /teas > does not exist", params: { id: 1 } },
      { name: "a", after: "GET /teas/:id > b", params: { id: 1 } },
      { name: "b", after: "GET /teas/:id > a", params: { id: 1 } },
    ],
  });
  const report = await app.check({ beforeEach });
  const [nowhere, a] = report.results;
  assert.match(nowhere.problems[0], /is not an example\. Write it as "METHOD \/path > example name"/);
  assert.match(a.problems[0], /after goes in a circle: GET \/teas\/:id > a → GET \/teas\/:id > b → GET \/teas\/:id > a/);
});

test("an example has to have what it promises to keep", async () => {
  const { app, beforeEach } = shop({ post: [{ name: "add", body: { name: "x" }, keep: { id: "body.nope" } }] });
  const [add] = (await app.check({ beforeEach })).results;
  assert.deepEqual(add.problems, ["keeps id from body.nope, but the answer has no body.nope"]);
});

test("keep and after travel into OpenAPI for the docs page", () => {
  const { app } = shop({ get: [{ name: "the new one", after: "POST /teas > add", params: { id: "{id}" } }] });
  const op = (app.openapi() as any).paths["/teas/{id}"].get;
  assert.equal(op["x-inkan-examples"][0].after, "POST /teas > add");
});

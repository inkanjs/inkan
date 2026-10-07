import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, t, type Example, type LogEntry } from "../src/index.ts";
import { exampleFrom, literal } from "../src/testing/record.ts";

const quiet = { log: false, gracefulShutdown: false } as const;
const lastEntry = async (app: ReturnType<typeof inkan>): Promise<LogEntry> => {
  const log = (await app.inject({ url: "/_inkan/log.json" })).body as LogEntry[];
  return log[log.length - 1];
};
const evaluate = (snippet: string): Example => new Function(`return [${snippet}][0]`)();

test("literal writes what a person would write", () => {
  assert.equal(literal({ id: 2, "x-tenant": "a", list: [1, "b"], nested: { ok: true } }), '{ id: 2, "x-tenant": "a", list: [1, "b"], nested: { ok: true } }');
  assert.equal(literal({}), "{}");
});

test("a recorded request becomes an example that check seals", async () => {
  const body = t.object({ name: t.string(), grams: t.int() });
  const spec = {
    params: t.object({ id: t.int() }),
    query: t.object({ tag: t.array(t.string()).optional() }),
    body,
    response: { 201: t.object({ id: t.int(), name: t.string() }) },
    examples: [] as Example[],
  };
  const app = inkan(quiet).post("/shelves/:id/teas", spec, ({ params, body, reply }) => reply(201, { id: params.id, name: body.name }));

  await app.inject({
    method: "POST",
    url: "/shelves/7/teas?tag=green&tag=spring",
    headers: { authorization: "Bearer secret", "x-tenant": "north", "user-agent": "curl/8" },
    body: { name: "Gyokuro", grams: 50 },
  });
  const entry = await lastEntry(app);
  assert.ok(entry.example);
  assert.ok(!entry.example.includes("secret"), "secrets stay out");
  assert.ok(!entry.example.includes("curl/8"), "noise headers stay out");

  const example = evaluate(entry.example);
  assert.deepEqual(example.params, { id: 7 });
  assert.deepEqual(example.query, { tag: ["green", "spring"] });
  assert.deepEqual(example.headers, { "x-tenant": "north" });
  assert.deepEqual(example.body, { name: "Gyokuro", grams: 50 });
  assert.equal(example.status, 201);

  spec.examples.push(example); // the same object the route holds
  const report = await app.check();
  assert.equal(report.ok, true, JSON.stringify(report.results));
  assert.equal(report.passed, 1);
});

test("wildcards, form bodies and errors are recorded too", async () => {
  const app = inkan(quiet)
    .get("/files/*path", () => "ok")
    .post("/form", { body: t.object({ a: t.int() }) }, () => "ok");
  await app.inject({ url: "/files/a/b%20c.txt" });
  assert.deepEqual(evaluate((await lastEntry(app)).example!).params, { path: "a/b c.txt" });

  await app.inject({ method: "POST", url: "/form", body: "a=x", headers: { "content-type": "application/x-www-form-urlencoded" } });
  const failed = evaluate((await lastEntry(app)).example!);
  assert.deepEqual(failed.body, { a: "x" });
  assert.equal(failed.status, 400, "a rejected request makes an example of the rejection");
});

test("no route, no example; a clipped body is not replayable", async () => {
  const app = inkan(quiet).post("/big", () => "ok");
  await app.inject({ url: "/nowhere" });
  assert.equal((await lastEntry(app)).example, undefined);

  await app.inject({ method: "POST", url: "/big", body: { blob: "x".repeat(5000) } });
  const big = await lastEntry(app);
  assert.equal(big.request.clipped, true);
  assert.equal(evaluate(big.example!).body, undefined, "a cut-off body is left out rather than guessed");
});

test("a replay is marked in the log", async () => {
  const app = inkan(quiet).get("/x", () => "ok");
  await app.inject({ url: "/x", headers: { "x-inkan-replay": "12" } });
  assert.deepEqual((await lastEntry(app)).notes, ["replay of #12"]);
});

test("exampleFrom works on a bare entry", () => {
  const snippet = exampleFrom({
    id: 1,
    at: "2026-10-07T09:15:02.000Z",
    method: "GET",
    path: "/teas/3",
    route: "/teas/:id",
    status: 404,
    ms: 1,
    notes: [],
    request: { headers: {} },
    response: {},
  });
  assert.equal(snippet, '{ name: "recorded 09:15:02", params: { id: 3 }, status: 404 },');
});

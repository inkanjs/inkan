import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { app, resetTodos } from "../src/app.ts";

// Examples describe the API for people. Some things are tests, not documentation:
// sequences, counts, edge cases nobody needs to read on the docs page.
// app.inject() sends a request straight into the app: no port, no network, fast.
beforeEach(resetTodos);

test("ids keep counting up", async () => {
  const a = await app.inject({ method: "POST", url: "/todos", body: { title: "a" } });
  const b = await app.inject({ method: "POST", url: "/todos", body: { title: "b" } });
  assert.deepEqual([a.body.id, b.body.id], [2, 3]);
});

test("a todo marked done shows up under ?done=true", async () => {
  await app.inject({ method: "PATCH", url: "/todos/1/done" });
  const res = await app.inject({ url: "/todos?done=true" });
  assert.deepEqual(res.body.map((x: { id: number }) => x.id), [1]);
});

test("a bad request lists every issue at once", async () => {
  const res = await app.inject({ method: "POST", url: "/todos", body: { title: 5, extra: true } });
  assert.equal(res.status, 400);
  assert.equal(res.headers["content-type"], "application/problem+json");
  assert.deepEqual(res.body.errors, [{ in: "body", path: "title", message: "expected a string, got number" }]);
});

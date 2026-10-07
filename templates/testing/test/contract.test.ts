import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReport } from "@vxnsin/inkan";
import { app, resetTodos } from "../src/app.ts";

// 1. One test for every example in the app. `strict` also fails when the contract
//    promises a status that no example answers with.
test("every example keeps its promise", async () => {
  const report = await app.check({ beforeEach: resetTodos, strict: true });
  // 2. On failure, print the same report `inkan check` prints, so you see which example and why.
  assert.ok(report.ok, formatReport(report));
});

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { formatReport } from "@inkanjs/inkan";
import { app, beforeEach{{untestedImport}} } from "../{{src}}/app.ts";
import { closeStore, store } from "../{{src}}/store.ts";

after(closeStore);

{{checkTest}}

// 2. What examples are not for: app.inject() sends a request straight into the app,
//    no port, no network.
test("a note in the store comes back through the API", async () => {
  await store.set("note:from-a-test", { id: "from-a-test", text: "written by the test" }, 60_000);
  const res = await app.inject({ url: "{{prefix}}/notes/from-a-test" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: "from-a-test", text: "written by the test" });
});

test("a missing note is a problem, with its own content type", async () => {
  const res = await app.inject({ url: "{{prefix}}/notes/never-written" });
  assert.equal(res.status, 404);
  assert.equal(res.headers["content-type"], "application/problem+json");
  assert.equal(res.body.type, "note-not-found");
});

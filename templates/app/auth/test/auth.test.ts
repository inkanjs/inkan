import { after, test } from "node:test";
import assert from "node:assert/strict";
import { app } from "../{{src}}/app.ts";
import { demoAccount } from "../{{src}}/auth.ts";
import { closeStore } from "../{{src}}/store.ts";

after(closeStore);

// A browser sends this with every request from your own pages; the CSRF check wants it
// on a request that carries the session cookie and changes something.
const sameOrigin = { "sec-fetch-site": "same-origin" };

test("writing a note takes a login", async () => {
  const res = await app.inject({ method: "PUT", url: "{{prefix}}/notes/a-secret", body: { text: "hidden" } });
  assert.equal(res.status, 401);
});

test("after logging in, the session cookie lets the request through", async () => {
  const login = await app.inject({ method: "POST", url: "{{prefix}}/auth/login", body: demoAccount });
  assert.equal(login.status, 200);
  const cookie = login.cookies[0]!.split(";")[0]!; // "sid=…", without its attributes

  const put = await app.inject({ method: "PUT", url: "{{prefix}}/notes/mine", headers: { cookie, ...sameOrigin }, body: { text: "only for me" } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, { id: "mine", text: "only for me" });

  const me = await app.inject({ url: "{{prefix}}/auth/me", headers: { cookie } });
  assert.equal(me.body.id, "1");
});

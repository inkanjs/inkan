import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan } from "../src/index.ts";
import { docsPage } from "../src/pages/docs.ts";
import { inspectorPage } from "../src/pages/inspector.ts";

const quiet = { log: false, gracefulShutdown: false } as const;

test("a path that starts with // is a path, not another host", async () => {
  const app = inkan(quiet).get("/x", () => "the x route");
  const res = await app.inject({ url: "//evil.example/x" });
  assert.equal(res.status, 404, "it must not be routed as /x");
  assert.equal(res.body.instance, "//evil.example/x");
});

test("a proxy's absolute form loses its scheme and host, the query survives", async () => {
  const app = inkan(quiet).get("/x", ({ query }) => ({ q: query.q }));
  const res = await app.inject({ url: "http://api.example/x?q=1" });
  assert.deepEqual(res.body, { q: "1" });
});

test("ctx.url is still a URL, built from the Host header when a handler asks for it", async () => {
  const app = inkan(quiet).get("/where", ({ url }) => ({ href: url.href, path: url.pathname, q: url.searchParams.get("q") }));
  const res = await app.inject({ url: "/where?q=tea", headers: { host: "shop.local:8080" } });
  assert.deepEqual(res.body, { href: "http://shop.local:8080/where?q=tea", path: "/where", q: "tea" });
});

test("the pages only send requests to their own origin and escape configured links", () => {
  const docs = docsPage({ title: "API", specUrl: '/o.json"><script>alert(1)</script>', inspector: "/_inkan" });
  assert.ok(!docs.includes("<script>alert(1)"), "a configured href cannot break out of its attribute");
  assert.ok((docs.match(/sameOrigin\(/g) ?? []).length >= 3, "send and chain check the origin");
  const inspector = inspectorPage({ title: "API", base: "/_inkan", docs: '/docs"><b>' });
  assert.ok(!inspector.includes('"><b>'));
  assert.ok(/if \(!sameOrigin\(e\.path\)\)/.test(inspector), "replay checks the origin");
});

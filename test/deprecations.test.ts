// Old names keep working after a rename, and say so once, in development only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpenAPI, inkan, t } from "../src/index.ts";

const quiet = { log: false as const };

/** What `fn` warns, one string per console.warn call. */
async function warnings(fn: () => unknown): Promise<string[]> {
  const seen: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void seen.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
  return seen;
}

test("buildOpenAPI takes an app, or the routes as before, and warns once", async () => {
  const app = inkan({ ...quiet, title: "Teas" })
    .get("/teas", { response: { 200: t.array(t.string()) } }, () => []);
  let fromApp: Record<string, unknown> = {};
  let fromRoutes: Record<string, unknown> = {};
  const said = await warnings(() => {
    fromApp = buildOpenAPI(app);
    fromRoutes = buildOpenAPI(app.routes(), { title: "Teas" });
  });
  assert.deepEqual(fromApp, app.openapi());
  assert.deepEqual(Object.keys(fromRoutes.paths as object), ["/teas"]);
  assert.equal(said.length, 1);
  assert.match(said[0]!, /buildOpenAPI\(\) is deprecated, use app\.openapi\(\)/);
});

test("app.job({ keep }) in seconds still works as retain in milliseconds, and warns once", async () => {
  const said = await warnings(() => {
    inkan(quiet).job("/a", { keep: 2 }, () => "ok");
    inkan(quiet).job("/b", { keep: 3 }, () => "ok");
  });
  assert.equal(said.length, 1);
  assert.match(said[0]!, /keep.*retain/);
});

test("cache: { seconds } still keeps answers as cache: { ttl }, and warns once", async () => {
  let asked = 0;
  const said = await warnings(async () => {
    const app = inkan(quiet)
      .get("/a", { cache: { seconds: 60 } }, () => ({ n: ++asked }))
      .get("/b", { cache: { seconds: 1 } }, () => ({ n: ++asked }));
    await app.inject({ url: "/a" });
    assert.equal((await app.inject({ url: "/a" })).body.n, 1, "the second answer is the kept one");
    await app.inject({ url: "/b" });
  });
  assert.equal(said.length, 1);
  assert.match(said[0]!, /seconds.*ttl/);
});

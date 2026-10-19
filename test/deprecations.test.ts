// Old names keep working after a rename, and say so once, in development only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { buildOpenAPI, cors, inkan, plugin, t } from "../src/index.ts";

const quiet = { log: false as const, gracefulShutdown: false };

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

test("register(plugin, { prefix }) still mounts there, and warns once", async () => {
  const seen: unknown[] = [];
  const p = plugin((app, o: { prefix?: string; name?: string }) => {
    seen.push(o.prefix);
    app.get("/ping", () => ({ pong: true }));
  });
  const said = await warnings(async () => {
    const app = inkan(quiet).register(p, { prefix: "/v1" }).register(p, { prefix: "/v2" });
    await app.ready();
    assert.equal((await app.inject({ url: "/v1/ping" })).status, 200);
    assert.equal((await app.inject({ url: "/v2/ping" })).status, 200);
  });
  assert.deepEqual(seen, ["/v1", "/v2"], "the plugin still sees it among its options");
  assert.equal(said.length, 1);
  assert.match(said[0]!, /register\(plugin, \{ prefix \}\) is deprecated/);
});

test("a plugin that reads options.prefix still finds the mount prefix there, and warns once", async () => {
  const seen: unknown[] = [];
  const p = plugin((app, o: { prefix?: string }) => {
    seen.push(o.prefix, app.prefix, Object.keys(o));
  });
  const said = await warnings(async () => {
    const app = inkan(quiet).register(p, {}, { prefix: "/v1" });
    await app.ready();
  });
  assert.deepEqual(seen, ["/v1", "/v1", []]);
  assert.equal(said.length, 1);
  assert.match(said[0]!, /options\.prefix.*scope\.prefix/);
});

test("cors({ origin }) still takes one origin, a list or a function, and warns once", async () => {
  const said = await warnings(async () => {
    const one = inkan(quiet).use(cors({ origin: "https://shop.example" })).get("/x", () => ({}));
    const fn = inkan(quiet).use(cors({ origin: (o: string) => o === "https://a.example" })).get("/x", () => ({}));
    const at = (app: typeof one, origin: string) => app.inject({ url: "/x", headers: { origin } }).then((r) => r.headers["access-control-allow-origin"]);
    assert.equal(await at(one, "https://shop.example"), "https://shop.example");
    assert.equal(await at(one, "https://evil.example"), undefined);
    assert.equal(await at(fn, "https://a.example"), "https://a.example");
    assert.equal(await at(fn, "https://b.example"), undefined);
  });
  assert.equal(said.length, 1);
  assert.match(said[0]!, /cors\(\{ origin \}\) is deprecated, use cors\(\{ origins \}\)/);
});

test("the wsOrigins option still sets the WebSockets' origins, and warns once", async () => {
  let app!: ReturnType<typeof inkan>;
  const said = await warnings(() => {
    app = inkan({ ...quiet, wsOrigins: "*" });
    inkan({ ...quiet, wsOrigins: ["https://a.example"] });
  });
  assert.equal(said.length, 1);
  assert.match(said[0]!, /wsOrigins option is deprecated, use ws: \{ origins \}/);
  app.ws("/s", {}, (socket) => socket.close());
  const server = await app.listen(0, "127.0.0.1");
  try {
    const port = (server.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ port, host: "127.0.0.1", path: "/s", headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", origin: "https://evil.example" } });
      req.on("upgrade", (res, socket) => (socket.destroy(), resolve(res.statusCode!)));
      req.on("response", (res) => resolve(res.statusCode!));
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 101, "every page may open it");
  } finally {
    server.close();
  }
});

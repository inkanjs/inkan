// serveStatic: a built frontend next to the API, with the fallback a single-page app needs,
// and compress: the same answers, smaller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { compress, inkan, serveStatic, sse, t } from "../src/index.ts";

const quiet = { log: false, gracefulShutdown: false } as const;

const dist = mkdtempSync(join(tmpdir(), "inkan-static-"));
mkdirSync(join(dist, "assets"));
writeFileSync(join(dist, "index.html"), "<!doctype html><title>the app</title>");
writeFileSync(join(dist, "assets", "index-Ab12.js"), "console.log('built');".repeat(200));
writeFileSync(join(dist, "robots.txt"), "User-agent: *");
writeFileSync(join(dist, ".env"), "SECRET=1");
writeFileSync(join(tmpdir(), "inkan-outside.txt"), "outside");
test.after(() => rmSync(dist, { recursive: true, force: true }));

const site = () =>
  inkan(quiet)
    .get("/api/teas", () => [{ name: "Sencha" }])
    .register(serveStatic({ dir: dist, spa: true, exclude: ["/api"] }));

test("files come with their type and their caching", async () => {
  const app = site();
  const js = await app.inject({ url: "/assets/index-Ab12.js" });
  assert.equal(js.status, 200);
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(js.headers["cache-control"], "public, max-age=31536000, immutable", "a hashed asset is kept for good");
  assert.match(js.text, /built/);

  const robots = await app.inject({ url: "/robots.txt" });
  assert.equal(robots.headers["cache-control"], "no-cache");
  assert.equal(robots.headers["x-content-type-options"], "nosniff");

  const root = await app.inject({ url: "/" });
  assert.match(root.text, /the app/);
  assert.equal(root.headers["cache-control"], "no-cache", "the page is never taken from a cache unasked");
});

test("the API wins, the page answers every other path, and /api stays out of it", async () => {
  const app = site();
  assert.deepEqual((await app.inject({ url: "/api/teas" })).body, [{ name: "Sencha" }]);
  const deep = await app.inject({ url: "/wiki/urlaub" });
  assert.equal(deep.status, 200);
  assert.match(deep.text, /the app/);
  const typo = await app.inject({ url: "/api/tea" });
  assert.equal(typo.status, 404);
  assert.equal(typo.headers["content-type"], "application/problem+json");
  assert.equal(app.openapi().paths && Object.keys(app.openapi().paths as object).join(), "/api/teas", "the files stay out of the docs");
});

test("nothing outside the folder, no dotfiles", async () => {
  const app = inkan(quiet).register(serveStatic({ dir: dist }));
  for (const url of ["/../inkan-outside.txt", "/%2e%2e/inkan-outside.txt", "/.env", "/assets/../.env", "/%00"]) {
    assert.equal((await app.inject({ url })).status, 404, url);
  }
  assert.equal((await app.inject({ url: "/nowhere" })).status, 404, "without spa a missing file is a 404");
});

test("ETag, 304, HEAD, a prefix", async () => {
  const app = inkan(quiet).register(serveStatic({ dir: dist, prefix: "/static" }));
  const first = await app.inject({ url: "/static/robots.txt" });
  const again = await app.inject({ url: "/static/robots.txt", headers: { "if-none-match": first.headers.etag } });
  assert.equal(again.status, 304);
  assert.equal(again.text, "");
  const head = await app.inject({ method: "HEAD", url: "/static/robots.txt" });
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-length"], "13");
  assert.equal(head.text, "");
  assert.equal((await app.inject({ url: "/robots.txt" })).status, 404);
});

test("compress: brotli or gzip, as the client takes it, and only where it pays", async () => {
  const big = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: "Sencha" })) };
  const app = inkan(quiet)
    .register(compress())
    .get("/big", () => big)
    .get("/small", () => ({ ok: true }))
    .get("/picture", () => Buffer.alloc(5000))
    .get("/ticks", () =>
      sse(async function* () {
        yield { data: 1 };
      }),
    )
    .register(serveStatic({ dir: dist, prefix: "/static" }));

  const br = await app.inject({ url: "/big", headers: { "accept-encoding": "gzip, deflate, br" } });
  assert.equal(br.headers["content-encoding"], "br");
  assert.equal(br.headers.vary, "accept-encoding");
  assert.deepEqual(br.body, big, "inject unpacks it, as fetch does");

  const gz = await app.fetch(new Request("http://x/big", { headers: { "accept-encoding": "gzip" } }));
  assert.equal(gz.headers.get("content-encoding"), "gzip");
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()), big);

  assert.equal((await app.inject({ url: "/big", headers: { "accept-encoding": "br;q=0, gzip" } })).headers["content-encoding"], "gzip", "q=0 means no");
  assert.equal((await app.inject({ url: "/big" })).headers["content-encoding"], undefined, "nothing asked, nothing packed");
  assert.equal((await app.inject({ url: "/small", headers: { "accept-encoding": "br" } })).headers["content-encoding"], undefined, "too small to pay");
  assert.equal((await app.inject({ url: "/picture", headers: { "accept-encoding": "br" } })).headers["content-encoding"], undefined, "bytes are not text");
  assert.equal((await app.inject({ url: "/ticks", headers: { "accept-encoding": "br" } })).headers["content-encoding"], undefined, "an event stream goes as it is");

  const js = await app.inject({ url: "/static/assets/index-Ab12.js", headers: { "accept-encoding": "gzip" } });
  assert.equal(js.headers["content-encoding"], "gzip", "files too");
  assert.equal(js.headers["content-length"], undefined, "the old length is gone");
});

test("compress streams a streamed answer", async () => {
  const text = "stream me ".repeat(50_000);
  const app = inkan(quiet)
    .register(compress())
    .get("/long", { response: { 200: t.any() } }, (ctx) =>
      ctx.reply(
        200,
        (async function* () {
          for (let i = 0; i < 10; i++) yield text.slice(i * 50_000, (i + 1) * 50_000);
        })(),
        { "content-type": "text/plain; charset=utf-8" },
      ),
    );
  const server = await app.listen(0, "127.0.0.1");
  try {
    const { port } = server.address() as { port: number };
    const r = await fetch(`http://127.0.0.1:${port}/long`, { headers: { "accept-encoding": "br" } });
    assert.equal(r.headers.get("content-encoding"), "br");
    assert.equal(await r.text(), text, "fetch unpacks it, and it is whole");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

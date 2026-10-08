// Bodies taken as they come: t.binary() reads the bytes whole, t.stream() hands them to the
// handler unread; both with a limit of their own, through every door into the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { inkan, problem, rateLimit, t } from "../src/index.ts";
import { client } from "../src/client.ts";

const quiet = { log: false, gracefulShutdown: false } as const;
const MB = 1024 * 1024;

const build = () =>
  inkan({ ...quiet, bodyLimit: 1000 })
    .post("/pictures", { body: t.binary().max(3 * MB).accept("image/*"), response: { 201: t.object({ bytes: t.int(), type: t.string() }) } }, ({ body, headers }) => ({
      bytes: body.length,
      type: (headers as Record<string, string>)["content-type"],
    }))
    .post("/notes", { body: t.binary(), bodyLimit: 10 }, ({ body }) => ({ text: body.toString() }))
    .post("/backups", { body: t.stream().max(8 * MB) }, async ({ body }) => {
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of body) {
        bytes += chunk.length;
        hash.update(chunk);
      }
      return { bytes, sha: hash.digest("hex") };
    })
    .post("/teas", { body: t.object({ name: t.string() }) }, ({ body }) => body)
    .get("/who", (ctx) => ({ ip: ctx.ip }));

/** The status for a request that only says how large its body is: the answer comes before the body would. */
function declared(base: string, path: string, length: number) {
  return new Promise<number>((resolve, reject) => {
    const req = request(base + path, { method: "POST", headers: { "content-type": "image/png", "content-length": length } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on("error", reject);
    req.flushHeaders();
  });
}

async function listening() {
  const app = build();
  const server = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // closeAllConnections: a cut-off upload keeps its connection until the client lets go
  return { app, base, close: () => new Promise<void>((r) => (server.close(() => r()), server.closeAllConnections())) };
}

test("t.binary() takes bytes past the app's limit, up to its own", async () => {
  const { base, close } = await listening();
  try {
    const picture = Buffer.alloc(2 * MB, 7);
    const ok = await fetch(`${base}/pictures`, { method: "POST", headers: { "content-type": "image/png" }, body: picture });
    assert.equal(ok.status, 201);
    assert.deepEqual(await ok.json(), { bytes: 2 * MB, type: "image/png" });

    assert.equal(await declared(base, "/pictures", 4 * MB), 413, "its own limit holds, before a byte is read");

    const pdf = await fetch(`${base}/pictures`, { method: "POST", headers: { "content-type": "application/pdf" }, body: picture });
    assert.equal(pdf.status, 415);
    assert.match(((await pdf.json()) as { detail: string }).detail, /image\/\*/);

    const empty = await fetch(`${base}/pictures`, { method: "POST", headers: { "content-type": "image/png" } });
    assert.equal(empty.status, 400, "an empty body is no picture");

    assert.equal((await fetch(`${base}/teas`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x".repeat(2000) }) })).status, 413, "everything else keeps the app's limit");
    assert.equal((await fetch(`${base}/notes`, { method: "POST", body: "more than ten bytes" })).status, 413, "bodyLimit on the route");
  } finally {
    await close();
  }
});

test("t.stream() hands the body over unread, and stops at its limit", async () => {
  const { base, close } = await listening();
  try {
    const data = randomBytes(5 * MB);
    const r = await fetch(`${base}/backups`, { method: "POST", body: data });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { bytes: data.length, sha: createHash("sha256").update(data).digest("hex") });

    // sent in pieces, without a length: the limit is found while reading
    const pieces = new ReadableStream({
      start(c) {
        for (let i = 0; i < 9; i++) c.enqueue(new Uint8Array(MB));
        c.close();
      },
    });
    const over = await fetch(`${base}/backups`, { method: "POST", body: pieces, duplex: "half" } as RequestInit);
    assert.equal(over.status, 413);
    assert.equal(((await over.json()) as { type: string }).type, "body-too-large");
  } finally {
    await close();
  }
});

test("the same through inject, app.fetch and exchange", async () => {
  const app = build();
  const png = { "content-type": "image/png" };
  const injected = await app.inject({ method: "POST", url: "/pictures", headers: png, body: Buffer.alloc(5000) });
  assert.equal(injected.status, 201);

  const fetched = await app.fetch(new Request("http://x/pictures", { method: "POST", headers: png, body: Buffer.alloc(5000) }));
  assert.equal(fetched.status, 201);
  const streamed = await app.fetch(new Request("http://x/backups", { method: "POST", body: Buffer.alloc(3000, 1) }));
  assert.equal(((await streamed.json()) as { bytes: number }).bytes, 3000);

  assert.deepEqual(app.bodyFor("POST", "/pictures"), { limit: 3 * MB, stream: false });
  assert.deepEqual(app.bodyFor("POST", "/backups?x=1"), { limit: 8 * MB, stream: true });
  assert.deepEqual(app.bodyFor("POST", "/teas"), { limit: 1000, stream: false });
  assert.deepEqual(app.bodyFor("POST", "/nowhere"), { limit: 1000, stream: false });

  const exchanged = await app.exchange({ method: "POST", url: "/pictures", headers: png, body: Buffer.alloc(5000) });
  assert.equal(exchanged.status, 201, "exchange takes the route's limit, not the app's");
  const chunks = (async function* () {
    yield Buffer.alloc(100);
    yield new Uint8Array(50);
  })();
  const piped = await app.exchange({ method: "POST", url: "/backups", headers: {}, stream: chunks });
  assert.equal(JSON.parse(String(piped.body)).bytes, 150);
});

test("OpenAPI names the media types, and the client sends bytes as they are", async () => {
  const app = build();
  const doc = app.openapi() as { paths: Record<string, { post: { requestBody: { content: Record<string, { schema: unknown }> } } }> };
  assert.deepEqual(Object.keys(doc.paths["/pictures"].post.requestBody.content), ["image/*"]);
  assert.deepEqual(doc.paths["/backups"].post.requestBody.content["application/octet-stream"].schema, { type: "string", format: "binary", "x-max-bytes": 8 * MB });

  const api = client<typeof app>("http://x", { fetch: (url, init) => app.fetch(new Request(url, init)) });
  const blob = await api.post("/pictures", { body: new Blob([new Uint8Array(1234)], { type: "image/webp" }) });
  assert.deepEqual(blob.ok && blob.data, { bytes: 1234, type: "image/webp" });
  const bytes = await api.post("/backups", { body: new Uint8Array(77) });
  assert.equal(bytes.ok && (bytes.data as { bytes: number }).bytes, 77);
  // @ts-expect-error a binary body is bytes, not an object
  void (() => api.post("/pictures", { body: { name: "x" } }));
});

test("ctx.ip is the client's address, on a socket and on a platform", async () => {
  const { base, close } = await listening();
  try {
    assert.deepEqual(await (await fetch(`${base}/who`)).json(), { ip: "127.0.0.1" });
  } finally {
    await close();
  }
  const app = build();
  assert.deepEqual(await (await app.fetch(new Request("http://x/who"), { remote: "10.0.0.7" })).json(), { ip: "10.0.0.7" });
  assert.deepEqual(await (await app.fetch(new Request("http://x/who"))).json(), {}, "unknown is no address");

  // rateLimit counts by it, so a platform's clients are told apart too
  const limited = inkan(quiet).register(rateLimit({ max: 1 })).get("/", () => "ok");
  assert.equal((await limited.fetch(new Request("http://x/"), { remote: "10.0.0.1" })).status, 200);
  assert.equal((await limited.fetch(new Request("http://x/"), { remote: "10.0.0.2" })).status, 200);
  assert.equal((await limited.fetch(new Request("http://x/"), { remote: "10.0.0.1" })).status, 429);
});

test("an answer before the upload is read reaches the client, and the next request works", async () => {
  const app = inkan(quiet)
    .onRequest((ctx) => {
      if ((ctx.headers as Record<string, string>).authorization !== "yes") throw problem(401, "unauthorized", "Not signed in");
    })
    .post("/backups", { body: t.stream() }, async ({ body }) => {
      let bytes = 0;
      for await (const c of body) bytes += c.length;
      return { bytes };
    });
  const server = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const denied = await fetch(`${base}/backups`, { method: "POST", body: randomBytes(2 * MB) });
    assert.equal(denied.status, 401);
    const ok = await fetch(`${base}/backups`, { method: "POST", headers: { authorization: "yes" }, body: randomBytes(MB) });
    assert.deepEqual(await ok.json(), { bytes: MB });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

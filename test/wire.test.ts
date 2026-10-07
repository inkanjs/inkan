import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { inkan, sse, t } from "../src/index.ts";

type Seen = { status: number; length?: string; chunked: boolean; body: string };

function call(port: number, method: string, path: string): Promise<Seen> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () =>
        resolve({ status: res.statusCode!, length: res.headers["content-length"], chunked: res.headers["transfer-encoding"] === "chunked", body }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

test("a whole body goes out with its length, never chunked; a stream stays chunked", async () => {
  const app = inkan({ dev: false, log: false, gracefulShutdown: false })
    .get("/json", { response: { 200: t.object({ word: t.string() }) } }, () => ({ word: "wörld" }))
    .post("/nothing", () => {})
    .get("/events", () => sse(async function* () { yield { data: 1 }; }));
  const server = await app.listen(0, "127.0.0.1");
  const { port } = server.address() as { port: number };
  try {
    const json = await call(port, "GET", "/json");
    assert.deepEqual([json.status, json.length, json.chunked], [200, String(Buffer.byteLength('{"word":"wörld"}')), false]);

    const head = await call(port, "HEAD", "/json");
    assert.deepEqual([head.length, head.body], [json.length, ""], "HEAD tells the length the GET has");

    const missing = await call(port, "GET", "/nowhere");
    assert.equal(missing.chunked, false);
    assert.equal(missing.length, String(Buffer.byteLength(missing.body)));

    const none = await call(port, "POST", "/nothing");
    assert.deepEqual([none.status, none.length], [204, undefined], "a 204 has no length at all");

    const events = await call(port, "GET", "/events");
    assert.equal(events.chunked, true);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

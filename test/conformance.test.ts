// The conformance requests against the ways the core serves an app itself.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { conformance } from "./adapters/conformance.ts";

conformance("node:http (listen)", async (app) => {
  const server = await app.listen(0, "127.0.0.1");
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await app.stopped();
    },
  };
});

conformance("app.fetch", async (app) => {
  // app.fetch behind the smallest server there is, to send real requests through it
  await app.ready();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const answer = await app.fetch(new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers as HeadersInit, body }), { remote: "127.0.0.1" });
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    if (!answer.body) return void res.end();
    const reader = answer.body.getReader();
    res.on("close", () => void reader.cancel());
    for (;;) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) break;
      // backpressure, as every real server has: without it an endless stream never lets the socket breathe
      if (!res.write(value)) await new Promise((r) => res.once("drain", r).once("close", r));
    }
    res.end();
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  await app.started();
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await app.stopped();
    },
  };
});

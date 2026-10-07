// A few requests through app.fetch on whatever runtime runs this file: Bun and Deno in CI.
// Not a node:test file on purpose; it only needs a runtime that speaks Request and Response.
//
//   bun test/platforms/smoke.ts
//   deno run --allow-env --allow-read test/platforms/smoke.ts

import { inkan, sse, t } from "../../src/index.ts";

const runtime = "Bun" in globalThis ? "bun" : "Deno" in globalThis ? "deno" : "node";
const app = inkan({ log: false, gracefulShutdown: false })
  .get("/hello/:name", { params: t.object({ name: t.string() }), response: { 200: t.object({ hello: t.string() }) } }, ({ params }) => ({
    hello: params.name,
    secret: "kept back",
  }))
  .post("/teas", { body: t.object({ grams: t.int().min(1) }) }, ({ body }) => ({ grams: body.grams }))
  .get("/ticks", () =>
    sse(async function* () {
      for (let i = 0; ; i++) yield { event: "tick", data: i };
    }),
  );

const check = (what: string, ok: boolean, got: unknown) => {
  if (!ok) throw new Error(`${runtime}: ${what} failed, got ${JSON.stringify(got)}`);
  console.log(`  ✓ ${what}`);
};
const req = (path: string, init?: RequestInit) => new Request(`http://smoke.test${path}`, init);
const json = { "content-type": "application/json" };

const hello = await app.fetch(req("/hello/" + runtime));
const helloBody = await hello.json();
check("a route with typed params, trimmed to its contract", hello.status === 200 && JSON.stringify(helloBody) === JSON.stringify({ hello: runtime }), helloBody);

const bad = await app.fetch(req("/teas", { method: "POST", headers: json, body: '{"grams":0}' }));
const badBody = (await bad.json()) as { errors?: { path: string }[] };
check("a body that breaks its contract is a 400 problem", bad.status === 400 && badBody.errors?.[0]?.path === "grams", badBody);

const ok = await app.fetch(req("/teas", { method: "POST", headers: json, body: '{"grams":"5"}' }));
check("strings are not numbers in JSON bodies", ok.status === 400, ok.status);

const nf = await app.fetch(req("/nowhere"));
check("an unknown route is a 404 problem", nf.status === 404 && nf.headers.get("content-type") === "application/problem+json", nf.status);

const ticks = await app.fetch(req("/ticks"));
const reader = ticks.body!.getReader();
let text = "";
while (!text.includes("data: 1")) text += new TextDecoder().decode((await reader.read()).value);
await reader.cancel();
check("server-sent events stream and stop when the client leaves", text.includes("event: tick"), text);

console.log(`inkan runs on ${runtime}`);

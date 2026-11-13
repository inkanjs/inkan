import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, t } from "../src/index.ts";

const basic = (user: string, password: string) => "Basic " + Buffer.from(`${user}:${password}`).toString("base64");

function app(options: Parameters<typeof inkan>[0] = {}) {
  const a = inkan({ title: "Studio", version: "1.0.0", dev: true, log: false, mcp: true, ...options });
  a.get("/teas/:id", { summary: "One tea", params: t.object({ id: t.int() }), response: { 200: t.object({ id: t.int() }) } }, ({ params }) => ({ id: params.id }));
  a.post("/admin", { security: "bearer", response: { 204: t.empty() } }, ({ status }) => void status(204));
  return a;
}

test("the studio page and its JSON, on this machine", async () => {
  const a = app();
  const page = await a.inject({ url: "/_inkan" });
  assert.equal(page.status, 200);
  assert.match(page.text, /studio/);
  await a.inject({ url: "/teas/1" });
  await a.inject({ url: "/teas/x" });
  const s = (await a.inject({ url: "/_inkan/studio.json" })).body;
  assert.equal(s.app.title, "Studio");
  const tea = s.routes.find((r: { path: string }) => r.path === "/teas/:id");
  assert.equal(tea.tool, "getTeasById");
  assert.equal(tea.stats.n, 2);
  assert.equal(tea.stats.last, 400);
  assert.equal(typeof tea.stats.p95, "number");
  assert.equal(s.routes.find((r: { path: string }) => r.path === "/admin").secured, true);
  assert.equal(s.mcp.path, "/mcp");
  assert.deepEqual(s.jobs, []);
  const log = (await a.inject({ url: "/_inkan/log.json" })).body;
  assert.equal(log.length, 2);
  assert.equal((await a.inject({ url: "/_inkan/nope" })).status, 404);
});

test("from elsewhere the studio is a plain 404, unless protect lets it in", async () => {
  const open = app();
  const far = await open.exchange({ method: "GET", url: "/_inkan", headers: {}, remote: "203.0.113.9" });
  assert.equal(far.status, 404);

  const guarded = app({ protect: { user: "luis", password: "s3cret" } });
  const asked = await guarded.exchange({ method: "GET", url: "/_inkan", headers: {}, remote: "203.0.113.9" });
  assert.equal(asked.status, 401);
  assert.match(asked.headers["www-authenticate"]!, /^Basic realm="inkan"/);
  const wrong = await guarded.exchange({ method: "GET", url: "/_inkan", headers: { authorization: basic("luis", "nope") }, remote: "203.0.113.9" });
  assert.equal(wrong.status, 401);
  const right = await guarded.exchange({ method: "GET", url: "/_inkan", headers: { authorization: basic("luis", "s3cret") }, remote: "203.0.113.9" });
  assert.equal(right.status, 200);
});

test("protect guards the docs page and the OpenAPI document too, not the routes or MCP", async () => {
  const a = app({ protect: { user: "u", password: "p", realm: "Tea" } });
  for (const url of ["/docs", "/openapi.json", "/_inkan"]) {
    const no = await a.inject({ url });
    assert.equal(no.status, 401, url);
    assert.match(no.headers["www-authenticate"]!, /realm="Tea"/);
    assert.equal((await a.inject({ url, headers: { authorization: basic("u", "p") } })).status, 200, url);
  }
  assert.equal((await a.inject({ url: "/teas/1" })).status, 200);
  const mcp = await a.inject({ method: "POST", url: "/mcp", headers: { "mcp-protocol-version": "2025-11-25" }, body: { jsonrpc: "2.0", id: 1, method: "ping" } });
  assert.equal(mcp.status, 200);
});

test("protect as a function decides alone, sync or async, and a throw is a no", async () => {
  const seen: string[] = [];
  const a = app({
    protect: async (req) => {
      seen.push(req.path);
      if (req.headers["x-boom"]) throw new Error("boom");
      return req.headers["x-key"] === "k";
    },
  });
  assert.equal((await a.inject({ url: "/docs" })).status, 401);
  assert.equal((await a.inject({ url: "/docs", headers: { "x-boom": "1" } })).status, 401);
  const yes = await a.inject({ url: "/docs", headers: { "x-key": "k" } });
  assert.equal(yes.status, 200);
  assert.equal(yes.headers["www-authenticate"], undefined);
  assert.deepEqual(seen, ["/docs", "/docs", "/docs"]);
});

test("jobs: the studio lists them and cancels one, only with its own header", async () => {
  const a = app();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  a.job("/exports", { concurrency: 1, result: t.object({ ok: t.boolean() }) }, async (job) => {
    await Promise.race([gate, new Promise((_, no) => job.signal.addEventListener("abort", () => no(job.signal.reason)))]);
    return { ok: true };
  });
  const first = (await a.inject({ method: "POST", url: "/exports" })).body.id as string;
  const second = (await a.inject({ method: "POST", url: "/exports" })).body.id as string;
  let kind = (await a.inject({ url: "/_inkan/studio.json" })).body.jobs[0];
  assert.equal(kind.path, "/exports");
  assert.equal(kind.running, 1);
  assert.equal(kind.queued, 1);
  assert.deepEqual(kind.live.map((j: { id: string; state: string }) => j.state).sort(), ["queued", "running"]);

  const forged = await a.inject({ method: "POST", url: `/_inkan/jobs/cancel?kind=/exports&id=${second}` });
  assert.equal(forged.status, 403);
  const cancel = await a.inject({ method: "POST", url: `/_inkan/jobs/cancel?kind=/exports&id=${second}`, headers: { "x-inkan-studio": "1" } });
  assert.equal(cancel.status, 202);
  release();
  for (let i = 0; i < 50 && (await a.inject({ url: `/exports/${first}` })).body.state !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
  kind = (await a.inject({ url: "/_inkan/studio.json" })).body.jobs[0];
  assert.deepEqual(kind.recent.map((j: { state: string }) => j.state).sort(), ["canceled", "done"]);
  assert.equal(kind.recent.find((j: { state: string }) => j.state === "done").result, '{"ok":true}');
  await a.stopped();
});

test("off in production unless asked for, and the studio page's script parses", async () => {
  const prod = inkan({ dev: false, log: false });
  assert.equal((await prod.inject({ url: "/_inkan" })).status, 404);
  const page = (await app().inject({ url: "/_inkan" })).text;
  const [js] = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.doesNotThrow(() => new Function(js!));
});

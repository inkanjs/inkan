import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, problem, t } from "../src/index.ts";

const Tea = t.object({ id: t.int(), name: t.string(), kind: t.enum(["green", "black", "oolong"]) }).named("Tea");

function shop(options: Parameters<typeof inkan>[0] = { mcp: true }) {
  const teas: { id: number; name: string; kind: "green" | "black" | "oolong" }[] = [{ id: 1, name: "Sencha", kind: "green" }];
  const app = inkan({ title: "Tea Shop", version: "1.2.3", description: "Teas and their kinds", log: false, ...options });
  app.get(
    "/teas/:id",
    {
      summary: "One tea by its id",
      params: t.object({ id: t.int() }),
      response: { 200: Tea, 404: t.problem() },
      examples: [
        { name: "found", params: { id: 1 }, expect: { name: "Sencha" } },
        { name: "missing", params: { id: 99 }, status: 404 },
      ],
    },
    ({ params }) => {
      const tea = teas.find((x) => x.id === params.id);
      if (!tea) throw problem(404, "tea-not-found", `There is no tea with id ${params.id}`);
      return tea;
    },
  );
  app.get("/teas", { query: t.object({ kind: t.enum(["green", "black", "oolong"]).optional() }), response: { 200: t.array(Tea) } }, ({ query }) =>
    teas.filter((x) => !query.kind || x.kind === query.kind),
  );
  app.post(
    "/teas",
    { body: t.object({ name: t.string().min(1), kind: t.enum(["green", "black", "oolong"]) }), response: { 201: Tea }, security: "bearer" },
    ({ body, status }) => {
      const tea = { id: teas.length + 1, ...body };
      teas.push(tea);
      status(201);
      return tea;
    },
  );
  app.delete("/teas/:id", { params: t.object({ id: t.int() }), response: { 204: t.empty() }, mcp: { name: "remove_tea" } }, ({ status }) => {
    status(204);
  });
  app.get("/secret", { hidden: true }, () => "no");
  app.get("/internal", { mcp: false }, () => "no");
  app.get("/feed", { response: { 200: t.events({ tick: t.int() }) } }, () => undefined as never);
  app.post("/upload", { body: t.object({ file: t.file() }) }, () => "ok");
  return app;
}

const LEGACY = { "mcp-protocol-version": "2025-11-25" };
let ids = 0;

async function legacy(app: ReturnType<typeof shop>, method: string, params?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: "POST", url: "/mcp", headers: { ...LEGACY, ...headers }, body: { jsonrpc: "2.0", id: ++ids, method, ...(params ? { params } : {}) } });
}

const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
async function modern(app: ReturnType<typeof shop>, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const base: Record<string, string> = { "mcp-protocol-version": "2026-07-28", "mcp-method": method };
  if (method === "tools/call") base["mcp-name"] = String(params.name);
  return app.inject({ method: "POST", url: "/mcp", headers: { ...base, ...headers }, body: { jsonrpc: "2.0", id: ++ids, method, params: { ...params, _meta: META } } });
}

test("app.mcp() lists a tool per documented route, and says why the others are none", () => {
  const { path, tools, skipped } = shop().mcp();
  assert.equal(path, "/mcp");
  assert.deepEqual(
    tools.map((x) => x.name),
    ["getTeasById", "getTeas", "postTeas", "remove_tea"],
  );
  const one = tools[0]!;
  assert.equal(one.title, "One tea by its id");
  assert.deepEqual(one.inputSchema, { type: "object", properties: { id: { type: "integer" } }, additionalProperties: false, required: ["id"] });
  assert.equal(one.outputSchema?.type, "object");
  assert.deepEqual(one.annotations, { title: "One tea by its id", readOnlyHint: true });
  assert.match(one.description, /- found: \{"id":1\} → 200/);
  assert.match(one.description, /- missing: \{"id":99\} → 404/);
  assert.equal(tools[1]!.outputSchema, undefined, "an array is no outputSchema: the text carries it");
  assert.deepEqual(tools[2]!.inputSchema.required, ["body"]);
  assert.equal(tools[3]!.annotations?.destructiveHint, true);
  assert.deepEqual(
    skipped.map((s) => `${s.method} ${s.path}: ${s.reason}`),
    ["GET /internal: mcp: false", "GET /feed: answers with server-sent events", "POST /upload: takes files"],
  );
});

test("a path parameter and a query field of the same name go nested", () => {
  const app = inkan({ mcp: true, log: false });
  app.get("/a/:id", { params: t.object({ id: t.int() }), query: t.object({ id: t.string().optional() }) }, () => "ok");
  const [tool] = app.mcp().tools;
  assert.deepEqual(Object.keys(tool!.inputSchema.properties as object), ["params", "query"]);
  assert.deepEqual(tool!.inputSchema.required, ["params"]);
});

test("tool names are checked: one twice, or one MCP cannot carry, throws", () => {
  const twice = inkan({ mcp: true });
  twice.get("/a", { operationId: "same" }, () => "a");
  twice.get("/b", { operationId: "same" }, () => "b");
  assert.throws(() => twice.mcp(), /both the MCP tool "same"/);
  const odd = inkan({ mcp: true });
  odd.get("/a", { mcp: { name: "has spaces" } }, () => "a");
  assert.throws(() => odd.mcp(), /cannot be an MCP tool name/);
});

test("legacy: initialize, a notification, tools/list and tools/call, without a session", async () => {
  const app = shop();
  const init = await legacy(app, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.status, 200);
  assert.equal(init.headers["mcp-session-id"], undefined);
  assert.deepEqual(init.body.result, {
    protocolVersion: "2025-06-18",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "Tea Shop", version: "1.2.3" },
    instructions: "Teas and their kinds",
  });
  const note = await app.inject({ method: "POST", url: "/mcp", headers: LEGACY, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
  assert.equal(note.status, 202);
  assert.equal(note.text, "");

  const list = await legacy(app, "tools/list");
  assert.equal(list.body.result.tools.length, 4);

  const found = await legacy(app, "tools/call", { name: "getTeasById", arguments: { id: 1 } });
  assert.deepEqual(found.body.result.structuredContent, { id: 1, name: "Sencha", kind: "green" });
  assert.equal(found.body.result.isError, undefined);
  assert.equal(found.body.result._meta["dev.inkan/status"], 200);
  assert.equal(found.body.result.resultType, undefined, "legacy results carry no resultType");
});

test("a problem is a tool error with the problem as text, so the model can correct itself", async () => {
  const app = shop();
  const missing = await legacy(app, "tools/call", { name: "getTeasById", arguments: { id: 99 } });
  assert.equal(missing.status, 200);
  assert.equal(missing.body.result.isError, true);
  assert.equal(JSON.parse(missing.body.result.content[0].text).type, "tea-not-found");

  const wrong = await legacy(app, "tools/call", { name: "getTeasById", arguments: { id: "abc" } });
  assert.equal(wrong.body.result.isError, true);
  assert.equal(wrong.body.result._meta["dev.inkan/status"], 400);
  assert.match(wrong.body.result.content[0].text, /"id"|params/);

  const noPath = await legacy(app, "tools/call", { name: "getTeasById", arguments: {} });
  assert.equal(noPath.body.result.isError, true);
  assert.match(noPath.body.result.content[0].text, /"id" is missing/);
});

test("a tool call carries the caller's credentials through the route's security and hooks", async () => {
  const app = shop();
  const seen: string[] = [];
  app.onRequest((ctx) => {
    seen.push(`${ctx.method} ${ctx.path}`);
  });
  const anonymous = await legacy(app, "tools/call", { name: "postTeas", arguments: { body: { name: "Gyokuro", kind: "green" } } });
  assert.equal(anonymous.body.result.isError, true);
  assert.equal(anonymous.body.result._meta["dev.inkan/status"], 401);

  const signed = await legacy(app, "tools/call", { name: "postTeas", arguments: { body: { name: "Gyokuro", kind: "green" } } }, { authorization: "Bearer t0k" });
  assert.equal(signed.body.result._meta["dev.inkan/status"], 201);
  assert.equal(signed.body.result.structuredContent.name, "Gyokuro");
  assert.deepEqual(seen, ["POST /teas", "POST /teas"], "the hooks see the route's request, not the endpoint's");

  const filtered = await legacy(app, "tools/call", { name: "getTeas", arguments: { kind: "green" } });
  assert.equal(JSON.parse(filtered.body.result.content[0].text).length, 2);

  const gone = await legacy(app, "tools/call", { name: "remove_tea", arguments: { id: 2 } });
  assert.equal(gone.body.result._meta["dev.inkan/status"], 204);
  assert.equal(gone.body.result.content[0].text, "204 No Content");
});

test("modern: per-request _meta, resultType, serverInfo and server/discover", async () => {
  const app = shop();
  const discover = await modern(app, "server/discover");
  assert.equal(discover.status, 200);
  assert.equal(discover.body.result.resultType, "complete");
  assert.deepEqual(discover.body.result.supportedVersions, ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]);
  assert.deepEqual(discover.body.result._meta["io.modelcontextprotocol/serverInfo"], { name: "Tea Shop", version: "1.2.3" });

  const call = await modern(app, "tools/call", { name: "getTeasById", arguments: { id: 1 } });
  assert.equal(call.body.result.resultType, "complete");
  assert.equal(call.body.result.structuredContent.name, "Sencha");
  assert.equal(call.body.result._meta["dev.inkan/status"], 200);
  assert.ok(call.body.result._meta["io.modelcontextprotocol/serverInfo"]);
});

test("modern: headers have to say what the body says", async () => {
  const app = shop();
  const wrongName = await modern(app, "tools/call", { name: "getTeasById", arguments: { id: 1 } }, { "mcp-name": "getTeas" });
  assert.equal(wrongName.status, 400);
  assert.equal(wrongName.body.error.code, -32020);

  const encoded = await modern(app, "tools/call", { name: "getTeasById", arguments: { id: 1 } }, { "mcp-name": `=?base64?${Buffer.from("getTeasById").toString("base64")}?=` });
  assert.equal(encoded.status, 200);

  const noVersion = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { "mcp-method": "tools/list" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } },
  });
  assert.equal(noVersion.status, 400);
  assert.equal(noVersion.body.error.code, -32020);

  const future = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/list" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "2099-01-01" } } },
  });
  assert.equal(future.status, 400);
  assert.equal(future.body.error.code, -32022);
  assert.equal(future.body.error.data.requested, "2099-01-01");

  const noCaps = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } },
  });
  assert.equal(noCaps.status, 400);
  assert.equal(noCaps.body.error.code, -32602);

  const unknown = await modern(app, "prompts/list");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, -32601);
});

test("the endpoint: POST only, JSON only, one message, the app's own origin, off by default", async () => {
  const app = shop();
  const get = await app.inject({ url: "/mcp" });
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, "POST");
  const junk = await app.inject({ method: "POST", url: "/mcp", headers: { "content-type": "application/json" }, body: "{nope" });
  assert.equal(junk.status, 400);
  assert.equal(junk.body.error.code, -32700);
  const batch = await app.inject({ method: "POST", url: "/mcp", body: [{ jsonrpc: "2.0", id: 1, method: "ping" }] });
  assert.equal(batch.status, 400);
  const unknownTool = await legacy(app, "tools/call", { name: "nope", arguments: {} });
  assert.equal(unknownTool.body.error.code, -32602);

  const foreign = await legacy(app, "ping", undefined, { origin: "https://evil.example", host: "localhost:3000" });
  assert.equal(foreign.status, 403);
  const own = await legacy(app, "ping", undefined, { origin: "http://localhost:3000", host: "localhost:3000" });
  assert.equal(own.status, 200);
  const listed = shop({ mcp: { origins: ["https://claude.ai"] } });
  assert.equal((await legacy(listed, "ping", undefined, { origin: "https://claude.ai", host: "localhost:3000" })).status, 200);

  const off = shop({});
  assert.equal((await legacy(off, "ping")).status, 404);
  const elsewhere = shop({ mcp: { path: "/tools" } });
  assert.equal((await elsewhere.inject({ method: "POST", url: "/tools", headers: LEGACY, body: { jsonrpc: "2.0", id: 1, method: "ping" } })).status, 200);
});

test("a tool call keeps to the route's body limit, and the route sees the caller's origin", async () => {
  const app = inkan({ mcp: true, log: false });
  let origin: string | undefined;
  app.post("/notes", { body: t.object({ text: t.string() }), bodyLimit: 32 }, ({ body, headers }) => {
    origin = (headers as Record<string, string>).origin;
    return { length: body.text.length };
  });
  const call = (text: string) =>
    legacy(app as ReturnType<typeof shop>, "tools/call", { name: "postNotes", arguments: { body: { text } } }, { origin: "http://localhost:3000", host: "localhost:3000" });
  const big = await call("x".repeat(100));
  assert.equal(big.body.result.isError, true);
  assert.equal(big.body.result._meta["dev.inkan/status"], 413);
  const small = await call("hi");
  assert.equal(small.body.result._meta["dev.inkan/status"], 200);
  assert.equal(origin, "http://localhost:3000");
});

test("over a real socket too", async () => {
  const app = shop();
  const server = await app.listen({ port: 0, host: "127.0.0.1" });
  try {
    const { port } = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...LEGACY },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "getTeasById", arguments: { id: 1 } } }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { structuredContent: { name: string } } };
    assert.equal(body.result.structuredContent.name, "Sencha");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

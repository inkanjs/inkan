import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffOpenAPI, formatDiffMarkdown, inkan, t, type Change, type ChangeKind, type Schema } from "../src/index.ts";

const quiet = { log: false, gracefulShutdown: false } as const;
const app = () => inkan(quiet);
const lines = (changes: Change[]) => changes.map((c) => `${c.breaking ? "✗" : "·"} ${c.where} ${c.message}`);
const diff = (a: ReturnType<typeof app>, b: ReturnType<typeof app>) => lines(diffOpenAPI(a.openapi(), b.openapi()));

test("the same app twice: nothing to say", () => {
  const make = () => app().get("/teas/:id", { params: t.object({ id: t.int() }), response: { 200: t.object({ id: t.int() }) } }, () => ({ id: 1 }));
  assert.deepEqual(diff(make(), make()), []);
});

test("routes: gone breaks, new does not", () => {
  const a = app().get("/old", () => "x").get("/kept", () => "x");
  const b = app().get("/kept", () => "x").get("/new", () => "x");
  assert.deepEqual(diff(a, b), ["✗ GET /old is gone", "· GET /new is new"]);
});

test("request bodies may only get looser", () => {
  const a = app().post("/teas", { body: t.object({ name: t.string(), note: t.string(), grams: t.int().max(500) }) }, () => {});
  const b = app().post(
    "/teas",
    { body: t.object({ name: t.string().min(2), grams: t.int().max(1000), kind: t.string(), shelf: t.string().optional() }) },
    () => {},
  );
  assert.deepEqual(diff(a, b).sort(), [
    "· POST /teas body.note is ignored now",
    "· POST /teas body.shelf is taken now",
    "✗ POST /teas body.kind is required now",
    "✗ POST /teas body.name needs minLength 2 now",
  ].sort());
});

test("answers may only get stricter", () => {
  const a = app().get("/me", { response: { 200: t.object({ id: t.int(), name: t.string(), nick: t.string().optional() }) } }, () => ({ id: 1, name: "" }));
  const b = app().get(
    "/me",
    { response: { 200: t.object({ id: t.int(), name: t.string().optional(), mail: t.string() }) } },
    () => ({ id: 1, mail: "" }),
  );
  assert.deepEqual(diff(a, b).sort(), [
    "· GET /me the 200 answer.mail is sent now",
    "· GET /me the 200 answer.nick is no longer sent",
    "✗ GET /me the 200 answer.name may be missing now",
  ].sort());
});

test("enums: a request losing a value breaks, an answer gaining one breaks", () => {
  const route = (input: string[], output: string[]) =>
    app().post("/x", { body: t.object({ kind: t.enum(input) }), response: { 200: t.object({ state: t.enum(output) }) } }, () => ({ state: output[0] }));
  assert.deepEqual(diff(route(["a", "b"], ["on"]), route(["a", "c"], ["on", "off"])).sort(), [
    '· POST /x body.kind also takes "c" now',
    '✗ POST /x body.kind no longer takes "b"',
    '✗ POST /x the 200 answer.state may be "off" now',
  ].sort());
});

test("parameters, statuses, null and number types", () => {
  const a = app().get(
    "/list",
    {
      query: t.object({ page: t.int().optional(), size: t.int() }),
      response: { 200: t.object({ total: t.int(), avg: t.number() }), 404: t.problem() },
    },
    () => ({ total: 0, avg: 0 }),
  );
  const b = app().get(
    "/list",
    {
      query: t.object({ page: t.int(), size: t.number(), q: t.string().optional() }),
      response: { 200: t.object({ total: t.number(), avg: t.int().nullable() }), 410: t.problem() },
    },
    () => ({ total: 0, avg: 0 }),
  );
  assert.deepEqual(diff(a, b).sort(), [
    "· GET /list may answer 410 now",
    "· GET /list query size is number now, was integer",
    "· GET /list takes the query parameter q now",
    "· GET /list the 200 answer.avg is integer now, was number",
    "✗ GET /list no longer answers 404",
    "✗ GET /list the 200 answer.avg may be null now",
    "✗ GET /list the 200 answer.total is number now, was integer",
    "✗ GET /list the query parameter page is required now",
  ].sort());
});

test("recursive schemas do not loop", () => {
  type Node = { name: string; children: Node[] };
  const make = () => {
    const node: Schema<Node> = t.object({ name: t.string(), children: t.array(t.lazy(() => node)) }).named("Node");
    return app().get("/tree", { response: { 200: node } }, () => ({ name: "", children: [] }));
  };
  assert.deepEqual(diff(make(), make()), []);
});

test("inkan diff: exit 1 on a breaking change, 0 otherwise, two files or a file and an app", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "inkan-diff-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const before = join(dir, "before.json");
  const without = join(dir, "after.json");
  const doc = inkan(quiet).get("/a", () => "x").get("/b", () => "x").openapi();
  writeFileSync(before, JSON.stringify(doc));
  writeFileSync(without, JSON.stringify({ ...doc, paths: { "/a": (doc.paths as Record<string, unknown>)["/a"] } }));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["src/cli.ts", "diff", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

  const broke = run(before, without);
  assert.equal(broke.status, 1, broke.stderr);
  assert.match(broke.stdout, /✗ GET \/b {2}is gone/);
  assert.equal(run(without, before).status, 0, "adding a route is safe");

  const json = run(before, without, "--json");
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(run(before, without, "--format", "json").stdout), JSON.parse(json.stdout), "--json is --format json");
  assert.deepEqual(JSON.parse(json.stdout), [{ breaking: true, kind: "route-removed", where: "GET /b", message: "is gone" }]);

  const shop = join(dir, "shop.json");
  assert.equal(spawnSync(process.execPath, ["src/cli.ts", "openapi", "examples/shop.ts", "-o", shop], { cwd: root }).status, 0);
  assert.equal(run(shop, "examples/shop.ts").status, 0, "an app against its own document");
  assert.equal(run("only-one.json").status, 2);

  const md = run(before, without, "--format", "markdown");
  assert.equal(md.status, 1, "the exit code does not depend on the format");
  assert.ok(md.stdout.includes("**✗ 1 breaking change**"), md.stdout);
  assert.ok(md.stdout.includes("| ✗ | `GET /b` | is gone | `route-removed` |"), md.stdout);
  assert.ok(run(without, before, "--format", "markdown").stdout.includes("**✓ no breaking changes** · 1 safe change"));
  for (const bad of [["--format", "html"], ["--json", "--format", "markdown"], ["--format"], ["--nope"]]) {
    const r = run(before, without, ...bad);
    assert.equal(r.status, 2, bad.join(" "));
    assert.equal(r.stdout, "");
  }
  assert.equal(run(before, join(dir, "missing.ts")).status, 2, "an app that cannot be loaded");
});

test("every change has a kind, for machines; the message stays for people", () => {
  const op = (o: Record<string, unknown>) => ({ paths: { "/x": { post: { responses: {}, ...o } } } });
  const kinds = (a: object, b: object) => diffOpenAPI(a, b).map((c) => c.kind).sort();
  const body = (schema: object, required = false) => ({ requestBody: { required, content: { "application/json": { schema } } } });
  const answer = (schema: object) => ({ responses: { 200: { content: { "application/json": { schema } } } } });
  const param = (name: string, required: boolean, schema: object = { type: "string" }) => ({ parameters: [{ in: "query", name, required, schema }] });

  const expect: [object, object, ChangeKind[]][] = [
    [{ paths: { "/x": { get: {} } } }, { paths: { "/y": { get: {} } } }, ["route-added", "route-removed"]],
    [op({}), op(param("q", true)), ["param-added-required"]],
    [op({}), op(param("q", false)), ["param-added-optional"]],
    [op(param("q", false)), op(param("q", true)), ["param-required"]],
    [op(param("q", false)), op({}), ["param-removed"]],
    [op({}), op(body({ type: "object" }, true)), ["body-added-required"]],
    [op(body({ type: "object" })), op(body({ type: "object" }, true)), ["body-required"]],
    [op({ responses: { 200: {}, 404: {} } }), op({ responses: { 200: {}, 410: {} } }), ["status-added", "status-removed"]],
    [op(body({ anyOf: [{ type: "string" }, { type: "null" }] })), op(body({ type: "string" })), ["request-null-removed"]],
    [op(answer({ type: "string" })), op(answer({ anyOf: [{ type: "string" }, { type: "null" }] })), ["response-null-added"]],
    [op(body({ type: "string" })), op(body({ type: "boolean" })), ["request-type-changed"]],
    [op(answer({ type: "string" })), op(answer({ type: "boolean" })), ["response-type-changed"]],
    [op(body({ enum: ["a", "b"] })), op(body({ enum: ["a", "c"] })), ["request-value-added", "request-value-removed"]],
    [op(answer({ enum: ["a", "b"] })), op(answer({ enum: ["a", "c"] })), ["response-value-added", "response-value-removed"]],
    [op(body({ type: "string" })), op(body({ type: "string", enum: ["a"] })), ["request-values-restricted"]],
    [op(answer({ type: "string", enum: ["a"] })), op(answer({ type: "string" })), ["response-values-unrestricted"]],
    [op(body({ type: "string" })), op(body({ type: "string", minLength: 2, maxLength: 9 })), ["request-limit-tightened", "request-limit-tightened"]],
    [op(body({ type: "string" })), op(body({ type: "string", pattern: "^a" })), ["request-pattern-changed"]],
    [op(body({ type: "string" })), op(body({ type: "string", format: "email" })), ["request-format-changed"]],
    [op(body({ type: "object" })), op(body({ type: "object", additionalProperties: false })), ["request-extra-keys-refused"]],
    [
      op(body({ type: "object", properties: { gone: {}, later: {} } })),
      op(body({ type: "object", properties: { must: {}, may: {}, later: {} }, required: ["must", "later"] })),
      ["request-field-added-optional", "request-field-added-required", "request-field-removed", "request-field-required"],
    ],
    [
      op(answer({ type: "object", properties: { id: {}, nick: {}, name: {} }, required: ["id", "name"] })),
      op(answer({ type: "object", properties: { name: {}, mail: {} } })),
      ["response-field-added", "response-field-optional", "response-field-removed", "response-optional-field-removed"],
    ],
    [op(body({ oneOf: [{ type: "string" }] })), op(body({ oneOf: [{ type: "integer" }] })), ["request-shape-changed"]],
    [op(answer({ oneOf: [{ type: "string" }] })), op(answer({ oneOf: [{ type: "integer" }] })), ["response-shape-changed"]],
  ];
  for (const [a, b, want] of expect) assert.deepEqual(kinds(a, b), want, JSON.stringify(want));
  const seen = new Set(expect.flatMap(([, , k]) => k));
  assert.equal(seen.size, 34, "every kind there is, once at least");
  for (const c of diffOpenAPI(...(expect[0]!.slice(0, 2) as [object, object]))) {
    assert.deepEqual(Object.keys(c), ["breaking", "kind", "where", "message"], "the stable JSON shape, in this order");
  }
});

test("formatDiffMarkdown: a headline and one table, the breaking changes first", () => {
  const changes: Change[] = [
    { breaking: false, kind: "route-added", where: "GET /new", message: "is new" },
    { breaking: true, kind: "response-field-removed", where: "GET /me", message: "the 200 answer.name | x is gone" },
  ];
  const md = formatDiffMarkdown(changes, { title: "a.json → b.json" });
  assert.match(md, /^### 印 inkan diff · `a\.json → b\.json`\n\n\*\*✗ 1 breaking change\*\* · 1 safe change\n/);
  const rows = md.split("\n").filter((l) => l.startsWith("| ✗") || l.startsWith("| ·"));
  assert.deepEqual(rows, ["| ✗ | `GET /me` | the 200 answer.name \\| x is gone | `response-field-removed` |", "| · | `GET /new` | is new | `route-added` |"]);
  assert.match(formatDiffMarkdown([]), /\*\*✓ no breaking changes\*\* · nothing changed that a client could notice/);
  assert.doesNotMatch(formatDiffMarkdown([]), /\| Route/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { inkan, plugin } from "../src/index.ts";
import { routePath } from "../src/core/files.ts";

const quiet = { log: false as const };
const source = JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/index.ts")).href);

/** A routes folder on disk, from file name to module text. */
function folder(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "inkan-routes-"));
  for (const [name, text] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

const shop = folder({
  "index.ts": `export const GET = () => ({ root: true });`,
  "teas/index.ts": `import { route, t } from ${source};
const Tea = t.object({ name: t.string().min(1) });
export const GET = route({ response: { 200: t.array(Tea) } }, () => [{ name: "Sencha" }]);
export const POST = route({ body: Tea, response: { 201: Tea }, examples: [{ body: { name: "Gyokuro" } }] }, ({ body, reply }) => reply(201, body));`,
  "teas/[id].ts": `import { route, t } from ${source};
export const GET = route({ params: t.object({ id: t.int() }) }, ({ params }) => ({ id: params.id, typed: typeof params.id }));
export const DELETE = route({ params: t.object({ id: t.int() }) }, () => undefined);`,
  "files/[...rest].ts": `export const GET = ({ params }) => ({ rest: params.rest });`,
  "_helpers.ts": `throw new Error("a file starting with _ is not a route");`,
  "teas/[id].test.ts": `throw new Error("a test file is not a route");`,
  "notes.md": "not a module",
});

test("file names become paths: index, [param] and [...rest]", () => {
  assert.equal(routePath("index.ts"), "/");
  assert.equal(routePath(join("teas", "index.ts")), "/teas");
  assert.equal(routePath(join("teas", "[id].ts")), "/teas/:id");
  assert.equal(routePath(join("teas", "[id]", "reviews.mjs")), "/teas/:id/reviews");
  assert.equal(routePath(join("files", "[...rest].js")), "/files/*rest");
  assert.throws(() => routePath(join("[...rest]", "x.ts")), /has to be the last part/);
});

test("app.load reads a folder of routes, and they are routes like any other", async () => {
  const app = inkan(quiet).load(shop);
  await app.ready();
  assert.deepEqual((await app.inject({ url: "/" })).body, { root: true });
  assert.deepEqual((await app.inject({ url: "/teas" })).body, [{ name: "Sencha" }]);
  assert.equal((await app.inject({ method: "POST", url: "/teas", body: { name: "" } })).status, 400, "the contract holds");
  assert.deepEqual((await app.inject({ url: "/teas/7" })).body, { id: 7, typed: "number" });
  assert.equal((await app.inject({ method: "DELETE", url: "/teas/7" })).status, 204);
  assert.deepEqual((await app.inject({ url: "/files/a/b.txt" })).body, { rest: "a/b.txt" });
  assert.deepEqual(
    app.routes().map((r) => `${r.method} ${r.path}`),
    ["GET /files/*rest", "GET /", "GET /teas/:id", "DELETE /teas/:id", "GET /teas", "POST /teas"],
  );
  assert.ok((app.openapi().paths as Record<string, unknown>)["/teas/{id}"]);
  assert.equal((await app.check()).ok, true, "their examples run in inkan check");
});

test("load in a plugin puts the routes under its prefix; inject waits without ready()", async () => {
  const app = inkan(quiet).register(plugin((p) => void p.load(pathToFileURL(shop))), { prefix: "/v1" });
  assert.equal((await app.inject({ url: "/v1/teas" })).status, 200);
  assert.equal((await app.inject({ url: "/teas" })).status, 404);
});

test("a file that exports no route, or not a handler, says which file it is", async () => {
  const empty = folder({ "oops.ts": `export const get = () => ({});` });
  await assert.rejects(inkan(quiet).load(empty).ready(), /oops\.ts exports no route: export GET, POST, PUT, PATCH or DELETE/);
  const wrong = folder({ "bad.ts": `export const GET = 42;` });
  await assert.rejects(inkan(quiet).load(wrong).ready(), /bad\.ts: GET has to be a handler or route/);
});

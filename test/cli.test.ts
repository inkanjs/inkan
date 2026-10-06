import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckReport } from "../src/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const shop = "examples/shop.ts";

function inkan(...args: string[]) {
  const r = spawnSync(process.execPath, ["src/cli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("cli check: 0 when every example is sealed", () => {
  const r = inkan("check", shop);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /11 examples · 11 sealed/);
  assert.doesNotMatch(r.out, /\x1b\[/);
});

test("cli check --json: parses and matches the report", () => {
  const r = inkan("check", shop, "--json");
  assert.equal(r.code, 0, r.err);
  const report: CheckReport = JSON.parse(r.out);
  assert.equal(report.ok, true);
  assert.equal(report.passed, 11);
  assert.equal(report.failed, 0);
  assert.ok(Array.isArray(report.results) && Array.isArray(report.unchecked) && Array.isArray(report.uncovered));
  assert.deepEqual(Object.keys(report.results[0]).sort(), ["example", "method", "ms", "ok", "path", "problems", "status"]);
});

test("cli check: 1 when an example breaks, --only narrows the routes", () => {
  const broken = inkan("check", "test/fixtures/broken.ts");
  assert.equal(broken.code, 1);
  assert.match(broken.out, /answered 200, expected 404/);
  assert.match(broken.out, /200 is in the contract, but no example answers with it/);

  const only = inkan("check", shop, "--only", "/health", "--json");
  assert.deepEqual([...new Set(JSON.parse(only.out).results.map((x: { path: string }) => x.path))], ["/health"]);
});

test("cli check --strict: 1 when a promised status has no example", () => {
  assert.equal(inkan("check", "test/fixtures/broken.ts", "--strict").code, 1);
  const r = inkan("check", shop, "--strict", "--json");
  assert.equal(r.code, JSON.parse(r.out).uncovered.length ? 1 : 0);
});

test("cli: 2 for usage errors, with a message that says what to do", () => {
  const none = inkan("check");
  assert.equal(none.code, 2);
  assert.match(none.err, /Which file builds the app/);

  const noApp = inkan("check", "test/fixtures/no-app.ts");
  assert.equal(noApp.code, 2);
  assert.match(noApp.err, /has to export the app/);

  const unknown = inkan("frobnicate");
  assert.equal(unknown.code, 2);
  assert.match(unknown.out, /inkan check/);
});

test("cli openapi and routes", () => {
  const dir = mkdtempSync(join(tmpdir(), "inkan-cli-"));
  try {
    const file = join(dir, "openapi.json");
    const written = inkan("openapi", shop, "-o", file);
    assert.equal(written.code, 0, written.err);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(doc.openapi, "3.1.0");
    assert.ok(doc.paths["/teas/{id}"]);

    const printed = inkan("openapi", shop);
    assert.deepEqual(JSON.parse(printed.out), doc);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const routes = inkan("routes", shop);
  assert.equal(routes.code, 0);
  assert.match(routes.out, /GET\s+\/teas\/:id\s+.*3 examples/);
  assert.equal(routes.out.trim().split("\n").length, 5);
});

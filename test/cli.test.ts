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

test("cli check --format markdown: a headline, and the failed examples with what they expected", () => {
  const ok = inkan("check", shop, "--format", "markdown");
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /^### 印 inkan check · Tea Shop 1\.0\.0\n\n\*\*✓ all 11 examples pass\*\*/);

  const broken = inkan("check", "test/fixtures/broken.ts", "--format", "markdown");
  assert.equal(broken.code, 1);
  assert.ok(broken.out.includes("**✗ 1 example of 1 fails**"), broken.out);
  assert.ok(broken.out.includes("| ✗ | `GET /teas/:id` | missing | 200 | answered 200, expected 404 |"), broken.out);
  assert.ok(broken.out.includes("- `GET /teas/:id` 200"), "the promised status no example shows");
  assert.deepEqual(JSON.parse(inkan("check", shop, "--format", "json").out).passed, 11, "--format json is --json");
});

test("cli exit codes: 0 ok, 1 a failed result, 2 a usage or load error", () => {
  const dir = mkdtempSync(join(tmpdir(), "inkan-cli-"));
  try {
    // 0
    assert.equal(inkan("check", shop).code, 0);
    assert.equal(inkan("openapi", shop, "-o", join(dir, "a.json")).code, 0);
    assert.equal(inkan("diff", join(dir, "a.json"), shop).code, 0);
    // 1: the check ran and failed, or a change breaks clients
    assert.equal(inkan("check", "test/fixtures/broken.ts").code, 1);
    assert.equal(inkan("diff", join(dir, "a.json"), "test/fixtures/broken.ts", "--json").code, 1);
    // 2: nothing ran
    const usage: string[][] = [
      ["check"],
      ["check", shop, "--format", "yaml"],
      ["check", shop, "--json", "--format", "terminal"],
      ["check", shop, "--strcit"],
      ["check", shop, "--only"],
      ["check", shop, "examples/other.ts"],
      ["openapi", shop, "-o"],
      ["openapi", shop, "-o", join(dir, "no", "such", "folder", "a.json")],
      ["diff", join(dir, "a.json")],
      ["frobnicate"],
    ];
    for (const a of usage) assert.equal(inkan(...a).code, 2, a.join(" "));
    for (const command of ["check", "openapi", "routes"]) {
      const missing = inkan(command, "test/fixtures/nothing-here.ts");
      assert.equal(missing.code, 2, `${command}: no such file`);
      assert.match(missing.err, /There is no file test\/fixtures\/nothing-here\.ts/);
      const throws = inkan(command, "test/fixtures/throws.ts");
      assert.equal(throws.code, 2, `${command}: an entry that throws`);
      assert.match(throws.err, /Could not load test\/fixtures\/throws\.ts: the database URL is missing/);
    }
    assert.equal(inkan("diff", join(dir, "a.json"), "test/fixtures/throws.ts").code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli check --strict: statuses not demonstrated on purpose, by the route or the entry's `untested`", () => {
  const r = inkan("check", "test/fixtures/untested.ts", "--strict", "--json");
  assert.equal(r.code, 0, r.out + r.err);
  const report: CheckReport = JSON.parse(r.out);
  assert.deepEqual(report.uncovered, []);
  assert.deepEqual(report.untested, [
    { method: "GET", path: "/login", status: 429, reason: "a lockout takes many failed logins" },
    { method: "GET", path: "/plugin", status: 503, reason: "too many at once" },
  ]);
  const text = inkan("check", "test/fixtures/untested.ts", "--strict");
  assert.match(text.out, /429 not demonstrated, on purpose: a lockout takes many failed logins/);
  const md = inkan("check", "test/fixtures/untested.ts", "--strict", "--format", "markdown");
  assert.ok(md.out.includes("- `GET /plugin` 503: too many at once"), md.out);
});

test("cli check --mcp: every example of a tool runs again as a tool call", () => {
  const r = inkan("check", shop, "--mcp", "--json");
  assert.equal(r.code, 0, r.err);
  const report: CheckReport = JSON.parse(r.out);
  const viaMcp = report.results.filter((x) => x.via === "mcp");
  assert.ok(viaMcp.length > 0);
  assert.equal(viaMcp.length * 2, report.results.length, "the shop's routes are all tools");
  assert.ok(viaMcp.every((x) => x.ok && x.example.endsWith(" via MCP")));
});

test("cli mcp: JSON-RPC on stdin and stdout, the app's own output on stderr", () => {
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "getTeasById", arguments: { id: 1 } } },
  ];
  const r = spawnSync(process.execPath, ["src/cli.ts", "mcp", shop], {
    cwd: root,
    encoding: "utf8",
    input: lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(out.length, 3, "the notification gets no answer");
  const byId = new Map(out.map((m) => [m.id, m]));
  assert.equal(byId.get(1).result.serverInfo.name, "Tea Shop");
  assert.equal(byId.get(2).result._meta["dev.inkan/status"], 200);
  assert.equal(byId.get(null).error.code, -32700);
});

test("cli mcp: -H needs a name and a value", () => {
  const r = inkan("mcp", shop, "-H", "nocolon");
  assert.equal(r.code, 2);
  assert.match(r.err, /--header takes "name: value"/);
});

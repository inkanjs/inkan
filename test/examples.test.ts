import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { App } from "../src/index.ts";
import { copyExample, EXAMPLES, ExampleError, templatesDir } from "../src/cli/examples.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "inkan-examples-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// The templates import "@vxnsin/inkan". Here that has to be this checkout, not a release.
const source = pathToFileURL(join(root, "src/index.ts")).href;
function pointAtSource(dir: string) {
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const file = join(entry.parentPath, entry.name);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll('"@vxnsin/inkan"', JSON.stringify(source)));
  }
}

test("every template folder is listed, and every listed example has a folder", () => {
  const folders = readdirSync(templatesDir()).sort();
  assert.deepEqual(folders, EXAMPLES.map((e) => e.name).sort());
});

test("copying fills in the name and version and brings the dotfiles back", () => {
  const dir = join(scratch, "my-tea");
  const files = copyExample("tea-shop", dir, { version: "9.9.9" });
  assert.ok(files.includes(".gitignore") && !files.includes("_gitignore"));
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.name, "my-tea");
  assert.equal(pkg.dependencies["@vxnsin/inkan"], "^9.9.9");
  assert.ok(!readFileSync(join(dir, "README.md"), "utf8").includes("{{"), "no placeholder left");

  const testing = copyExample("testing", join(scratch, "t"), { version: "1.0.0" });
  assert.ok(testing.includes(".github/workflows/check.yml"));
  const deploy = copyExample("deploy", join(scratch, "d"), { version: "1.0.0" });
  assert.ok(deploy.includes(".dockerignore"));
});

test("a folder that is not empty needs --force, an unknown name is refused", () => {
  const dir = join(scratch, "busy");
  copyExample("hello", dir, { version: "1.0.0" });
  assert.throws(() => copyExample("hello", dir, { version: "1.0.0" }), ExampleError);
  assert.doesNotThrow(() => copyExample("auth", dir, { version: "1.0.0", force: true }));
  assert.ok(existsSync(join(dir, "src/auth.ts")));
  assert.throws(() => copyExample("nope", join(scratch, "x"), { version: "1.0.0" }), /no example called "nope"/);
});

// The promise in every README: `npm run check` passes. Hold each template to it, strictly.
for (const { name } of EXAMPLES) {
  test(`example "${name}": every example keeps its promise`, async () => {
    const dir = join(scratch, `check-${name}`);
    copyExample(name, dir, { version: "0.0.0" });
    pointAtSource(dir);
    process.env.INKAN_NO_LISTEN = "1"; // they call listen(); here they are only read
    const mod = await import(pathToFileURL(join(dir, "src/app.ts")).href);
    delete process.env.INKAN_NO_LISTEN;
    const app = mod.app as App;
    app.options.log = false;
    const report = await app.check({ beforeEach: mod.beforeEach, strict: true });
    const broken = report.results.filter((r) => !r.ok).map((r) => `${r.method} ${r.path} "${r.example}": ${r.problems.join("; ")}`);
    assert.deepEqual(broken, []);
    assert.deepEqual(report.unchecked, [], "every route has an example");
    assert.deepEqual(report.uncovered, [], "every promised status is shown");
  });
}

test('example "testing": its own test suite passes', () => {
  const dir = join(scratch, "suite");
  copyExample("testing", dir, { version: "0.0.0" });
  pointAtSource(dir);
  const r = spawnSync(process.execPath, ["--test", "test/contract.test.ts", "test/edges.test.ts"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("the CLI lists the examples and copies one", () => {
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [join(root, "src/cli.ts"), ...args], { cwd: scratch, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  const list = cli("examples", "--list");
  assert.equal(list.status, 0, list.stderr);
  for (const e of EXAMPLES) assert.match(list.stdout, new RegExp(e.name));

  const made = cli("examples", "hello", "from-cli");
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /hello → from-cli/);
  assert.ok(existsSync(join(scratch, "from-cli/src/app.ts")));

  const again = cli("examples", "hello", "from-cli");
  assert.equal(again.status, 2);
  assert.match(again.stderr, /not empty/);
});

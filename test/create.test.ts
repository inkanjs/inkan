import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { functionName, minorRange, npmNameProblem } from "../src/cli/create.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const version: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

function inkan(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(root, "src/cli.ts"), ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/**
 * Makes `@vxnsin/inkan` (and @types/node) resolve to this checkout, offline: a package.json
 * whose export is src/index.ts, next to a link to src/. Node follows the link to the real
 * path, outside node_modules, so it strips the types there as it does for the repo's tests.
 */
function linkInkan(dir: string) {
  const pkg = join(dir, "node_modules", "@vxnsin", "inkan");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@vxnsin/inkan", type: "module", exports: { ".": "./src/index.ts" } }));
  symlinkSync(join(root, "src"), join(pkg, "src"), "junction");
  mkdirSync(join(dir, "node_modules", "@types"), { recursive: true });
  symlinkSync(join(root, "node_modules", "@types", "node"), join(dir, "node_modules", "@types", "node"), "junction");
}

test("create plugin: a package that installs, typechecks and passes its own tests", () => {
  const tmp = mkdtempSync(join(tmpdir(), "inkan-create-"));
  try {
    const r = inkan(tmp, "create", "plugin", "inkan-quota");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /inkan-quota → inkan-quota {2}\(9 files, for inkan >=\d+\.\d+\.0 <\d+\.\d+\.0\)/);
    assert.match(r.out, /cd inkan-quota\n {2}npm install\n {2}npm test/);
    assert.match(r.out, /data\/hanko\.ts/);

    const dir = join(tmp, "inkan-quota");
    for (const f of ["package.json", "index.js", "index.d.ts", "test.ts", "README.md", "LICENSE", ".gitignore", ".github/workflows/ci.yml", "tsconfig.json"]) {
      assert.ok(existsSync(join(dir, f)), f);
    }
    const range = minorRange(version);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(pkg.name, "inkan-quota");
    assert.equal(pkg.version, "0.1.0");
    assert.equal(pkg.type, "module");
    assert.deepEqual(pkg.exports, { ".": { types: "./index.d.ts", default: "./index.js" } });
    assert.deepEqual(pkg.files, ["index.js", "index.d.ts"]);
    assert.deepEqual(pkg.keywords, ["inkan-plugin"]);
    assert.deepEqual(pkg.peerDependencies, { "@vxnsin/inkan": range });
    assert.equal(pkg.devDependencies["@vxnsin/inkan"], `^${version}`);
    assert.ok(pkg.devDependencies.typescript && pkg.devDependencies["@types/node"]);
    assert.equal(pkg.scripts.test, "node --test test.ts");
    assert.equal(pkg.scripts.typecheck, "tsc");

    const js = readFileSync(join(dir, "index.js"), "utf8");
    assert.match(js, /export function quota\(options = \{\}\)/);
    assert.ok(js.includes(`{ name: "inkan-quota", shared: true, inkan: "${range}" }`));
    assert.match(readFileSync(join(dir, "index.d.ts"), "utf8"), /export type QuotaOptions/);
    assert.match(readFileSync(join(dir, "LICENSE"), "utf8"), new RegExp(`Copyright \\(c\\) ${new Date().getFullYear()} YOUR NAME`));
    assert.match(readFileSync(join(dir, ".github/workflows/ci.yml"), "utf8"), /node: \[22, 24\][\s\S]*npm run typecheck[\s\S]*npm test/);
    assert.match(readFileSync(join(dir, "README.md"), "utf8"), /inkanjs\/inkan\.dev[\s\S]*data\/hanko\.ts/);
    for (const f of ["package.json", "index.js", "index.d.ts", "test.ts", "README.md"]) {
      assert.doesNotMatch(readFileSync(join(dir, f), "utf8"), /\{\{\w+\}\}|myPlugin|MyPlugin/, `${f} is filled in`);
    }

    linkInkan(dir);
    // without NODE_TEST_CONTEXT, which would make it report to this run instead of to stdout
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;
    const tests = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test.ts"], { cwd: dir, encoding: "utf8", env });
    assert.equal(tests.status, 0, tests.stdout + tests.stderr);
    assert.match(tests.stdout, /# pass 5\n# fail 0/);

    // inkan's sources stand in for its .d.ts here, so tsc may read .ts imports
    const tsc = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", ".", "--allowImportingTsExtensions"], { cwd: dir, encoding: "utf8" });
    assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("create plugin: a scoped name goes into a folder of its own name, or the one given", () => {
  const tmp = mkdtempSync(join(tmpdir(), "inkan-create-"));
  try {
    assert.equal(inkan(tmp, "create", "plugin", "@me/rate-cap").code, 0);
    assert.equal(JSON.parse(readFileSync(join(tmp, "rate-cap", "package.json"), "utf8")).name, "@me/rate-cap");
    assert.match(readFileSync(join(tmp, "rate-cap", "index.js"), "utf8"), /export function rateCap/);
    assert.equal(inkan(tmp, "create", "plugin", "inkan-x", "plugins/x").code, 0);
    assert.ok(existsSync(join(tmp, "plugins", "x", "index.js")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("create plugin: refuses @inkanjs/, names npm would not take, and a folder that is there", () => {
  const tmp = mkdtempSync(join(tmpdir(), "inkan-create-"));
  try {
    const scoped = inkan(tmp, "create", "plugin", "@inkanjs/quota");
    assert.equal(scoped.code, 2);
    assert.match(scoped.err, /@inkanjs scope is for the official packages/);

    const capitals = inkan(tmp, "create", "plugin", "Inkan-Quota");
    assert.equal(capitals.code, 2);
    assert.match(capitals.err, /capitals/);
    for (const [name, why] of [
      [".quota", /starts with "\."/],
      ["_quota", /starts with "_"/],
      ["my quota", /spaces/],
      ["quota!", /not a name npm takes/],
      ["@me/", /not a name npm takes/],
      ["a/b", /not a name npm takes/],
      ["fs", /keeps for itself/],
      ["node_modules", /keeps for itself/],
      ["x".repeat(215), /214/],
      ["", /needs a name/],
    ] as const) {
      assert.match(npmNameProblem(name) ?? "", why, name);
    }

    mkdirSync(join(tmp, "taken"));
    const taken = inkan(tmp, "create", "plugin", "taken");
    assert.equal(taken.code, 2);
    assert.match(taken.err, /taken is already there/);

    assert.match(inkan(tmp, "create").err, /inkan create plugin <name>/);
    assert.match(inkan(tmp, "create", "plugin").err, /Which name/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("create plugin: names, function names and ranges", () => {
  assert.equal(npmNameProblem("inkan-quota"), undefined);
  assert.equal(npmNameProblem("@me/inkan.quota~2"), undefined);
  assert.equal(functionName("inkan-quota"), "quota");
  assert.equal(functionName("@me/inkan-rate-cap"), "rateCap");
  assert.equal(functionName("quota-inkan"), "quota");
  assert.equal(functionName("inkan-delete"), "deletePlugin");
  assert.equal(functionName("3d-inkan"), "plugin3d");
  assert.equal(functionName("inkan"), "inkan");
  assert.equal(minorRange("0.7.0"), ">=0.7.0 <0.8.0");
  assert.equal(minorRange("1.12.3"), ">=1.12.0 <1.13.0");
});

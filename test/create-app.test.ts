import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allChoices,
  appFiles,
  CREATE_COMMAND,
  CREATE_PACKAGE,
  createApp,
  CreateAppError,
  detectManager,
  projectName,
  runScript,
  serverDir,
  type AppChoices,
} from "../src/cli/app.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const version: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const scratch = mkdtempSync(join(tmpdir(), "inkan-create-app-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const label = (c: AppChoices) => [c.store, c.auth ? "auth" : "no-auth", c.frontend].join("-");

/** The files a project of these choices must have, and no others. */
function expectedFiles({ store, auth, frontend }: AppChoices): string[] {
  const src = serverDir(frontend);
  const files = [".env.example", ".github/workflows/ci.yml", ".gitignore", "README.md", "package.json", "tsconfig.json", `${src}/app.ts`, `${src}/store.ts`, "test/app.test.ts"];
  if (auth) files.push(`${src}/auth.ts`, "test/auth.test.ts");
  if (frontend === "none") files.push("src/server.ts");
  if (frontend === "vite") files.push("index.html", "src/main.ts", "src/server/server.ts", "vite.config.ts");
  if (frontend === "next") files.push("app/api/[...path]/route.ts", "app/layout.tsx", "app/page.tsx");
  void store;
  return files.sort((a, b) => (a < b ? -1 : 1));
}

const STORE_DEPS: Record<string, string[]> = {
  memory: [],
  postgres: ["@inkanjs/postgres", "pg"],
  redis: ["@inkanjs/redis", "redis"],
  mongo: ["@inkanjs/mongo", "mongodb"],
  mysql: ["@inkanjs/mysql", "mysql2"],
};

test("create app: every combination has its files, its dependencies, and nothing left to fill in", () => {
  const combos = allChoices();
  assert.equal(combos.length, 5 * 2 * 3);
  for (const choices of combos) {
    const files = appFiles("my-api", choices, { version: "9.9.9" });
    const name = label(choices);
    assert.deepEqual(Object.keys(files), expectedFiles(choices), name);
    for (const [file, text] of Object.entries(files)) {
      assert.doesNotMatch(text, /\{\{\w+\}\}/, `${name}: ${file} is filled in`);
      assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"), `${name}: ${file} ends in one newline`);
    }
    const pkg = JSON.parse(files["package.json"]!);
    assert.equal(pkg.name, "my-api");
    assert.equal(pkg.type, "module");
    assert.equal(pkg.dependencies["@vxnsin/inkan"], "^9.9.9");
    const deps = Object.keys(pkg.dependencies);
    for (const d of STORE_DEPS[choices.store]!) assert.ok(deps.includes(d), `${name} depends on ${d}`);
    for (const other of Object.keys(STORE_DEPS).filter((s) => s !== choices.store)) {
      for (const d of STORE_DEPS[other]!) assert.ok(!deps.includes(d), `${name} leaves out ${d}`);
    }
    assert.equal(deps.includes("@inkanjs/auth"), choices.auth, `${name}: auth`);
    assert.equal(deps.includes("next"), choices.frontend === "next", `${name}: next`);
    assert.equal("vite" in (pkg.devDependencies ?? {}), choices.frontend === "vite", `${name}: vite`);
    assert.deepEqual(deps, [...deps].sort(), `${name}: dependencies in order`);
    const src = serverDir(choices.frontend);
    assert.equal(pkg.scripts.check, `inkan check ${src}/app.ts${choices.auth ? "" : " --strict"}`);
    assert.equal(pkg.scripts.test, 'node --env-file-if-exists=.env --test "test/**/*.test.ts"');
    if (choices.frontend !== "none") assert.ok(pkg.scripts.build, `${name}: a build`);

    const app = files[`${src}/app.ts`]!;
    const prefix = choices.frontend === "none" ? "" : "/api";
    assert.ok(app.includes(`"${prefix}/notes/:id"`), `${name}: routes under "${prefix}"`);
    assert.equal(app.includes('docs: "/api/docs"'), prefix === "/api");
    assert.equal(app.includes("security: login.session"), choices.auth);
    assert.match(app, /app\.onClose\(closeStore\);\n$/);

    const ci = files[".github/workflows/ci.yml"]!;
    assert.equal(/services:/.test(ci), choices.store !== "memory", `${name}: a database in CI`);
    assert.equal(ci.includes("npm run build"), choices.frontend !== "none");
    const env = files[".env.example"]!;
    assert.equal(env.includes("AUTH_SECRET="), choices.auth);
  }
});

test("create app: the README says what was chosen and how to run it", () => {
  const readme = appFiles("shop", { store: "postgres", auth: true, frontend: "vite" }, { version: "1.0.0", pm: "pnpm" })["README.md"]!;
  assert.match(readme, /^# shop\n/);
  assert.match(readme, /PostgreSQL, through `@inkanjs\/postgres`/);
  assert.match(readme, /Logins and sessions come from `@inkanjs\/auth`/);
  assert.match(readme, /The frontend is Vite/);
  assert.match(readme, /pnpm install\npnpm dev +# then open http:\/\/localhost:5173\/api\/docs/);
  assert.match(readme, /cp \.env\.example \.env/);
  assert.match(readme, /`DELETE \/api\/notes\/:id`/);
});

test("create app: names, package managers and the create package", () => {
  assert.equal(projectName("some/where/My App"), "my-app");
  assert.equal(runScript("npm", "dev"), "npm run dev");
  assert.equal(runScript("npm", "test"), "npm test");
  assert.equal(runScript("pnpm", "dev"), "pnpm dev");
  assert.equal(runScript("bun", "check"), "bun run check");
  assert.equal(detectManager("pnpm/9.1.0 npm/? node/v24.0.0 linux x64"), "pnpm");
  assert.equal(detectManager("yarn/4.0.0 npm/? node/v24"), "yarn");
  assert.equal(detectManager(""), "npm");
  assert.equal(detectManager("deno/2"), "npm");

  // create/ is the package behind `npm create inkan`: same name as the constant, same version as inkan
  const pkg = JSON.parse(readFileSync(join(root, "create", "package.json"), "utf8"));
  assert.equal(pkg.name, CREATE_PACKAGE);
  assert.equal(pkg.version, version);
  assert.deepEqual(pkg.dependencies, { "@vxnsin/inkan": version });
  assert.deepEqual(Object.keys(pkg.bin), [CREATE_PACKAGE.replace(/^@[^/]+\//, "")]);
  assert.equal(CREATE_COMMAND, CREATE_PACKAGE.startsWith("@") ? "npm init @inkanjs" : "npm create inkan");
  assert.ok(readFileSync(join(root, "create", "index.js"), "utf8").includes('"create", "app"'));
});

function cli(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(root, "src/cli.ts"), "create", "app", ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test("create app: the CLI takes flags, and without a terminal the defaults", () => {
  const plain = cli(scratch, "plain", "--no-install");
  assert.equal(plain.code, 0, plain.err);
  assert.match(plain.out, /plain → plain {2}\(memory, 10 files\)/);
  assert.match(plain.out, /cd plain\n {2}npm install\n {2}npm run dev/);
  assert.ok(existsSync(join(scratch, "plain", "src", "store.ts")));

  const full = cli(scratch, "full", "--store=redis", "--auth", "--frontend", "next", "--pm", "pnpm", "--no-install", "--yes");
  assert.equal(full.code, 0, full.err);
  assert.match(full.out, /\(redis \+ auth \+ next, 14 files\)/);
  assert.match(full.out, /pnpm install\n.*\n {2}pnpm dev/);
  assert.ok(existsSync(join(scratch, "full", "server", "auth.ts")));

  const fallback = cli(join(scratch, "plain"), "--no-install", "--force"); // no folder: inkan-app
  assert.equal(fallback.code, 0, fallback.err);
  assert.ok(existsSync(join(scratch, "plain", "inkan-app", "package.json")));

  const again = cli(scratch, "plain", "--no-install");
  assert.equal(again.code, 2);
  assert.match(again.err, /plain is not empty/);
  assert.match(cli(scratch, "x", "--store", "sqlite").err, /--store takes one of memory, postgres, redis, mongo, mysql, not "sqlite"/);
  assert.match(cli(scratch, "x", "--frontend").err, /--frontend takes one of none, next, vite\./);
  assert.match(cli(scratch, "x", "--typo").err, /There is no option --typo/);
  // the folder's name becomes the package's, lower case and without spaces, if npm takes it
  assert.match(cli(scratch, "My App", "--no-install").out, /my-app → My App/);
  assert.match(cli(scratch, "_hidden", "--no-install").err, /starts with "_".*becomes the package name/);
  assert.match(cli(scratch, "--help").out, /--store <s> +memory \| postgres/);
  assert.throws(() => createApp(join(scratch, "node_modules"), { store: "memory", auth: false, frontend: "none" }, { version }), CreateAppError);
});

// ----- the TypeScript of every combination compiles -----

/**
 * Packages the templates import, as declarations of just what they use, so the projects
 * compile here without installing them. The CI job "create-app" installs the real ones.
 */
const STUBS: Record<string, { exports?: Record<string, string>; files: Record<string, string> }> = {
  pg: { files: { "index.d.ts": "declare class Pool { constructor(config?: { connectionString?: string }); end(): Promise<void>; }\ndeclare const pg: { Pool: typeof Pool };\nexport default pg;\n" } },
  redis: { files: { "index.d.ts": "export declare function createClient(options?: { url?: string }): { connect(): Promise<unknown>; close(): Promise<void>; on(event: 'error', fn: (err: Error) => void): unknown };\n" } },
  mongodb: { files: { "index.d.ts": "export declare class MongoClient { constructor(url: string); connect(): Promise<MongoClient>; db(name?: string): { collection(name: string): unknown }; close(): Promise<void>; }\n" } },
  mysql2: { exports: { "./promise": "./promise.d.ts" }, files: { "promise.d.ts": "declare const mysql: { createPool(uri: string): { end(): Promise<void> } };\nexport default mysql;\n" } },
  "@inkanjs/auth": {
    files: {
      "index.d.ts": `import type { Plugin, Security, Store } from "@vxnsin/inkan";
type Awaitable<T> = T | Promise<T>;
export interface AuthUser { id: string | number; roles?: readonly string[]; passwordHash?: string | null }
export declare function hashPassword(password: string): Promise<string>;
export declare function auth<U extends AuthUser>(options: { secret: string; users: { find(login: string): Awaitable<U | null | undefined>; byId(id: any): Awaitable<U | null | undefined> }; store?: Store; example?: { login: string; password: string } }): Plugin<{}, any, { user: U | undefined }, {}> & { readonly session: Security };
`,
    },
  },
};
for (const db of ["postgres", "redis", "mongo", "mysql"]) {
  STUBS[`@inkanjs/${db}`] = { files: { "index.d.ts": `import type { Store } from "@vxnsin/inkan";\nexport declare function ${db}Store(db: unknown, options?: { prefix?: string }): Store & { close(): Promise<void> };\n` } };
}

/** @vxnsin/inkan as this checkout (its sources stand in for the .d.ts), @types/node from here, and the stubs. */
function linkPackages(dir: string) {
  const inkan = join(dir, "node_modules", "@vxnsin", "inkan");
  mkdirSync(inkan, { recursive: true });
  const exports = { ".": "./src/index.ts", "./client": "./src/client.ts", "./testing": "./src/testing.ts" };
  writeFileSync(join(inkan, "package.json"), JSON.stringify({ name: "@vxnsin/inkan", type: "module", exports }));
  symlinkSync(join(root, "src"), join(inkan, "src"), "junction");
  mkdirSync(join(dir, "node_modules", "@types"), { recursive: true });
  symlinkSync(join(root, "node_modules", "@types", "node"), join(dir, "node_modules", "@types", "node"), "junction");
  for (const [name, stub] of Object.entries(STUBS)) {
    const at = join(dir, "node_modules", ...name.split("/"));
    mkdirSync(at, { recursive: true });
    const exports = { ".": "./index.d.ts", ...stub.exports };
    writeFileSync(join(at, "package.json"), JSON.stringify({ name, type: "module", exports: Object.fromEntries(Object.entries(exports).map(([k, v]) => [k, { types: v }])) }));
    for (const [file, text] of Object.entries(stub.files)) writeFileSync(join(at, file), text);
  }
}

function tsc(dir: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.check.json"], { cwd: dir });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("create app: the TypeScript of every combination compiles", async () => {
  const dirs = allChoices().map((choices) => {
    const dir = join(scratch, "tsc", label(choices));
    createApp(dir, choices, { version });
    linkPackages(dir);
    // the API and its tests. The frontends' files need the real React, Next and Vite, and
    // inkan's sources (standing in for its .d.ts here) compile without the DOM's types:
    // the CI job "create-app" builds those
    const include = [serverDir(choices.frontend), "test"];
    const compilerOptions = { types: ["node"], plugins: [], incremental: false, paths: {}, lib: ["es2023"] };
    writeFileSync(join(dir, "tsconfig.check.json"), JSON.stringify({ extends: "./tsconfig.json", compilerOptions, include }));
    return dir;
  });
  const failures: string[] = [];
  for (let i = 0; i < dirs.length; i += 6) {
    const results = await Promise.all(dirs.slice(i, i + 6).map(tsc));
    results.forEach((r, j) => r.code !== 0 && failures.push(`${dirs[i + j]}:\n${r.out}`));
  }
  assert.deepEqual(failures, []);
});

// ----- the projects keep their promises -----

/** A memory project, with @vxnsin/inkan linked to this checkout: it runs without installing anything. */
function runnable(choices: AppChoices, name: string) {
  const dir = join(scratch, "run", name);
  createApp(dir, choices, { version });
  const inkan = join(dir, "node_modules", "@vxnsin", "inkan");
  mkdirSync(inkan, { recursive: true });
  writeFileSync(join(inkan, "package.json"), JSON.stringify({ name: "@vxnsin/inkan", type: "module", exports: { ".": "./src/index.ts" } }));
  symlinkSync(join(root, "src"), join(inkan, "src"), "junction");
  return dir;
}

test("create app: a new project passes inkan check --strict and its own tests", () => {
  const dir = runnable({ store: "memory", auth: false, frontend: "none" }, "memory-plain");
  const check = spawnSync(process.execPath, [join(root, "src/cli.ts"), "check", "src/app.ts", "--strict"], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /5 examples · \d+ sealed\n/);

  // without NODE_TEST_CONTEXT, which would make it report to this run instead of to stdout
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const tests = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/app.test.ts"], { cwd: dir, encoding: "utf8", env });
  assert.equal(tests.status, 0, tests.stdout + tests.stderr);
  assert.match(tests.stdout, /# pass 3\n# fail 0/);
});

test("create app: with Vite, the API sits under /api and keeps its promises there", () => {
  const dir = runnable({ store: "memory", auth: false, frontend: "vite" }, "memory-vite");
  const check = spawnSync(process.execPath, [join(root, "src/cli.ts"), "check", "src/server/app.ts", "--strict"], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /GET {4}\/api\/notes\/:id/);
});

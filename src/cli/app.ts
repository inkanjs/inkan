// `inkan create app [folder]`, and `npm create inkan` in front of it: a project to build
// on, not an example to read. A base and overlays from templates/app (a store, auth, a
// frontend) instead of one template per combination; src/app.ts is written here, since it
// is the one file every choice changes.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { paint } from "../core/color.ts";
import { RENAME, templatesDir, walk } from "./examples.ts";
import { npmNameProblem } from "./create.ts";

/**
 * The package behind `npm create inkan` (in create/ of this repository). If npm will not
 * have the name, "@inkanjs/create" works the same, as `npm init @inkanjs`: change it here
 * and in create/package.json.
 */
export const CREATE_PACKAGE = "create-inkan";

/** What people type to run it: `npm create inkan`, or `npm init @inkanjs` for a scoped one. */
export const CREATE_COMMAND = CREATE_PACKAGE.startsWith("@")
  ? `npm init ${CREATE_PACKAGE.replace(/\/create$/, "")}`
  : `npm create ${CREATE_PACKAGE.replace(/^create-/, "")}`;

export const STORES = ["memory", "postgres", "redis", "mongo", "mysql"] as const;
export const FRONTENDS = ["none", "next", "vite"] as const;
export const MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
export type StoreKind = (typeof STORES)[number];
export type Frontend = (typeof FRONTENDS)[number];
export type Manager = (typeof MANAGERS)[number];

export type AppChoices = { store: StoreKind; auth: boolean; frontend: Frontend };
export const DEFAULT_CHOICES: AppChoices = { store: "memory", auth: false, frontend: "none" };

/** What the prompts and `--help` say about each choice. */
export const STORE_INFO: Record<StoreKind, string> = {
  memory: "in this process, nothing to install (swap it later)",
  postgres: "@inkanjs/postgres on pg",
  redis: "@inkanjs/redis on node-redis",
  mongo: "@inkanjs/mongo on the mongodb driver",
  mysql: "@inkanjs/mysql on mysql2",
};
export const FRONTEND_INFO: Record<Frontend, string> = {
  none: "an API on its own",
  next: "Next.js, the API under /api through @inkanjs/next",
  vite: "Vite, the API inside its dev server through @inkanjs/vite",
};

// A database for the generated CI workflow: a service container and the variable that points at it.
const SERVICES: Record<Exclude<StoreKind, "memory">, { service: string; env: string }> = {
  postgres: {
    env: "DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres",
    service: `postgres:
        image: postgres:17
        env:
          POSTGRES_PASSWORD: postgres
        ports: ["5432:5432"]
        options: --health-cmd "pg_isready -U postgres" --health-interval 2s --health-timeout 5s --health-retries 30`,
  },
  redis: {
    env: "REDIS_URL: redis://localhost:6379",
    service: `redis:
        image: redis:7
        ports: ["6379:6379"]
        options: --health-cmd "redis-cli ping" --health-interval 2s --health-timeout 5s --health-retries 30`,
  },
  mongo: {
    env: "MONGO_URL: mongodb://localhost:27017/app",
    service: `mongo:
        # mongo:8 refuses to start on Linux 6.19 to 7.0.13, which the GitHub runners have
        image: mongo:7
        ports: ["27017:27017"]
        options: --health-cmd "mongosh --quiet --eval 'db.runCommand({ping:1})'" --health-interval 2s --health-timeout 5s --health-retries 30`,
  },
  mysql: {
    env: "MYSQL_URL: mysql://root:root@localhost:3306/app",
    service: `mysql:
        image: mysql:8.4
        env:
          MYSQL_ROOT_PASSWORD: root
          MYSQL_DATABASE: app
        ports: ["3306:3306"]
        options: --health-cmd "mysqladmin ping -h 127.0.0.1 -proot" --health-interval 2s --health-timeout 5s --health-retries 30`,
  },
};

export class CreateAppError extends Error {}

/** Where the API's own files go: next to the frontend's, not among them. */
export const serverDir = (frontend: Frontend) => (frontend === "next" ? "server" : frontend === "vite" ? "src/server" : "src");
const prefixOf = (frontend: Frontend) => (frontend === "none" ? "" : "/api");

/** `my app` → `my-app`: the folder's name as an npm name, if it can be one. */
export function projectName(dir: string): string {
  return basename(resolve(dir)).toLowerCase().replace(/\s+/g, "-");
}

/** `npm run dev`, `pnpm dev`, …: how each package manager runs a script. */
export function runScript(pm: Manager, script: string): string {
  if (pm === "npm") return script === "test" || script === "start" ? `npm ${script}` : `npm run ${script}`;
  // `bun test` is bun's own test runner, and yarn 1 has a `yarn check` of its own
  if (pm === "bun" || pm === "yarn") return `${pm} run ${script}`;
  return `${pm} ${script}`;
}

/** The package manager that runs this, from npm_config_user_agent (`pnpm/9.1.0 npm/? node/…`), else npm. */
export function detectManager(agent = process.env.npm_config_user_agent ?? ""): Manager {
  const name = agent.split("/")[0];
  return (MANAGERS as readonly string[]).includes(name) ? (name as Manager) : "npm";
}

type Merged = Record<string, unknown> & { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };

function mergePackage(into: Merged, add: Merged): Merged {
  const out: Merged = { ...into };
  for (const [k, v] of Object.entries(add)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object") out[k] = { ...(out[k] as object), ...v };
    else out[k] = v;
  }
  for (const k of ["dependencies", "devDependencies"] as const) {
    const deps = out[k];
    if (deps) out[k] = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  return out;
}

/**
 * Every file of the project, by its path in it, for these choices. Nothing is written;
 * `createApp` writes what this returns.
 */
export function appFiles(name: string, choices: AppChoices, opts: { version: string; pm?: Manager }): Record<string, string> {
  const { store, auth, frontend } = choices;
  const pm = opts.pm ?? "npm";
  const src = serverDir(frontend);
  const prefix = prefixOf(frontend);
  const root = join(templatesDir(), "app");
  const layers = ["base", `store-${store}`, ...(auth ? ["auth"] : []), ...(frontend === "none" ? [] : [`frontend-${frontend}`])];

  const files = new Map<string, string>();
  let pkg: Merged = {};
  for (const layer of layers) {
    const from = join(root, layer);
    const isFrontend = layer.startsWith("frontend-");
    for (const file of walk(from)) {
      let rel = relative(from, file).split(sep).map((part) => RENAME[part] ?? part).join("/");
      // the API's files move with the frontend; the frontend's own stay where they are
      if (!isFrontend && rel.startsWith("src/")) rel = `${src}/${rel.slice(4)}`;
      if (frontend === "next" && rel === `${src}/server.ts`) continue; // next start serves it
      const text = readFileSync(file, "utf8");
      if (rel === "package.json") pkg = mergePackage(pkg, JSON.parse(text));
      else if ((rel === ".gitignore" || rel === ".env.example") && files.has(rel)) files.set(rel, files.get(rel)! + (rel === ".env.example" ? "\n" : "") + text);
      else files.set(rel, text);
    }
  }
  files.set("package.json", JSON.stringify(pkg, null, 2) + "\n");
  files.set(`${src}/app.ts`, appSource(name, choices));

  const db = store === "memory" ? undefined : SERVICES[store];
  const services = db ? `    services:\n      ${db.service}\n    env:\n      ${db.env}\n` : "";
  const build = frontend === "none" ? "" : `      - run: ${runScript(pm, "build")}\n`;
  const fill: Record<string, string> = {
    name,
    version: opts.version,
    src,
    prefix,
    services,
    build,
    ciSetup: ciSetup(pm),
    ciInstall: `${pm} install`,
    ciTypecheck: runScript(pm, "typecheck"),
    ciCheck: runScript(pm, "check"),
    ciTest: runScript(pm, "test"),
    stack: stackLine(choices),
    commands: commands(choices, pm),
    layout: layout(choices),
    checkTest: checkTest(choices),
    untestedImport: auth ? ", untested" : "",
    production:
      frontend === "next"
        ? `// \`next build\` loads this file to collect the routes, with NODE_ENV=production but without
// the secrets of a running server: only \`next start\` is production here.
const production = process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build";`
        : `const production = process.env.NODE_ENV === "production";`,
  };
  const out: Record<string, string> = {};
  for (const [rel, text] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out[rel] = text.replace(/\{\{(\w+)\}\}/g, (all, key: string) => fill[key] ?? all).replace(/\s+$/, "\n");
  }
  return out;
}

/**
 * The steps of the generated CI workflow that set up the package manager. Node is there for
 * every one: the scripts run `node` and `inkan`, whoever installs.
 */
export function ciSetup(pm: Manager): string {
  const node = "      - uses: actions/setup-node@v5\n        with:\n          node-version: 24\n";
  if (pm === "pnpm") return "      - uses: pnpm/action-setup@v4\n        with:\n          version: 10\n" + node;
  if (pm === "yarn") return node + "      - run: corepack enable\n"; // the yarn of package.json's packageManager, if it names one
  if (pm === "bun") return node + "      - uses: oven-sh/setup-bun@v2\n";
  return node;
}

function stackLine({ store, auth, frontend }: AppChoices): string {
  const db = { postgres: "PostgreSQL", redis: "Redis", mongo: "MongoDB", mysql: "MySQL" } as const;
  return [
    store === "memory" ? "The data lives in memory, in `memoryStore()`, until you pick a database." : `The data lives in ${db[store]}, through \`@inkanjs/${store}\`.`,
    ...(auth ? ["Logins and sessions come from `@inkanjs/auth`."] : []),
    ...(frontend === "none" ? [] : [`The frontend is ${frontend === "next" ? "Next.js" : "Vite"}; the API answers under \`/api\` on the same port.`]),
  ].join(" ");
}

// @inkanjs/auth 0.2 promises statuses on its routes that no single example can show, and does
// not say so itself: the app says it for them, as `export const untested`, which `inkan check`
// reads like `beforeEach`. Once the plugin marks them on its routes (`RouteSpec.untested`),
// the export changes nothing and can go.
function untestedSource(p: string): string {
  return `
// \`inkan check --strict\` fails on a status the contract promises and no example shows. The
// auth plugin promises a few that no single example can: these, and only these, may stay unshown.
export const untested = {
  "POST ${p}/auth/login": {
    403: "a login from another site",
    429: "a lockout after many failed logins",
    503: "too many password checks at once",
  },
  "POST ${p}/auth/logout": { 403: "a logout from another site" },
};
`;
}

function checkTest({ auth }: AppChoices): string {
  return `// 1. Every example in the app, run as a test. \`strict\` also fails when the contract
//    promises a status that no example shows${auth ? " (but for the few in `untested`, see app.ts)" : ""}.
test("every example keeps its promise", async () => {
  const report = await app.check({ beforeEach, ${auth ? "untested, " : ""}strict: true });
  assert.ok(report.ok, formatReport(report));
});`;
}

function commands({ store, frontend }: AppChoices, pm: Manager): string {
  const r = (s: string) => runScript(pm, s);
  const docs = frontend === "vite" ? "http://localhost:5173/api/docs" : frontend === "next" ? "http://localhost:3000/api/docs" : "http://localhost:3000/docs";
  const lines = [
    ...(store === "memory" ? [] : ["cp .env.example .env   # then point it at your database"]),
    `${pm} install`,
    `${r("dev")}`.padEnd(22) + ` # then open ${docs}`,
    `${r("check")}`.padEnd(22) + " # every example, run as a test, --strict",
    `${r("test")}`.padEnd(22) + " # the tests in test/",
    ...(frontend === "none" ? [] : [`${r("build")}`.padEnd(22) + " # the frontend, for production"]),
  ];
  return lines.join("\n");
}

function layout({ auth, frontend }: AppChoices): string {
  const src = serverDir(frontend);
  const lines = [
    `- [${src}/app.ts](${src}/app.ts) builds the app and exports it, without listening: every route, its contract and its examples.`,
    `- [${src}/store.ts](${src}/store.ts) is where the data lives. Swap the store here; nothing else changes.`,
    ...(auth ? [`- [${src}/auth.ts](${src}/auth.ts) logs people in. Replace the Map with your users table.`] : []),
    ...(frontend === "next"
      ? ["- [app/api/[...path]/route.ts](app/api/[...path]/route.ts) hands every request under /api to the app; [app/page.tsx](app/page.tsx) asks it directly, typed."]
      : frontend === "vite"
        ? [`- [src/main.ts](src/main.ts) calls the API with the typed client; [vite.config.ts](vite.config.ts) runs the API inside Vite. [${src}/server.ts](${src}/server.ts) serves both in production.`]
        : [`- [${src}/server.ts](${src}/server.ts) is the only file that opens a port.`]),
    `- [test/](test) runs every example as a test (\`app.check\`) and the cases examples are not for (\`app.inject\`).`,
  ];
  return lines.join("\n");
}

/** src/app.ts for these choices. */
export function appSource(name: string, { auth, frontend }: AppChoices): string {
  const p = prefixOf(frontend);
  // with auth, writing takes the session cookie: these examples log in first (with the auth
  // plugin's own example), and say they come from the app's pages, as a browser does (CSRF)
  const after = auth ? `after: "POST ${p}/auth/login > a known login", headers: { "sec-fetch-site": "same-origin" }, ` : "";
  const putExamples = [
    ...(auth ? [`{ name: "without logging in", params: { id: "groceries" }, body: { text: "oat milk, tea" }, status: 401 }`] : []),
    `{ name: "saved", ${after}params: { id: "groceries" }, body: { text: "oat milk, tea" }, expect: { id: "groceries" } }`,
    `{ name: "an empty text", ${after}params: { id: "groceries" }, body: { text: "   " }, status: 400 }`,
  ];
  const options = [`title: ${JSON.stringify(name)}`, `version: "0.1.0"`, ...(p ? [`docs: "${p}/docs"`, `openapi: "${p}/openapi.json"`, `inspector: "${p}/_inkan"`] : [])];
  const who = frontend === "next" ? "the tests and Next.js (app/api/[...path]/route.ts)" : `the tests and ${serverDir(frontend)}/server.ts`;
  return `import { inkan, problem, t } from "@vxnsin/inkan";
import type { Infer } from "@vxnsin/inkan";
${auth ? `import { login } from "./auth.ts";\n` : ""}import { closeStore, store } from "./store.ts";

// 1. This file builds the app and exports it. It does not listen: \`inkan check\`,
//    ${who} import it.

const Note = t.object({ id: t.string(), text: t.string() }).named("Note");
type Note = Infer<typeof Note>;
const NoteId = t.string().pattern(/^[a-z0-9-]{1,64}$/).describe("Lower case letters, digits and dashes");
const MONTH = 30 * 24 * 60 * 60 * 1000; // a Store's TTLs are in milliseconds

// 2. Puts back what the examples count on. \`inkan check\` and the tests run it before every example.
export async function beforeEach() {
  await store.set("note:welcome", { id: "welcome", text: "Hello from ${name}" }, MONTH);
}
${auth ? untestedSource(p) : ""}
export const app = inkan({ ${options.join(", ")} })
${auth ? `  // 3. Logins: ${p}/auth/login, ${p}/auth/logout and ${p}/auth/me, and \`security: login.session\` on a route.\n  .register(login${p ? `, {}, { prefix: "${p}" }` : ""})\n` : ""}  .get(
    "${p}/health",
    {
      summary: "Is it up",
      response: { 200: t.object({ ok: t.boolean() }) },
      examples: [{ name: "up", expect: { ok: true } }],
    },
    () => ({ ok: true }),
  )
  .get(
    "${p}/notes/:id",
    {
      summary: "Read a note",
      params: t.object({ id: NoteId }),
      response: { 200: Note, 404: t.problem() },
      examples: [
        { name: "found", params: { id: "welcome" }, expect: { text: "Hello from ${name}" } },
        { name: "missing", params: { id: "nothing-here" }, status: 404 },
      ],
    },
    async ({ params }) => {
      const note = await store.get<Note>(\`note:\${params.id}\`);
      if (!note) throw problem(404, "note-not-found", \`There is no note "\${params.id}"\`);
      return note;
    },
  )
  .put(
    "${p}/notes/:id",
    {
      summary: "Write a note",${auth ? `\n      security: login.session,` : ""}
      params: t.object({ id: NoteId }),
      body: t.object({ text: t.string().trim().min(1).max(10_000) }),
      response: { 200: Note${auth ? ", 401: t.problem()" : ""} },
      examples: [
${putExamples.map((e) => `        ${e},`).join("\n")}
      ],
    },
    async ({ params, body }) => {
      const note = { id: params.id, text: body.text };
      await store.set(\`note:\${note.id}\`, note, MONTH);
      return note;
    },
  );

// the store lets go of its connection, where it has one, when the app stops (SIGTERM, ctrl+c)
app.onClose(closeStore);
`;
}

export type CreatedApp = { dir: string; name: string; files: string[] };

/**
 * Writes the project into `target` and returns what it wrote. Refuses a folder that is
 * not empty unless `force`, and a folder whose name npm would not take as a package name.
 */
export function createApp(target: string, choices: AppChoices, opts: { version: string; pm?: Manager; force?: boolean }): CreatedApp {
  const to = resolve(target);
  const name = projectName(to);
  const problem = npmNameProblem(name);
  if (problem) throw new CreateAppError(`${problem} The folder's name becomes the package name: pick another folder.`);
  if (existsSync(to) && readdirSync(to).length && !opts.force) {
    throw new CreateAppError(`${relative(process.cwd(), to) || "."} is not empty. Pick another folder, or add --force to write into it anyway.`);
  }
  const files = appFiles(name, choices, opts);
  for (const [rel, text] of Object.entries(files)) {
    const dest = join(to, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
  return { dir: to, name, files: Object.keys(files) };
}

/** Every combination of the choices, for the tests and the CI matrix. */
export function allChoices(): AppChoices[] {
  return STORES.flatMap((store) => [false, true].flatMap((auth) => FRONTENDS.map((frontend) => ({ store, auth, frontend }))));
}

// ----- the command -----

export const APP_HELP = (c: ReturnType<typeof paint>) => `
  ${c.seal("印")} ${c.bold("inkan create app")} ${c.dim("[folder] [options]")}   ${c.dim(`(or ${CREATE_COMMAND} [folder] -- [options])`)}

  ${c.bold("--store")} ${c.dim("<s>")}        ${STORES.map((s) => `${s}`).join(" | ")}   ${c.dim("where the data lives (memory)")}
  ${c.bold("--auth")}, ${c.bold("--no-auth")}  ${c.dim("logins and sessions from @inkanjs/auth (no)")}
  ${c.bold("--frontend")} ${c.dim("<f>")}     ${FRONTENDS.join(" | ")}   ${c.dim("a frontend with the API under /api (none)")}
  ${c.bold("--pm")} ${c.dim("<pm>")}          ${MANAGERS.join(" | ")}   ${c.dim("who installs (the one that ran this, else npm)")}
  ${c.bold("--no-install")}       ${c.dim("write the files, install nothing")}
  ${c.bold("--yes")}, ${c.bold("-y")}          ${c.dim("no questions: the defaults for what the flags leave open")}
  ${c.bold("--force")}            ${c.dim("write into a folder that is not empty")}

  ${c.dim("Without a terminal to ask in, the defaults apply too.")}
`;

type CommandContext = { version: string; color: boolean; fail: (msg: string) => never };

/** `inkan create app …` with `args` after "app"; resolves with the exit code. */
export async function runCreateApp(args: string[], ctx: CommandContext): Promise<number> {
  const c = paint(ctx.color);
  const { fail } = ctx;
  const given: Partial<AppChoices> = {};
  let folder: string | undefined;
  let yes = false;
  let install = true;
  let force = false;
  let pm: Manager | undefined;
  const pick = <T extends string>(flag: string, value: string | undefined, allowed: readonly T[]): T => {
    if (value && (allowed as readonly string[]).includes(value)) return value as T;
    return fail(`${flag} takes one of ${allowed.join(", ")}${value ? `, not "${value}"` : ""}.`);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => inline ?? args[++i];
    if (flag === "--help" || flag === "-h") {
      console.log(APP_HELP(c));
      return 0;
    } else if (flag === "--store") given.store = pick("--store", value(), STORES);
    else if (flag === "--frontend") given.frontend = pick("--frontend", value(), FRONTENDS);
    else if (flag === "--pm") pm = pick("--pm", value(), MANAGERS);
    else if (flag === "--auth") given.auth = true;
    else if (flag === "--no-auth") given.auth = false;
    else if (flag === "--yes" || flag === "-y") yes = true;
    else if (flag === "--no-install") install = false;
    else if (flag === "--force") force = true;
    else if (flag.startsWith("-")) fail(`There is no option ${flag}. inkan create app --help lists them.`);
    else if (folder === undefined) folder = a;
    else fail(`One folder at a time: "${folder}" or "${a}"?`);
  }

  const ask = !yes && process.stdin.isTTY && process.stdout.isTTY;
  let choices: AppChoices = { ...DEFAULT_CHOICES, ...given };
  if (ask) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(`\n  ${c.seal("印")} ${c.bold("a new inkan app")}\n`);
      folder ??= (await rl.question(`  folder? ${c.dim("(inkan-app)")} `)).trim() || "inkan-app";
      const choose = async <T extends string>(what: string, options: readonly T[], info: Record<T, string>, fallback: T): Promise<T> => {
        console.log(`\n  ${c.bold(what)}`);
        options.forEach((o, i) => console.log(`  ${c.dim(String(i + 1) + ".")} ${o.padEnd(9)} ${c.dim(info[o])}`));
        for (;;) {
          const answer = (await rl.question(`  ${c.dim(`(1-${options.length} or a name, enter for ${fallback})`)} `)).trim();
          if (!answer) return fallback;
          const found = options[Number(answer) - 1] ?? options.find((o) => o === answer);
          if (found) return found;
        }
      };
      const store = given.store ?? (await choose("where does the data live?", STORES, STORE_INFO, DEFAULT_CHOICES.store));
      let auth = given.auth;
      while (auth === undefined) {
        const answer = (await rl.question(`\n  ${c.bold("logins and sessions")} ${c.dim("(@inkanjs/auth)")}? ${c.dim("(y/N)")} `)).trim().toLowerCase();
        auth = !answer || answer === "n" || answer === "no" ? false : answer === "y" || answer === "yes" ? true : undefined;
      }
      const frontend = given.frontend ?? (await choose("a frontend?", FRONTENDS, FRONTEND_INFO, DEFAULT_CHOICES.frontend));
      choices = { store, auth, frontend };
    } finally {
      rl.close();
    }
  }
  const target = folder ?? "inkan-app";
  const manager = pm ?? detectManager();

  let made: CreatedApp;
  try {
    made = createApp(target, choices, { version: ctx.version, pm: manager, force });
  } catch (err) {
    if (err instanceof CreateAppError) fail(err.message);
    throw err;
  }
  const rel = relative(process.cwd(), made.dir) || ".";
  const what = [choices.store, ...(choices.auth ? ["auth"] : []), ...(choices.frontend === "none" ? [] : [choices.frontend])].join(" + ");
  console.log(`\n  ${c.seal("印")} ${c.bold(made.name)} ${c.dim("→")} ${rel}  ${c.dim(`(${what}, ${made.files.length} files)`)}\n`);

  let installed = false;
  if (install) {
    console.log(`  ${c.dim(`${manager} install …`)}\n`);
    // npm and the others are .cmd files on Windows, which only a shell starts
    const r = spawnSync(manager, ["install"], { cwd: made.dir, stdio: "inherit", shell: process.platform === "win32" });
    installed = r.status === 0;
    if (!installed) console.log(`\n  ${c.warn(`${manager} install did not finish.`)} ${c.dim("The files are there; run it again yourself.")}\n`);
  }
  const r = (s: string) => runScript(manager, s);
  if (rel !== ".") console.log(`  cd ${rel}`);
  if (!installed) console.log(`  ${manager} install`);
  if (choices.store !== "memory") console.log(`  ${c.dim(`cp .env.example .env, and point it at your database (${choices.store})`)}`);
  console.log(`  ${r("dev")}`);
  console.log(`  ${r("check")}   ${c.dim("every example, run as a test")}`);
  console.log(`  ${r("test")}\n`);
  console.log(`  ${c.dim(`Start with README.md and ${serverDir(choices.frontend)}/app.ts.`)}\n`);
  return install && !installed ? 1 : 0;
}

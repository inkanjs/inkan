#!/usr/bin/env node
// inkan check | openapi | routes <entry>
// Loads the module that builds your app (listen() stays quiet while it does)
// and reads it, without opening a port.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import type { App } from "./core/app.ts";
import { formatReport, formatReportMarkdown } from "./testing/check.ts";
import { paint, useColor } from "./core/color.ts";
import { diffOpenAPI, formatDiff, formatDiffMarkdown } from "./openapi/diff.ts";
import { copyExample, EXAMPLES, ExampleError } from "./cli/examples.ts";
import { writeSeal } from "./seal/seal.ts";
import { createPlugin, CreateError } from "./cli/create.ts";
import { runCreateApp } from "./cli/app.ts";
import { banner, Cancelled, select } from "./cli/prompt.ts";
import { runHanko } from "./cli/hanko.ts";

const version = (): string => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const args = process.argv.slice(2);
const command = args.shift();
const option = (...names: string[]) => {
  const i = args.findIndex((a) => names.includes(a));
  if (i < 0) return undefined;
  return args.splice(i, 2)[1];
};
/** An option that needs a value: a usage error without one. */
const value = (...names: string[]) => {
  const i = args.findIndex((a) => names.includes(a));
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("-")) fail(`${args[i]} needs a value.`);
  return option(...names);
};
const has = (name: string) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};

function fail(msg: string): never {
  const c = paint(useColor(process.stderr));
  console.error(`\n  ${c.seal("inkan:")} ${msg}\n`);
  process.exit(2);
}

async function load(entry: string | undefined) {
  if (!entry) fail("Which file builds the app? For example: inkan check src/app.ts");
  if (!existsSync(entry)) fail(`There is no file ${entry}.`);
  process.env.INKAN_NO_LISTEN = "1";
  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(resolve(entry)).href);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (entry.endsWith(".ts") && code === "ERR_UNKNOWN_FILE_EXTENSION") {
      fail(`Node ${process.versions.node} cannot load .ts files by itself. Use Node 22.18 or newer, or point at the built .js file.`);
    }
    loadFailed(entry, err); // a load error is a 2, like a usage error: no check ran
  }
  const app = (mod.default ?? mod.app) as App | undefined;
  if (!app || typeof app.check !== "function") fail(`${entry} has to export the app, as \`export default app\` or \`export const app\`.`);
  try {
    await app.ready(); // plugins add routes too
  } catch (err) {
    loadFailed(entry, err);
  }
  return {
    app,
    beforeEach: mod.beforeEach as (() => unknown) | undefined,
    untested: mod.untested as Record<string, Record<number, string>> | undefined,
  };
}

function loadFailed(entry: string, err: unknown): never {
  console.error((err as Error)?.stack ?? err);
  fail(`Could not load ${entry}: ${(err as Error)?.message ?? err}`);
}

/** `--format terminal|json|markdown`, and `--json` for `--format json`. */
function format(): "terminal" | "json" | "markdown" {
  const json = has("--json");
  const i = args.indexOf("--format");
  const given = i < 0 ? undefined : args.splice(i, 2)[1];
  if (i >= 0 && !["terminal", "json", "markdown"].includes(given ?? "")) {
    fail(`--format takes terminal, json or markdown${given ? `, not "${given}"` : ""}.`);
  }
  if (json && given && given !== "json") fail(`--json and --format ${given} say different things; pick one.`);
  return json ? "json" : ((given ?? "terminal") as "terminal" | "json" | "markdown");
}

/** What is left after the options were taken: positional arguments only, `count` at most. */
function rest(count: number, usage: string): string[] {
  const unknown = args.find((a) => a.startsWith("-"));
  if (unknown) fail(`There is no option ${unknown} here. ${usage}`);
  if (args.length > count) fail(`One too many: "${args[count]}". ${usage}`);
  return args;
}

const color = useColor();
const c = paint(color);

const HELP = `
  ${c.seal("印")} ${c.bold("inkan")}

  ${c.bold("inkan check")}   ${c.dim("<entry> [--only <text>] [--strict] [--mcp] [--format <fmt>]")}
                ${c.dim("run every example against its contract;")}
                ${c.dim("--strict fails on promised statuses no example covers,")}
                ${c.dim("--mcp runs them as MCP tool calls too")}
  ${c.bold("inkan mcp")}     ${c.dim('<entry> [-H "name: value"]...')}
                ${c.dim("the app as an MCP server on stdin and stdout, for Claude Code, Cursor and others;")}
                ${c.dim("-H sends a header with every tool call, e.g. the token a route asks for")}
  ${c.bold("inkan openapi")} ${c.dim("<entry> [-o <file>]")}   ${c.dim("write the OpenAPI 3.1 document")}
  ${c.bold("inkan routes")}  ${c.dim("<entry>")}               ${c.dim("list the routes")}
  ${c.bold("inkan diff")}    ${c.dim("<before> <after> [--format <fmt>]")}
                ${c.dim("what would break a client; each side a .json file or an app")}
  ${c.bold("inkan seal")}    ${c.dim("<entry> [-o <file>]")}   ${c.dim("stamp the contracts into plain code, for speed")}
  ${c.bold("inkan examples")} ${c.dim("[name] [folder] [--list] [--force]")}
                ${c.dim("copy an explained example project into a folder")}
  ${c.bold("inkan create app")} ${c.dim("[folder] [--store <s>] [--auth] [--frontend <f>] [--yes]")}
                ${c.dim("a project to build on: a store, auth, a frontend, tests and CI;")}
                ${c.dim("asks what it needs, or see inkan create app --help")}
  ${c.bold("inkan create plugin")} ${c.dim("<name> [folder]")}
                ${c.dim("a package for a plugin of your own: tests, types, CI, ready for npm")}
  ${c.bold("inkan hanko")}   ${c.dim("[query] [--kind <k>] [--json]")}
                ${c.dim("find plugins, middleware and stores by kind or by search, and install one")}

  ${c.dim("<entry>")} is the file that builds the app and exports it,
  as ${c.link("`export default app`")} or ${c.link("`export const app`")}.
  It may also export ${c.link("`beforeEach`")}, which check runs before every example,
  and ${c.link("`untested`")}: statuses of routes it does not write itself that no example shows, on purpose.
  ${c.dim("<fmt>")} is terminal (the default), json (${c.dim("--json")} for short) or markdown, for a PR comment.

  Exit codes: 0 all good, 1 a check failed or a change breaks clients, 2 a usage or load error.
`;

switch (command) {
  case "check": {
    const only = value("--only");
    const as = format();
    const strict = has("--strict");
    const mcp = has("--mcp");
    const [entry] = rest(1, "inkan check <entry> [--only <text>] [--strict] [--mcp] [--format terminal|json|markdown]");
    const { app, beforeEach, untested } = await load(entry);
    const report = await app.check({ only, beforeEach, strict, untested, mcp });
    const title = [app.options.title, app.options.version].filter(Boolean).join(" ");
    if (as === "json") console.log(JSON.stringify(report, null, 2));
    else if (as === "markdown") console.log(formatReportMarkdown(report, { title }));
    else console.log(formatReport(report, { title, color }));
    process.exit(report.ok ? 0 : 1);
  }
  case "mcp": {
    const headers: Record<string, string> = {};
    for (let h = value("--header", "-H"); h !== undefined; h = value("--header", "-H")) {
      const i = h.indexOf(":");
      if (i < 1) fail(`--header takes "name: value", not "${h}".`);
      headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
    }
    const [entry] = rest(1, 'inkan mcp <entry> [-H "name: value"]...');
    // stdout carries the protocol and nothing else: whatever the app logs goes to stderr
    console.log = console.info = console.debug = console.error;
    const { app } = await load(entry);
    const write = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const pending = new Set<Promise<void>>();
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let msg: { id?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: the line is not JSON" } });
      }
      const p = app._mcpMessage(msg, { method: "POST", url: "/mcp", headers, local: true }, undefined, false).then(
        (a) => void (a.message && write(a.message)),
        (err) => void write({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32603, message: (err as Error)?.message ?? String(err) } }),
      );
      pending.add(p);
      void p.finally(() => pending.delete(p));
    });
    await new Promise((done) => lines.once("close", done));
    await Promise.all(pending);
    process.exit(0);
  }
  case "openapi": {
    const out = value("--out", "-o");
    const [entry] = rest(1, "inkan openapi <entry> [-o <file>]");
    const { app } = await load(entry);
    const doc = JSON.stringify(app.openapi(), null, 2) + "\n";
    if (out) {
      try {
        writeFileSync(out, doc);
      } catch (err) {
        fail(`Could not write ${out}: ${(err as Error).message}`);
      }
      console.log(`  ${c.ok("wrote")} ${out}`);
    } else process.stdout.write(doc);
    process.exit(0);
  }
  case "routes": {
    const { app } = await load(rest(1, "inkan routes <entry>")[0]);
    for (const r of app.routes()) {
      const n = r.spec.examples?.length ?? 0;
      const examples = n ? c.dim(`${n} example${n === 1 ? "" : "s"}`) : c.warn("no examples");
      const tail = [r.spec.summary, examples].filter(Boolean).join(c.dim("  ·  "));
      console.log(`  ${c.method(r.method, r.method.padEnd(7))} ${r.path.padEnd(32)} ${tail}`);
    }
    process.exit(0);
  }
  case "seal": {
    const given = option("--out", "-o");
    const entry = args[0];
    const { app } = await load(entry);
    const out = given ?? join(dirname(entry), "inkan.seal.js");
    const slash = (p: string) => p.replaceAll("\\", "/");
    const report = writeSeal(app.routes(), slash(relative(process.cwd(), resolve(entry))));
    writeFileSync(out, report.code);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).name;
    writeFileSync(out.replace(/\.js$/, ".d.ts"), `declare const seal: import("${pkg}").Seal;\nexport default seal;\n`);
    const n = report.sealed;
    console.log(`\n  ${c.seal("印")} ${c.bold("sealed")} ${n} contract${n === 1 ? "" : "s"} ${c.dim(`(${report.entries} entries)`)} ${c.dim("→")} ${slash(out)}`);
    for (const u of report.unsealable) console.log(`  ${c.dim("·")} ${u.label} ${c.dim(`runs unsealed: the seal cannot write ${u.reason} yet`)}`);
    const rel = slash(relative(dirname(resolve(entry)), resolve(out)));
    console.log(`\n  ${c.dim("use it:")} import seal from "${rel.startsWith(".") ? rel : "./" + rel}";  inkan({ seal })\n`);
    process.exit(0);
  }
  case "diff": {
    const as = format();
    const [before, after] = rest(2, "inkan diff <before> <after> [--format terminal|json|markdown]");
    if (!before || !after) fail("Compare what with what? For example: inkan diff openapi.json src/app.ts");
    const read = async (file: string) => {
      if (file.endsWith(".json")) {
        try {
          return JSON.parse(readFileSync(file, "utf8"));
        } catch (err) {
          fail(`Could not read ${file}: ${(err as Error).message}`);
        }
      }
      return (await load(file)).app.openapi();
    };
    const changes = diffOpenAPI(await read(before), await read(after));
    const title = `${before} → ${after}`;
    if (as === "json") console.log(JSON.stringify(changes, null, 2));
    else if (as === "markdown") console.log(formatDiffMarkdown(changes, { title }));
    else console.log(formatDiff(changes, { title, color }));
    process.exit(changes.some((x) => x.breaking) ? 1 : 0);
  }
  case "examples": {
    const force = has("--force");
    const list = has("--list");
    let name = args[0];
    const printList = () => {
      console.log(`\n  ${c.seal("印")} ${c.bold("inkan examples")}  ${c.dim("explained example projects, in reading order")}\n`);
      EXAMPLES.forEach((e, i) => console.log(`  ${c.dim(String(i + 1) + ".")} ${c.bold(e.name.padEnd(10))} ${e.blurb}`));
      console.log("");
    };
    if (list || (!name && !process.stdin.isTTY)) {
      printList();
      console.log(`  ${c.dim("pick one:")} inkan examples ${c.link("<name>")} ${c.dim("[folder]")}\n`);
      process.exit(0);
    }
    if (!name) {
      console.log(banner(color, "inkan examples", "explained projects, in reading order"));
      const io = { input: process.stdin, output: process.stdout, color };
      try {
        name = await select(io, "which one?", EXAMPLES.map((e) => ({ value: e.name, hint: e.blurb })));
      } catch (err) {
        if (!(err instanceof Cancelled)) throw err;
        process.exit(130);
      }
    }
    const target = args[1] ?? name;
    try {
      const files = copyExample(name, target, { force, version: version() });
      const dir = relative(process.cwd(), resolve(target)) || ".";
      console.log(`\n  ${c.seal("印")} ${c.bold(name)} ${c.dim("→")} ${dir}  ${c.dim(`(${files.length} files)`)}\n`);
      if (dir !== ".") console.log(`  cd ${dir}`);
      console.log(`  npm install`);
      console.log(`  npm run dev     ${c.dim("then open")} ${c.link("http://localhost:3000/docs")}`);
      console.log(`  npm run check   ${c.dim("every example, run as a test")}\n`);
      console.log(`  ${c.dim("Start with README.md: it says what to read, in which order.")}\n`);
      process.exit(0);
    } catch (err) {
      if (err instanceof ExampleError) fail(err.message);
      throw err;
    }
  }
  case "create": {
    if (args[0] === "app") {
      const code = await runCreateApp(args.slice(1), { version: version(), color, fail });
      process.exit(code);
    }
    const [kind, name, folder] = args;
    if (kind !== "plugin") fail("Create what? inkan create app [folder] or inkan create plugin <name>, for example: inkan create plugin inkan-quota");
    if (!name) fail("Which name will it have on npm? For example: inkan create plugin inkan-quota");
    try {
      const { dir, files, fn, range } = createPlugin(name, folder, { version: version() });
      const rel = relative(process.cwd(), dir) || ".";
      console.log(`
  ${c.seal("印")} ${c.bold(name)} ${c.dim("→")} ${rel}  ${c.dim(`(${files.length} files, for inkan ${range})`)}
`);
      if (rel !== ".") console.log(`  cd ${rel}`);
      console.log(`  npm install`);
      console.log(`  npm test          ${c.dim("every case through app.inject")}`);
      console.log(`  npm run typecheck ${c.dim("test.ts against index.d.ts")}
`);
      console.log(`  ${c.dim("Then make it yours:")} ${fn}() in index.js, its types in index.d.ts, README.md.`);
      console.log(`  ${c.dim("Publish:")} npm publish ${c.dim("— the keyword inkan-plugin lists it on")} ${c.link("https://inkan-dev.vercel.app/hanko")}`);
      console.log(`  ${c.dim("For a better line there, open a PR to inkanjs/inkan.dev: data/hanko.ts.")}
`);
      process.exit(0);
    } catch (err) {
      if (err instanceof CreateError) fail(err.message);
      throw err;
    }
  }
  case "hanko":
  case "plugins": {
    process.exit(await runHanko(args, { color, fail }));
  }
  case "-v":
  case "--version": {
    console.log(version());
    process.exit(0);
  }
  default:
    console.log(HELP);
    process.exit(!command || ["help", "--help", "-h"].includes(command) ? 0 : 2);
}

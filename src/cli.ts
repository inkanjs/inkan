#!/usr/bin/env node
// inkan check | openapi | routes <entry>
// Loads the module that builds your app (listen() stays quiet while it does)
// and reads it, without opening a port.

import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import type { App } from "./app.ts";
import { formatReport } from "./check.ts";
import { paint, useColor } from "./color.ts";
import { diffOpenAPI, formatDiff } from "./diff.ts";
import { copyExample, EXAMPLES, ExampleError } from "./examples.ts";

const version = (): string => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const args = process.argv.slice(2);
const command = args.shift();
const option = (...names: string[]) => {
  const i = args.findIndex((a) => names.includes(a));
  if (i < 0) return undefined;
  return args.splice(i, 2)[1];
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
  process.env.INKAN_NO_LISTEN = "1";
  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(resolve(entry)).href);
  } catch (err) {
    if (entry.endsWith(".ts") && (err as NodeJS.ErrnoException).code === "ERR_UNKNOWN_FILE_EXTENSION") {
      fail(`Node ${process.versions.node} cannot load .ts files by itself. Use Node 22.18 or newer, or point at the built .js file.`);
    }
    throw err;
  }
  const app = (mod.default ?? mod.app) as App | undefined;
  if (!app || typeof app.check !== "function") fail(`${entry} has to export the app, as \`export default app\` or \`export const app\`.`);
  return { app, beforeEach: mod.beforeEach as (() => unknown) | undefined };
}

const color = useColor();
const c = paint(color);

const HELP = `
  ${c.seal("印")} ${c.bold("inkan")}

  ${c.bold("inkan check")}   ${c.dim("<entry> [--only <text>] [--json] [--strict]")}
                ${c.dim("run every example against its contract;")}
                ${c.dim("--strict fails on promised statuses no example covers")}
  ${c.bold("inkan openapi")} ${c.dim("<entry> [-o <file>]")}   ${c.dim("write the OpenAPI 3.1 document")}
  ${c.bold("inkan routes")}  ${c.dim("<entry>")}               ${c.dim("list the routes")}
  ${c.bold("inkan diff")}    ${c.dim("<before> <after> [--json]")}
                ${c.dim("what would break a client; each side a .json file or an app")}
  ${c.bold("inkan examples")} ${c.dim("[name] [folder] [--list] [--force]")}
                ${c.dim("copy an explained example project into a folder")}

  ${c.dim("<entry>")} is the file that builds the app and exports it,
  as ${c.link("`export default app`")} or ${c.link("`export const app`")}.
  It may also export ${c.link("`beforeEach`")}, which check runs before every example.
`;

switch (command) {
  case "check": {
    const only = option("--only");
    const json = has("--json");
    const strict = has("--strict");
    const { app, beforeEach } = await load(args[0]);
    const report = await app.check({ only, beforeEach, strict });
    if (json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatReport(report, [app.options.title, app.options.version].filter(Boolean).join(" "), color));
    process.exit(report.ok ? 0 : 1);
  }
  case "openapi": {
    const out = option("--out", "-o");
    const { app } = await load(args[0]);
    const doc = JSON.stringify(app.openapi(), null, 2) + "\n";
    if (out) {
      writeFileSync(out, doc);
      console.log(`  ${c.ok("wrote")} ${out}`);
    } else process.stdout.write(doc);
    process.exit(0);
  }
  case "routes": {
    const { app } = await load(args[0]);
    for (const r of app.routes()) {
      const n = r.spec.examples?.length ?? 0;
      const examples = n ? c.dim(`${n} example${n === 1 ? "" : "s"}`) : c.warn("no examples");
      const tail = [r.spec.summary, examples].filter(Boolean).join(c.dim("  ·  "));
      console.log(`  ${c.method(r.method, r.method.padEnd(7))} ${r.path.padEnd(32)} ${tail}`);
    }
    process.exit(0);
  }
  case "diff": {
    const json = has("--json");
    const [before, after] = args;
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
    if (json) console.log(JSON.stringify(changes, null, 2));
    else console.log(formatDiff(changes, `${before} → ${after}`, color));
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
      printList();
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(`  which one? ${c.dim(`(1-${EXAMPLES.length} or a name)`)} `)).trim();
      rl.close();
      name = EXAMPLES[Number(answer) - 1]?.name ?? answer;
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
  case "-v":
  case "--version": {
    console.log(version());
    process.exit(0);
  }
  default:
    console.log(HELP);
    process.exit(!command || ["help", "--help", "-h"].includes(command) ? 0 : 2);
}

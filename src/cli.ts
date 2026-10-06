#!/usr/bin/env node
// inkan check | openapi | routes <entry>
// Loads the module that builds your app (listen() stays quiet while it does)
// and reads it, without opening a port.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { App } from "./app.ts";
import { formatReport } from "./check.ts";
import { paint, useColor } from "./color.ts";

const HELP = `
  印 inkan

  inkan check   <entry> [--only <text>] [--json] [--strict]
                                                   run every example against its contract;
                                                   --strict fails on promised statuses no example covers
  inkan openapi <entry> [-o <file>]                write the OpenAPI 3.1 document
  inkan routes  <entry>                            list the routes

  <entry> is the file that builds the app and exports it,
  as \`export default app\` or \`export const app\`.
  It may also export \`beforeEach\`, which check runs before every example.
`;

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
  case "-v":
  case "--version": {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    console.log(pkg.version);
    process.exit(0);
  }
  default:
    console.log(HELP);
    process.exit(!command || ["help", "--help", "-h"].includes(command) ? 0 : 2);
}

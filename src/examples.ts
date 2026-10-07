// `inkan examples`: copies a complete, explained example project into a folder.
// The templates ship inside the package, so this works offline and always
// matches the installed version.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type ExampleInfo = { name: string; title: string; blurb: string };

/** In reading order: each one builds on the ones before it. */
export const EXAMPLES: ExampleInfo[] = [
  { name: "hello", title: "Hello", blurb: "one route, one example, inkan check. Five minutes." },
  { name: "tea-shop", title: "Tea shop", blurb: "CRUD with named schemas, problem(), groups and beforeEach." },
  { name: "auth", title: "Auth", blurb: "middleware, ctx.state, route-level use, a 401 and a 403 in the contract." },
  { name: "testing", title: "Testing", blurb: "app.check() and app.inject() in node:test, plus a CI workflow." },
  { name: "openapi", title: "OpenAPI", blurb: "export the document, generate a client, keep both in sync." },
  { name: "deploy", title: "Deploy", blurb: "Dockerfile, $PORT, JSON logs, graceful shutdown, warden." },
];

/** Where the templates live: next to src/ in the repo, next to dist/ in the package. */
export const templatesDir = () => fileURLToPath(new URL("../templates/", import.meta.url));

// npm leaves dotfiles like .gitignore out of a package, so they travel with an underscore.
const RENAME: Record<string, string> = { _gitignore: ".gitignore", _dockerignore: ".dockerignore", _github: ".github" };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export class ExampleError extends Error {}

export type CopyOptions = { force?: boolean; version: string };

/**
 * Copies one example into `target` and returns the files it wrote, relative to it.
 * Refuses a folder that is not empty unless `force` is set.
 */
export function copyExample(name: string, target: string, opts: CopyOptions): string[] {
  const info = EXAMPLES.find((e) => e.name === name);
  if (!info) throw new ExampleError(`There is no example called "${name}". These are there: ${EXAMPLES.map((e) => e.name).join(", ")}.`);
  const from = join(templatesDir(), name);
  const to = resolve(target);
  if (existsSync(to) && readdirSync(to).length && !opts.force) {
    throw new ExampleError(`${relative(process.cwd(), to) || "."} is not empty. Pick another folder, or add --force to write into it anyway.`);
  }
  const written: string[] = [];
  for (const file of walk(from)) {
    const rel = relative(from, file).split(sep).map((part) => RENAME[part] ?? part).join("/");
    const dest = join(to, rel);
    mkdirSync(dirname(dest), { recursive: true });
    const text = readFileSync(file, "utf8");
    writeFileSync(dest, text.replaceAll("{{version}}", opts.version).replaceAll("{{name}}", basename(to)));
    written.push(rel);
  }
  return written.sort();
}

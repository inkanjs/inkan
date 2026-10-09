// `inkan create plugin <name>`: a package for a plugin of your own, ready to test and
// publish. The files are in templates/plugin, shipped with inkan like the examples.
//
// The plugin is plain JavaScript (index.js) with its types beside it (index.d.ts), as the
// official @inkanjs packages are: no build step to forget before `npm publish`, nothing
// generated to keep out of git, and the file npm installs is the one the tests ran.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { RENAME, templatesDir, walk } from "./examples.ts";

export class CreateError extends Error {}

// npm's rules for a new package name: lower case, URL-safe, at most 214 characters
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const RESERVED = /^(?:break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|function|if|import|in|instanceof|let|new|null|return|static|super|switch|this|throw|true|try|typeof|var|void|while|with|yield|await|arguments|eval)$/;

/** Why `name` cannot be a new package on npm, or undefined when it can. */
export function npmNameProblem(name: string): string | undefined {
  if (!name) return "A package needs a name.";
  if (name.length > 214) return `"${name}" is longer than the 214 characters npm allows.`;
  if (name !== name.toLowerCase()) return `"${name}" has capitals; npm names are lower case.`;
  if (name.trim() !== name || /\s/.test(name)) return `"${name}" has spaces; npm names have none.`;
  if (/^[._]/.test(name)) return `"${name}" starts with "${name[0]}", which npm does not allow.`;
  if (!NPM_NAME.test(name)) return `"${name}" is not a name npm takes: letters, digits, "-", ".", "_" and "~", with one "@scope/" in front if you like.`;
  if (name.startsWith("@inkanjs/")) return `The @inkanjs scope is for the official packages. Publish under your own scope or none: inkan-${name.slice(9)}.`;
  if (name === "node_modules" || name === "favicon.ico" || builtinModules.includes(name)) return `"${name}" is a name npm keeps for itself.`;
  return undefined;
}

/** The name the plugin's function goes by: `inkan-quota` → `quota`, `@me/rate-cap` → `rateCap`. */
export function functionName(pkg: string): string {
  const base = pkg.replace(/^@[^/]+\//, "").replace(/^inkan[-._]/, "").replace(/[-._]inkan$/, "");
  const words = base.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  let fn = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join("");
  if (!fn) fn = "myPlugin";
  if (/^\d/.test(fn)) fn = "plugin" + fn;
  if (RESERVED.test(fn)) fn += "Plugin";
  return fn;
}

/** `>=0.7.0 <0.8.0`: the minor that runs, which is what a plugin is built and tested on. */
export function minorRange(version: string): string {
  const [major, minor] = version.split(".").map(Number);
  return `>=${major}.${minor}.0 <${major}.${minor + 1}.0`;
}

export type CreatedPlugin = { dir: string; files: string[]; fn: string; range: string };

/**
 * Writes a plugin package for `name` into `target` (the name without its scope by
 * default) and returns what it wrote. Refuses a name npm would not take, the @inkanjs
 * scope, and a folder that is already there.
 */
export function createPlugin(name: string, target: string | undefined, opts: { version: string }): CreatedPlugin {
  const problem = npmNameProblem(name);
  if (problem) throw new CreateError(problem);
  const to = resolve(target ?? name.replace(/^@[^/]+\//, ""));
  if (existsSync(to)) throw new CreateError(`${relative(process.cwd(), to) || "."} is already there. Pick another folder: inkan create plugin ${name} <folder>`);
  const fn = functionName(name);
  const range = minorRange(opts.version);
  const from = join(templatesDir(), "plugin");
  const fill = (text: string) =>
    text
      .replaceAll("{{name}}", name)
      .replaceAll("{{version}}", opts.version)
      .replaceAll("{{range}}", range)
      .replaceAll("{{year}}", String(new Date().getFullYear()))
      .replaceAll("myPlugin", fn)
      .replaceAll("MyPlugin", fn[0].toUpperCase() + fn.slice(1));
  const files: string[] = [];
  for (const file of walk(from)) {
    const rel = relative(from, file).split(sep).map((part) => RENAME[part] ?? part).join("/");
    const dest = join(to, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, fill(readFileSync(file, "utf8")));
    files.push(rel);
  }
  return { dir: to, files: files.sort(), fn, range };
}

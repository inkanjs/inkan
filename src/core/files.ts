// Routes from the file tree: a folder of modules, one per path, each exporting its methods.
//
//   routes/index.ts            /
//   routes/teas/index.ts       /teas
//   routes/teas/[id].ts        /teas/:id
//   routes/files/[...rest].ts  /files/*rest
//
// Nothing happens at import time: `app.load(dir)` reads the folder when it is called, and the
// routes it finds are routes like any other, with the same contracts and the same check.

import { readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Handler, Responses, RouteSpec } from "./route.ts";

/** A route as a file exports it: its contract and its handler. */
export type FileRoute = { readonly spec: RouteSpec<any, any, any, any, any>; readonly handler: Handler<any, any, any, any, any> };

/**
 * A route for a file in a routes folder: `export const GET = route({ params: … }, handler)`.
 * The handler is typed from the contract, as it is with `app.get`. Path params come from the
 * file name, so give them a `params` schema to have them typed.
 */
export function route<P = Record<string, string>, Q = Record<string, string | string[]>, B = undefined, H = Record<string, string | undefined>, R extends Responses = {}>(
  spec: RouteSpec<P, Q, B, H, R>,
  handler: Handler<P, Q, B, H, R>,
): FileRoute {
  return { spec, handler } as FileRoute;
}

/** The exports a route file may have, and the method each one answers. */
export const METHOD_EXPORTS: [string, string][] = [
  ["GET", "GET"],
  ["POST", "POST"],
  ["PUT", "PUT"],
  ["PATCH", "PATCH"],
  ["DELETE", "DELETE"],
];

const ROUTE_FILE = /\.(ts|mts|js|mjs)$/;
const SKIPPED = /(\.d\.ts|\.test\.[mc]?[jt]s|\.spec\.[mc]?[jt]s)$/;

/** Every route file under `dir`, in a stable order. Names starting with `_` or `.` are left alone. */
export function routeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (ROUTE_FILE.test(entry.name) && !SKIPPED.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** The path a file answers: `teas/[id].ts` is `/teas/:id`, `index` is its folder, `[...rest]` the rest. */
export function routePath(file: string): string {
  const segments = file.replace(ROUTE_FILE, "").split(sep).join("/").split("/");
  if (segments.at(-1) === "index") segments.pop();
  const path = segments.map((s, i) => {
    const rest = /^\[\.\.\.(\w+)\]$/.exec(s);
    if (rest) {
      if (i !== segments.length - 1) throw new Error(`${file}: [...${rest[1]}] has to be the last part of the path`);
      return `*${rest[1]}`;
    }
    const param = /^\[(\w+)\]$/.exec(s);
    return param ? `:${param[1]}` : s;
  });
  return "/" + path.join("/");
}

/** The folder a `load` call means: a URL or an absolute path as it is, a relative path from the working directory. */
export const folderOf = (dir: string | URL) => (dir instanceof URL ? fileURLToPath(dir) : resolve(dir));

/** Reads every route file in a folder and hands each method it exports to `define`. */
export async function loadRoutes(dir: string, define: (method: string, path: string, spec: unknown, handler: unknown) => void) {
  for (const file of routeFiles(dir)) {
    const rel = relative(dir, file);
    const path = routePath(rel);
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    let found = false;
    for (const [name, method] of METHOD_EXPORTS) {
      const r = mod[name] as FileRoute | Handler<any, any, any, any, any> | undefined;
      if (r === undefined) continue;
      found = true;
      if (typeof r === "function") define(method, path, r, undefined);
      else if (r && typeof r === "object" && typeof r.handler === "function") define(method, path, r.spec, r.handler);
      else throw new Error(`${rel}: ${name} has to be a handler or route({ … }, handler)`);
    }
    if (!found) throw new Error(`${rel} exports no route: export GET, POST, PUT, PATCH or DELETE`);
  }
}

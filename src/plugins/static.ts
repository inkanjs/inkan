// Files from a folder, for the built frontend next to the API: a plugin with one GET route
// under its prefix, which every other route wins against. With `spa`, a path without a
// file gets the app's index.html, so the frontend's own router can take it.
//
//   app.register(serveStatic({ dir: "client/dist", spa: true, exclude: ["/api"] }))

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { problem } from "../core/problem.ts";
import { reply } from "../core/route.ts";
import { plugin } from "../core/scope.ts";

export type StaticOptions = {
  /** The folder the files come from. */
  dir: string;
  /** Where they are served. Default `/`. */
  prefix?: string;
  /**
   * For a single-page app: a GET that finds no file gets this one instead (`true` means
   * `index.html`), with `cache-control: no-cache`, so a new build is seen at once.
   */
  spa?: boolean | string;
  /** Paths that stay out of the fallback and answer 404: `["/api"]`, so a mistyped API call is not handed a page. */
  exclude?: string[];
  /** Files that never change under their name, as a build's hashed assets: cached for a year. Default: a path under `/assets/`. */
  immutable?: RegExp | ((path: string) => boolean);
  /** `max-age` in seconds for every other file. Default 0, which means the browser asks again each time. */
  maxAge?: number;
  /** The file a folder answers with. Default `index.html`. */
  index?: string;
};

// what a browser needs to be told; the rest goes as bytes
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
};

/** Smaller files are read at once, so a compress() hook can see them whole; larger ones are streamed. */
const WHOLE = 1024 * 1024;

/** Serves the files of a folder, and with `spa` an index.html for every path without one. */
export const serveStatic = (options: StaticOptions) =>
  plugin(
    (app) => {
      const root = resolve(options.dir);
      const prefix = (options.prefix ?? "/").replace(/\/+$/, "");
      const index = options.index ?? "index.html";
      const fallback = options.spa === true ? index : options.spa || undefined;
      const exclude = (options.exclude ?? []).map((p) => p.replace(/\/+$/, ""));
      const immutable = options.immutable ?? /\/assets\//;
      const forever = typeof immutable === "function" ? immutable : (p: string) => immutable.test(p);
      const maxAge = options.maxAge ?? 0;

      /** The file for a path inside the folder, or nothing; a path that climbs out, or a dotfile, is nothing too. */
      async function find(rel: string) {
        let decoded: string;
        try {
          decoded = decodeURIComponent(rel);
        } catch {
          return;
        }
        if (decoded.includes("\0") || decoded.split("/").some((s) => s.startsWith("."))) return;
        let file = resolve(join(root, decoded));
        if (file !== root && !file.startsWith(root + sep)) return;
        let info = await stat(file).catch(() => undefined);
        if (info?.isDirectory()) {
          file = join(file, index);
          info = await stat(file).catch(() => undefined);
        }
        return info?.isFile() ? { file, info } : undefined;
      }

      const serve = async (ctx: { method: string; path: string; headers: Record<string, string | undefined> }, rel: string) => {
        let found = await find(rel);
        let page = false;
        if (!found && fallback && !exclude.some((p) => ctx.path === p || ctx.path.startsWith(p + "/"))) {
          found = await find(fallback);
          page = true;
        }
        if (!found) throw problem(404, "not-found", `No file at ${ctx.path}`);

        const { file, info } = found;
        const tag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
        const headers: Record<string, string> = {
          "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
          "last-modified": info.mtime.toUTCString(),
          etag: tag,
          "x-content-type-options": "nosniff",
          // the page names the hashed files of this build: it must never come from a cache unasked
          "cache-control": page || extname(file) === ".html" ? "no-cache" : forever(ctx.path) ? "public, max-age=31536000, immutable" : maxAge ? `public, max-age=${maxAge}` : "no-cache",
        };
        if (ctx.headers["if-none-match"] === tag) return reply(304, undefined, headers);
        headers["content-length"] = String(info.size);
        if (ctx.method === "HEAD") return reply(200, undefined, headers);
        return reply(200, info.size <= WHOLE ? await readFile(file) : createReadStream(file), headers);
      };

      app.get(prefix || "/", { hidden: true }, (ctx) => serve(ctx as never, ""));
      app.get(`${prefix}/*path`, { hidden: true }, (ctx) => serve(ctx as never, (ctx.params as { path: string }).path));
    },
    { name: "static", shared: true },
  );

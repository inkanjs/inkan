// Compressed answers, built on nothing but the public plugin API: one onSend hook. Shared,
// so it acts on the routes of the scope it is registered in, and marked `last`, so it runs
// after every other onSend hook of a route, wherever that one was registered.
//
//   app.register(compress())   // brotli or gzip, whatever the client takes

import { promisify } from "node:util";
import { Readable } from "node:stream";
import { brotliCompress, constants, createBrotliCompress, createGzip, gzip } from "node:zlib";
import { plugin } from "../core/scope.ts";

export type CompressOptions = {
  /** Bodies smaller than this many bytes go as they are: compressing them costs more than it saves. Default 1024. */
  threshold?: number;
  /** Which encodings to offer, best first. Default `["br", "gzip"]`. */
  encodings?: ("br" | "gzip")[];
  /** Whether a media type is worth compressing. Default: text, JSON, JavaScript, XML, SVG and WebAssembly. */
  filter?: (contentType: string) => boolean;
};

const COMPRESSIBLE = /^(text\/(?!event-stream)|application\/(json|javascript|xml|wasm|manifest\+json|problem\+json|[\w.+-]*\+json|[\w.+-]*\+xml)|image\/svg\+xml)/;

// brotli's own default (11) is meant for files packed once; for an answer per request 5 is
// about as small and many times faster
const BROTLI = { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } };
const pack = { br: promisify(brotliCompress), gzip: promisify(gzip) };

/** Which encoding the client takes, from its accept-encoding: the first offered one it does not refuse. */
function chosen(accept: string | undefined, offered: ("br" | "gzip")[]) {
  if (!accept) return;
  const taken = new Map<string, number>();
  for (const part of accept.toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    taken.set(name.trim(), q ? Number(q.slice(2)) : 1);
  }
  return offered.find((e) => (taken.get(e) ?? taken.get("*") ?? 0) > 0);
}

/** Compresses answers with brotli or gzip for clients that take it. Streams too, except event streams. */
export const compress = (options: CompressOptions = {}) =>
  plugin(
    (app) => {
      const threshold = options.threshold ?? 1024;
      const offered = options.encodings ?? ["br", "gzip"];
      const worth = options.filter ?? ((type: string) => COMPRESSIBLE.test(type));

      app.onSend(async (ctx, out) => {
        if (ctx.method === "HEAD" || out.status === 204 || out.status === 304) return;
        const h = out.headers;
        if (h["content-encoding"] || !worth(h["content-type"] ?? "")) return;
        if (out.body === undefined && !out.stream) return;
        if (out.body !== undefined && Buffer.byteLength(out.body) < threshold) return;
        const encoding = chosen((ctx.headers as Record<string, string | undefined>)["accept-encoding"], offered);
        // a cache in between has to keep one copy per encoding
        h.vary = h.vary ? (/accept-encoding/i.test(h.vary) ? h.vary : `${h.vary}, accept-encoding`) : "accept-encoding";
        if (!encoding) return;
        h["content-encoding"] = encoding;
        delete h["content-length"]; // the length of the bytes before; the new one is counted when they go out
        if (out.body !== undefined) {
          const body = await (encoding === "br" ? pack.br(out.body, BROTLI) : pack.gzip(out.body));
          return { ...out, body };
        }
        const zip = encoding === "br" ? createBrotliCompress(BROTLI) : createGzip();
        return { ...out, stream: Readable.from(out.stream!).pipe(zip) };
      }, { last: true }); // after every other onSend hook: an ETag or a signature hashes the bytes before they are packed
    },
    { name: "compress", shared: true },
  );

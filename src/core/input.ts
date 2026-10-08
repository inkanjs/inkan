// Reading a request: its body, in whatever form it came, and checking params, query,
// headers and body against the route's contract.

import type { IncomingMessage } from "node:http";
import { HttpProblem, problem } from "./problem.ts";
import { INVALID, RawBodySchema, StreamSchema, type Issue, type Schema, type UploadedFile } from "../schema/schema.ts";
import type { Context, RouteRecord, Security } from "./route.ts";
import { queryObject, type RawRequest } from "./context.ts";
import { Buffer } from "node:buffer"; // explicit, for runtimes without a global Buffer

export type Body = { kind: "none" | "json" | "form" | "multipart" | "text" | "binary"; value: unknown };

/** The body of every request that has none. */
const NO_BODY: Body = Object.freeze({ kind: "none", value: undefined });

/** Whether the request carries the credentials a scheme asks for. Whether they are good is not inkan's to say. */
function presented(s: Security, ctx: Context<any, any, any, any, any>): boolean {
  const headers = ctx.headers as Record<string, string | undefined>;
  if (s === "bearer") return /^bearer\s+\S/i.test(headers.authorization ?? "");
  if (s === "basic") return /^basic\s+\S/i.test(headers.authorization ?? "");
  const where = s.in ?? "header";
  if (where === "header") return Boolean(headers[s.apiKey.toLowerCase()]);
  if (where === "query") return Boolean((ctx.query as Record<string, unknown>)[s.apiKey]);
  const cookie = headers.cookie ?? "";
  return cookie.split(";").some((part) => {
    const eq = part.indexOf("=");
    return eq > 0 && part.slice(0, eq).trim() === s.apiKey && part.slice(eq + 1).trim() !== "";
  });
}

/** What a scheme asks for, in words a caller can act on. */
export function describeSecurity(s: Security): string {
  if (s === "bearer") return "a bearer token in authorization";
  if (s === "basic") return "basic credentials in authorization";
  const where = s.in ?? "header";
  return where === "header" ? `${s.apiKey} in the headers` : where === "query" ? `${s.apiKey} in the query` : `a ${s.apiKey} cookie`;
}

function missingCredentials(schemes: Security[]): HttpProblem {
  const challenge = schemes.flatMap((s) => (s === "bearer" ? ["Bearer"] : s === "basic" ? ['Basic realm="api"'] : []));
  const p = problem(401, "unauthorized", `This route needs ${schemes.map(describeSecurity).join(" or ")}`);
  if (challenge.length) p.headers["www-authenticate"] = challenge.join(", ");
  return p;
}

export async function readMultipart(raw: RawRequest, contentType: string): Promise<Body> {
  let form: FormData;
  try {
    // the platform's own multipart parser, so there is no dependency to trust
    form = await new Response(raw.body, { headers: { "content-type": contentType } }).formData();
  } catch (e) {
    throw problem(400, "invalid-multipart", `The body is not valid multipart/form-data: ${(e as Error).message}`);
  }
  const value: Record<string, unknown> = {};
  for (const [key, entry] of form) {
    const item: unknown =
      typeof entry === "string"
        ? entry
        : ({ name: entry.name, type: entry.type, size: entry.size, data: Buffer.from(await entry.arrayBuffer()) } satisfies UploadedFile);
    const prev = value[key];
    value[key] = prev === undefined ? item : Array.isArray(prev) ? [...prev, item] : [prev, item];
  }
  return { kind: "multipart", value };
}

/** A promise only for multipart, which the platform parses asynchronously; everything else is read at once. */
export function readBody(raw: RawRequest, contentType: string): Body | Promise<Body> {
  if (!raw.body?.length) return NO_BODY;
  const ct = contentType === "application/json" ? contentType : contentType.split(";")[0].trim().toLowerCase();
  const text = () => raw.body!.toString("utf8");
  if (ct === "multipart/form-data") return readMultipart(raw, contentType);
  if (ct === "application/json" || ct.endsWith("+json")) {
    try {
      return { kind: "json", value: JSON.parse(text()) };
    } catch (e) {
      throw problem(400, "invalid-json", `The body is not valid JSON: ${(e as Error).message}`);
    }
  }
  if (ct === "application/x-www-form-urlencoded") return { kind: "form", value: queryObject(new URLSearchParams(text())) };
  if (ct.startsWith("text/") || ct === "") return { kind: "text", value: text() };
  return { kind: "binary", value: raw.body };
}

type InputError = { in: string; path: string; message: string };

/** One part of the input against its schema: the checked value, or the value as it came with what is wrong added to `errors`. */
function part(where: string, schema: Schema<any>, value: unknown, coerce: boolean, found: Issue[], errors: InputError[]): unknown {
  const v = schema._into(value, coerce, found);
  if (v !== INVALID) return v;
  for (const i of found) errors.push({ in: where, path: i.path, message: i.message });
  found.length = 0;
  return value;
}

/** One 400 for everything that broke the contract, naming where. */
function invalid(errors: InputError[]): HttpProblem {
  const where = [...new Set(errors.map((e) => e.in))].join(" and ");
  return new HttpProblem(400, "validation", `The ${where} does not match the contract`, { errors });
}

/** The body, read, against its schema; form fields arrive as text, like a query, and are turned into what the schema asks for. */
function checkBody(ctx: Context<any, any, any, any, any>, schema: Schema<any> | undefined, body: Body, found: Issue[], errors: InputError[]) {
  if (schema && (body.kind === "binary" || body.kind === "text")) {
    throw problem(415, "unsupported-media-type", "Send the body as application/json, application/x-www-form-urlencoded or multipart/form-data");
  }
  ctx.body = schema ? part("body", schema, body.value, body.kind === "form" || body.kind === "multipart", found, errors) : body.value;
  if (errors.length) throw invalid(errors);
}

/** Checks params, query, headers and body together. Returns a promise only when a body had to be read asynchronously. */
export function validateInput(
  ctx: Context<any, any, any, any, any>,
  route: RouteRecord,
  params: Record<string, string>,
  raw: RawRequest,
): void | Promise<void> {
  // a route that checks nothing and got no body: its params as they are, and nothing else to do
  if (!route.checksInput && !raw.body?.length) {
    ctx.params = params;
    return;
  }
  const { spec } = route;
  // who is asking comes first: without the credentials the route asks for, nothing else matters
  if (route.security?.length && !route.security.some((s) => presented(s, ctx))) throw missingCredentials(route.security);
  const found: Issue[] = []; // what one part breaks, before it goes into errors
  const errors: InputError[] = [];

  // read before a header schema strips the headers it does not list
  const contentType = (ctx.headers as Record<string, string>)["content-type"] ?? "";
  // only what the contract names: a query nobody checks stays uncut until someone reads it
  ctx.params = spec.params ? part("params", spec.params, params, true, found, errors) : params;
  if (spec.query) ctx.query = part("query", spec.query, ctx.query, true, found, errors);
  if (spec.headers) ctx.headers = part("headers", spec.headers, ctx.headers, true, found, errors);

  // a body taken as it comes: not parsed, only its media type checked, and a stream left unread
  if (spec.body instanceof RawBodySchema) {
    const type = contentType.split(";")[0].trim().toLowerCase();
    const sent = raw.stream !== undefined || Boolean(raw.body?.length);
    if (sent && !spec.body.accepts(type)) {
      throw problem(415, "unsupported-media-type", `Send the body as ${spec.body.mediaTypes().join(" or ")}, not ${type || "without a type"}`);
    }
    const value =
      spec.body instanceof StreamSchema
        ? limited(raw.stream ?? chunks(raw.body), route.bodyLimit ?? Infinity)
        : sent
          ? raw.body ?? Buffer.alloc(0)
          : spec.body.meta.optional
            ? undefined
            : Buffer.alloc(0);
    ctx.body = part("body", spec.body, value, false, found, errors);
    if (errors.length) throw invalid(errors);
    return;
  }

  const body = readBody(raw, contentType);
  if (body instanceof Promise) return body.then((b) => checkBody(ctx, spec.body, b, found, errors));
  checkBody(ctx, spec.body, body, found, errors);
}

export const TOO_LARGE = Symbol("too large");

/** How much of a body nobody reads is still taken in and let go, so the answer reaches the client; past it the connection is cut. */
const DRAIN = 16 * 1024 * 1024;

/**
 * A request's body as it arrives, for a route that takes a stream. Read with `read()`
 * rather than the request's own iterator: that one destroys the socket when the reader
 * stops, and the answer (a 413, a problem the handler threw) would never arrive. Here a
 * reader that stops early leaves the rest to be read and let go.
 */
export function requestStream(req: IncomingMessage): AsyncIterable<Buffer> {
  return {
    async *[Symbol.asyncIterator]() {
      let finished = false;
      try {
        for (;;) {
          const chunk = req.read() as Buffer | null;
          if (chunk !== null) {
            yield chunk;
            continue;
          }
          if (req.readableEnded) return void (finished = true);
          await new Promise<void>((resolve, reject) => {
            const done = (err?: Error) => {
              req.off("readable", ok).off("end", ok).off("error", done);
              err ? reject(err) : resolve();
            };
            const ok = () => done();
            req.on("readable", ok).on("end", ok).on("error", done);
          });
        }
      } finally {
        if (!finished && !req.destroyed) {
          let left = DRAIN;
          req.on("data", (c: Buffer) => {
            if ((left -= c.length) < 0) req.destroy();
          });
          req.resume();
        }
      }
    },
  };
}

/** A whole body as a stream of one chunk, for a stream route reached by inject, fetch or an adapter. */
async function* chunks(body: Buffer | undefined): AsyncIterable<Buffer> {
  if (body?.length) yield body;
}

/** The body's chunks as they arrive, and a 413 problem the moment there are more than `limit` bytes. */
async function* limited(source: AsyncIterable<Buffer>, limit: number): AsyncIterable<Buffer> {
  let size = 0;
  for await (const chunk of source) {
    size += chunk.length;
    if (size > limit) throw problem(413, "body-too-large", `Request bodies may be at most ${limit} bytes`);
    yield chunk;
  }
}

/** Reads a request body with plain events, and calls back once: no promise, no extra turn. */
export function readRequestBody(req: IncomingMessage, limit: number, done: (err: unknown, read?: Buffer | typeof TOO_LARGE) => void): void {
  let chunks: Buffer[] | undefined;
  let first: Buffer | undefined;
  let size = 0;
  let over = false;
  const onData = (chunk: Buffer) => {
    size += chunk.length;
    if (size > limit) {
      over = true;
      req.off("data", onData);
      req.pause(); // stop reading; the 413 closes the connection
      done(undefined, TOO_LARGE);
      return;
    }
    // most bodies come in one chunk: no list for those
    if (!first) first = chunk;
    else (chunks ??= [first]).push(chunk);
  };
  req.on("data", onData);
  req.once("end", () => over || done(undefined, chunks ? Buffer.concat(chunks, size) : first));
  req.once("error", (err) => over || done(err));
}

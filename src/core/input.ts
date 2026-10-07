// Reading a request: its body, in whatever form it came, and checking params, query,
// headers and body against the route's contract.

import type { IncomingMessage } from "node:http";
import { HttpProblem, problem } from "./problem.ts";
import type { Issue, Schema, UploadedFile } from "../schema/schema.ts";
import type { Context, RouteRecord, Security } from "./route.ts";
import { queryObject, type RawRequest } from "./context.ts";
import { Buffer } from "node:buffer"; // explicit, for runtimes without a global Buffer

export type Body = { kind: "none" | "json" | "form" | "multipart" | "text" | "binary"; value: unknown };

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
  if (!raw.body?.length) return { kind: "none", value: undefined };
  const ct = contentType.split(";")[0].trim().toLowerCase();
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

/** Checks params, query, headers and body together. Returns a promise only when a body had to be read asynchronously. */
export function validateInput(
  ctx: Context<any, any, any, any, any>,
  route: RouteRecord,
  params: Record<string, string>,
  raw: RawRequest,
): void | Promise<void> {
  const { spec } = route;
  // who is asking comes first: without the credentials the route asks for, nothing else matters
  if (route.security?.length && !route.security.some((s) => presented(s, ctx))) throw missingCredentials(route.security);
  const errors: { in: string; path: string; message: string }[] = [];
  const take = (where: string, schema: Schema<any> | undefined, value: unknown, coerce: boolean) => {
    if (!schema) return value;
    const r = schema.safeParse(value, { coerce });
    if (r.ok) return r.value;
    errors.push(...r.issues.map((i: Issue) => ({ in: where, path: i.path, message: i.message })));
    return value;
  };

  // read before a header schema strips the headers it does not list
  const contentType = (ctx.headers as Record<string, string>)["content-type"] ?? "";
  ctx.params = take("params", spec.params, params, true);
  ctx.query = take("query", spec.query, ctx.query, true);
  ctx.headers = take("headers", spec.headers, ctx.headers, true);

  const finish = (body: Body) => {
    if (spec.body && (body.kind === "binary" || body.kind === "text")) {
      throw problem(415, "unsupported-media-type", "Send the body as application/json, application/x-www-form-urlencoded or multipart/form-data");
    }
    // form fields arrive as text, like a query, so they are turned into what the schema asks for
    ctx.body = take("body", spec.body, body.value, body.kind === "form" || body.kind === "multipart");
    if (errors.length) {
      const where = [...new Set(errors.map((e) => e.in))].join(" and ");
      throw new HttpProblem(400, "validation", `The ${where} does not match the contract`, { errors });
    }
  };
  const body = readBody(raw, contentType);
  return body instanceof Promise ? body.then(finish) : finish(body);
}

export const TOO_LARGE = Symbol("too large");

/** Reads a request body with plain events, which is cheaper than an async iterator per chunk. */
export function readRequestBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined | typeof TOO_LARGE> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.off("data", onData);
        req.pause(); // stop reading; the 413 closes the connection
        resolve(TOO_LARGE);
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => resolve(chunks.length === 0 ? undefined : chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size)));
    req.once("error", reject);
  });
}

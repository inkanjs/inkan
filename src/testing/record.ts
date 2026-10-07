// Turns a request the inspector saw into an `examples: [...]` entry, so real
// traffic can become part of the contract with one copy and paste.

import type { LogEntry } from "../core/app.ts";

// Headers every client sends anyway, or ones that would be wrong to pin in a test.
const SKIP = new Set([
  "host", "connection", "content-length", "content-type", "user-agent", "accept", "accept-encoding",
  "accept-language", "origin", "referer", "cache-control", "pragma", "priority", "dnt", "te",
  "x-request-id", "x-inkan-replay", "authorization", "cookie", "proxy-authorization", "x-api-key",
]);

const IDENT = /^[A-Za-z_$][\w$]*$/;
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

const scalar = (v: string): string | number => (NUMBER.test(v) && v.length < 16 ? Number(v) : v);

/** A JavaScript literal with bare keys where they are allowed, the way an example is written by hand. */
export function literal(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(literal).join(", ")}]`;
  if (v && typeof v === "object") {
    const parts = Object.entries(v).map(([k, x]) => `${IDENT.test(k) ? k : JSON.stringify(k)}: ${literal(x)}`);
    return parts.length ? `{ ${parts.join(", ")} }` : "{}";
  }
  return JSON.stringify(v) ?? "undefined";
}

function paramsFrom(route: string, path: string): Record<string, string | number> | undefined {
  const pattern = route.split("/").filter(Boolean);
  const actual = path.split("/").filter(Boolean);
  const out: Record<string, string | number> = {};
  for (const [i, seg] of pattern.entries()) {
    if (seg.startsWith("*")) {
      out[seg.slice(1) || "rest"] = actual.slice(i).map(decodeURIComponent).join("/");
      break;
    }
    if (seg.startsWith(":")) out[seg.slice(1)] = scalar(decodeURIComponent(actual[i] ?? ""));
  }
  return Object.keys(out).length ? out : undefined;
}

function queryFrom(search: string): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(search)) {
    const prev = out[k];
    out[k] = prev === undefined ? scalar(v) : [...(Array.isArray(prev) ? prev : [prev]), scalar(v)];
  }
  return Object.keys(out).length ? out : undefined;
}

function bodyFrom(entry: LogEntry): unknown {
  const { body, clipped, headers } = entry.request;
  if (!body || clipped) return undefined;
  const type = (headers["content-type"] ?? "").toLowerCase();
  if (type.includes("json")) {
    try {
      return JSON.parse(body);
    } catch {
      return undefined; // it was rejected as invalid JSON anyway
    }
  }
  if (type.includes("x-www-form-urlencoded")) return queryFrom(body);
  return undefined;
}

/** The example for one inspector entry, or undefined when no route answered it. */
export function exampleFrom(entry: LogEntry): string | undefined {
  if (!entry.route) return undefined;
  const q = entry.path.indexOf("?");
  const path = q < 0 ? entry.path : entry.path.slice(0, q);
  const search = q < 0 ? "" : entry.path.slice(q + 1);

  const example: Record<string, unknown> = { name: `recorded ${entry.at.slice(11, 19)}` };
  const params = paramsFrom(entry.route, path);
  if (params) example.params = params;
  const query = queryFrom(search);
  if (query) example.query = query;
  const headers = Object.fromEntries(
    Object.entries(entry.request.headers).filter(([k, v]) => !SKIP.has(k) && !k.startsWith("sec-") && v !== "•••"),
  );
  if (Object.keys(headers).length) example.headers = headers;
  const body = bodyFrom(entry);
  if (body !== undefined) example.body = body;
  example.status = entry.status;
  return `${literal(example)},`;
}

// One request inside the app: its target, the context a handler gets, and what travels
// with it from routing to the answer.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Reply, type Context, type RouteRecord } from "./route.ts";
import type { Hooks } from "./scope.ts";
import type { RawQuery } from "./route.ts";

export type RawRequest = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
  /** The body, unread, for a route that takes it as a stream; `body` stays undefined then. */
  stream?: AsyncIterable<Buffer>;
  remote?: string;
  req?: IncomingMessage;
  res?: ServerResponse;
};

export type RawResponse = {
  status: number;
  headers: Record<string, string>;
  body?: string | Buffer;
  /** Sent piece by piece instead of `body`. */
  stream?: AsyncIterable<Uint8Array | string>;
  /** Tells the stream's source that nobody is reading any more. */
  abort?: AbortController;
  /** Called once the answer is written, for onResponse hooks. */
  done?: () => void;
};

/** One request on its way through the app: what every step after routing needs. */
export type Exchange = {
  raw: RawRequest;
  url: Target;
  ctx: Context<any, any, any, any, any>;
  out: { status: number; headers: Record<string, string> };
  notes: string[];
  headers: Record<string, string>;
  started: number;
  timed: boolean;
  /** The request id, when the app sends one. */
  id: string | undefined;
  route: RouteRecord | undefined;
  /** The hooks of the route's scope chain, or of the app when no route matched. */
  hooks: Hooks;
};

/** A request target split into its path and its query. A class, so every one has the same shape. */
export class Target {
  pathname: string;
  search: string;
  constructor(pathname: string, search: string) {
    this.pathname = pathname;
    this.search = search;
  }
  get searchParams() {
    return new URLSearchParams(this.search);
  }
}

/**
 * The context of one request. A class, so every context has the same shape and the
 * `url` getter lives on the prototype. `status` and `header` stay own functions:
 * handlers take them apart (`({ status }) => …`), so they must not need `this`.
 */
export class RequestContext {
  method: string;
  path: string;
  id: string;
  params: unknown = {};
  query: unknown;
  headers: unknown;
  body: unknown = undefined;
  state: Record<string, unknown> = {};
  route?: { method: string; path: string } = undefined;
  req?: IncomingMessage;
  res?: ServerResponse;
  status: (code: number) => void;
  header: (name: string, value: string) => void;
  private target: Target;
  private host?: string;
  private remote?: string;
  constructor(raw: RawRequest, target: Target, id: string, headers: Record<string, string>, out: { status: number; headers: Record<string, string> }) {
    this.remote = raw.remote;
    this.method = raw.method;
    this.path = target.pathname;
    this.id = id;
    this.query = target.search ? parseQuery(target.search) : {};
    this.headers = headers;
    this.req = raw.req;
    this.res = raw.res;
    this.target = target;
    this.host = headers.host; // kept here: a header schema may later strip it from ctx.headers
    this.status = (code) => void (out.status = code);
    this.header = (name, value) => void (out.headers[name.toLowerCase()] = value);
  }
  /** The client's address: the platform's word for it, or the socket's. */
  get ip(): string | undefined {
    const r = this.remote ?? this.req?.socket.remoteAddress;
    return r === "unknown" ? undefined : r;
  }
  /** Built only when a handler asks for it; most never do. */
  get url(): URL {
    const u = new URL("http://" + (this.host || "localhost"));
    u.pathname = this.target.pathname;
    u.search = this.target.search;
    return u;
  }
  reply(status: number, body: unknown, headers?: Record<string, string>) {
    return new Reply(status, body, headers);
  }
}

/**
 * Splits a request target into its path and its query. Not `new URL()`: that reads a path
 * like `//elsewhere/x` as a host and routes it as `/x`. A proxy's absolute form
 * (`scheme://host/path`) loses its scheme and host first.
 */
export function target(raw: string): Target {
  const local = raw.startsWith("/") ? raw : raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "") || "/";
  const q = local.indexOf("?");
  const pathname = q < 0 ? local : local.slice(0, q);
  const search = q < 0 || q === local.length - 1 ? "" : local.slice(q);
  return new Target(pathname || "/", search);
}

export function queryObject(sp: URLSearchParams): RawQuery {
  const o: RawQuery = {};
  for (const [k, v] of sp) addQuery(o, k, v);
  return o;
}

/**
 * A query string (with its `?`) as an object. A query with nothing to decode, the usual
 * `?page=2&sort=name`, is cut apart in place; one with `%` or `+` goes through
 * URLSearchParams, so decoding stays exactly the platform's.
 */
export function parseQuery(search: string): RawQuery {
  if (search.includes("%") || search.includes("+")) return queryObject(new URLSearchParams(search));
  const o: RawQuery = {};
  let i = search.charCodeAt(0) === 63 ? 1 : 0; // "?"
  while (i <= search.length) {
    let end = search.indexOf("&", i);
    if (end < 0) end = search.length;
    if (end > i) {
      const eq = search.indexOf("=", i);
      if (eq < 0 || eq > end) addQuery(o, search.slice(i, end), "");
      else addQuery(o, search.slice(i, eq), search.slice(eq + 1, end));
    }
    i = end + 1;
  }
  return o;
}

function addQuery(o: RawQuery, k: string, v: string) {
  const prev = o[k];
  o[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
}

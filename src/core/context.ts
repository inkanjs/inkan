// One request inside the app: its target, the context a handler gets, and what travels
// with it from routing to the answer.

import type { IncomingMessage, ServerResponse } from "node:http";
import { Reply, type Context, type RouteInfo, type RouteRecord } from "./route.ts";
import type { Hooks } from "./scope.ts";
import type { RawQuery } from "./route.ts";
import { NO_PARAMS } from "./router.ts";
import { problem } from "./problem.ts";
import { csvChunks, isRedirect, parseCookies, SafeHtml, serializeCookie, type CookieOptions, type CsvOptions, type RedirectStatus } from "./helpers.ts";

export type RawRequest = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
  /** The body, unread, for a route that takes it as a stream; `body` stays undefined then. */
  stream?: AsyncIterable<Buffer>;
  remote?: string;
  /** Whether the request came over TLS, where the platform says so (`fetch`: the URL's scheme). Otherwise the socket tells. */
  secure?: boolean;
  req?: IncomingMessage;
  res?: ServerResponse;
  /** Aborted when the client goes away, where the platform says so (`fetch`). */
  signal?: AbortSignal;
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
  /** Set-Cookie headers, one per cookie: a header object holds only one of each name. */
  cookies?: string[];
};

/** How a scope wraps the pages its handlers render: `app.layout(...)`. */
export type Layout = (content: SafeHtml, props: Record<string, unknown>, ctx: Context<any, any, any, any, any>) => SafeHtml | string | Promise<SafeHtml | string>;

/** One request on its way through the app: what every step after routing needs. */
export type Exchange = {
  raw: RawRequest;
  url: Target;
  ctx: Context<any, any, any, any, any>;
  /** The answer, filled in as the request goes: status and headers first, the body last. */
  out: RawResponse;
  /** Only kept when something reads them: the log, the inspector, an onResponse hook. */
  notes: string[] | undefined;
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
 * getters live on the prototype. Nothing is made before it is asked for: the query is cut
 * apart, `state` created and `status` and `header` bound only on first use. `status` and
 * `header` are bound functions all the same, since handlers take them apart
 * (`({ status }) => …`) and they must not need `this`.
 */
export class RequestContext {
  method: string;
  path: string;
  id: string;
  params: unknown = NO_PARAMS;
  headers: unknown;
  body: unknown = undefined;
  route?: RouteInfo = undefined;
  req?: IncomingMessage;
  res?: ServerResponse;
  private target: Target;
  /** The request as it arrived: its headers stay whole however a header schema cuts `ctx.headers`. */
  private raw: RawRequest;
  private _abort: AbortController | undefined = undefined;
  private _gone: unknown = undefined;
  private out: RawResponse;
  private _query: unknown = undefined;
  private _state: Record<string, unknown> | undefined = undefined;
  private _status: ((code: number) => void) | undefined = undefined;
  private _header: ((name: string, value: string) => void) | undefined = undefined;
  private _cookies: Record<string, string> | undefined = undefined;
  private _setCookie: ((name: string, value: string, options?: CookieOptions) => void) | undefined = undefined;
  private _clearCookie: ((name: string, options?: Pick<CookieOptions, "path" | "domain">) => void) | undefined = undefined;
  private _render: ((content: SafeHtml | string, props?: Record<string, unknown>) => Reply | Promise<Reply>) | undefined = undefined;
  /** The layout of the scope this context belongs to; set on the prototype by `layout()`. */
  declare _layout?: Layout;
  constructor(raw: RawRequest, target: Target, id: string, headers: Record<string, string>, out: RawResponse) {
    this.raw = raw;
    this.method = raw.method;
    this.path = target.pathname;
    this.id = id;
    this.headers = headers;
    this.req = raw.req;
    this.res = raw.res;
    this.target = target;
    this.out = out;
    // Made here, not on first use: filled lazily, these fields cost more under load than
    // they save (measured: about 10 % fewer requests per second over HTTP).
    this._query = target.search ? parseQuery(target.search) : {};
    this._state = {};
    this._status = (code) => void (out.status = code);
    this._header = (name, value) => void (out.headers[name.toLowerCase()] = value);
  }
  // Plain getters on the prototype: no proxy, nothing tracked. The setters are there because
  // the contract puts the checked values back.
  get query(): unknown {
    return (this._query ??= this.target.search ? parseQuery(this.target.search) : {});
  }
  set query(value: unknown) {
    this._query = value;
  }
  get state(): Record<string, unknown> {
    return (this._state ??= {});
  }
  set state(value: Record<string, unknown>) {
    this._state = value;
  }
  get status(): (code: number) => void {
    return (this._status ??= (code) => void (this.out.status = code));
  }
  get header(): (name: string, value: string) => void {
    return (this._header ??= (name, value) => void (this.out.headers[name.toLowerCase()] = value));
  }
  /** The client's address: the platform's word for it, or the socket's. */
  get ip(): string | undefined {
    const r = this.raw.remote ?? this.req?.socket.remoteAddress;
    return r === "unknown" ? undefined : r;
  }
  /**
   * The request's headers as they arrived, names in lower case, even where the route's
   * header schema cut `ctx.headers` down to its contract. The request's own object, not a
   * copy: read it, do not change it.
   */
  get rawHeaders(): Readonly<Record<string, string | string[] | undefined>> {
    return this.raw.headers;
  }
  /**
   * Whether the request came over TLS: the socket's word, or the platform's (`fetch`: the
   * URL's scheme). With `trustProxy`, what the trusted proxies forward (x-forwarded-proto,
   * or forwarded's `proto=`).
   */
  get secure(): boolean {
    return this.raw.secure ?? (this.req?.socket as { encrypted?: boolean } | undefined)?.encrypted === true;
  }
  /** "https" when the request came over TLS (see `secure`), otherwise "http". */
  get protocol(): "http" | "https" {
    return this.secure ? "https" : "http";
  }
  /** Built only when a handler asks for it; most never do. */
  get url(): URL {
    const u = new URL(this.protocol + "://" + (this.head("host") || "localhost"));
    u.pathname = this.target.pathname;
    u.search = this.target.search;
    return u;
  }
  reply(status: number, body: unknown, headers?: Record<string, string>) {
    return new Reply(status, body, headers);
  }

  // ----- answers besides JSON. None of them needs `this`, or they are bound like `status`,
  // so a handler can take them apart: `({ html, params }) => html(...)`.

  /** Plain text. The status is the one `status()` set, or the usual one, unless given here. */
  text(body: string, status?: number): Reply {
    return new Reply(status ?? 0, body, { "content-type": "text/plain; charset=utf-8" });
  }
  /** HTML. Write it with the `html` tag, which escapes every value put into it. */
  html(markup: SafeHtml | string, status?: number): Reply {
    return new Reply(status ?? 0, String(markup), { "content-type": "text/html; charset=utf-8" });
  }
  /** Sends the client elsewhere, 302 unless told otherwise. */
  redirect(to: string, status: RedirectStatus = 302): Reply {
    if (!isRedirect(status)) throw new TypeError(`A redirect has the status 301, 302, 303, 307 or 308, not ${status}`);
    // a header carries no character outside visible ASCII: anything else is percent-encoded first
    return new Reply(status, undefined, { location: /[^\x21-\x7e]/.test(to) ? encodeURI(to) : to });
  }
  /** Ends the request with a 404 problem, the same one an unknown route gets. `return ctx.notFound()` reads well. */
  notFound(detail?: string): never {
    throw problem(404, "not-found", detail);
  }

  /**
   * Aborted when the client goes away before the answer is out, or when the route's
   * `timeout` runs out. Hand it to the database driver or to `fetch`, and a query nobody
   * waits for any more stops. Made on first use.
   */
  get signal(): AbortSignal {
    if (!this._abort) {
      const ctl = (this._abort = new AbortController());
      if (this._gone !== undefined) ctl.abort(this._gone);
      const res = this.res;
      // "close" also comes after an answer that went out whole; only before that is it the client leaving
      if (res) res.once("close", () => res.writableFinished || ctl.abort(new DOMException("The client went away", "AbortError")));
      const given = this.raw.signal;
      if (given) given.aborted ? ctl.abort(given.reason) : given.addEventListener("abort", () => ctl.abort(given.reason), { once: true });
    }
    return this._abort.signal;
  }
  /** @internal Aborts the signal, now or once it is made: the route ran out of time. */
  _stop(reason: unknown) {
    this._gone = reason;
    this._abort?.abort(reason);
  }
  /** @internal Who is asking, for a cache kept per caller. */
  _caller(): string {
    return `${this.head("authorization") ?? ""}\n${this.head("cookie") ?? ""}`;
  }
  /** One header as it arrived. */
  private head(name: string): string | undefined {
    return this.raw.headers[name] as string | undefined;
  }
  /** @internal The answer as it stands, for a cache that replays a status and headers. */
  _out(): RawResponse {
    return this.out;
  }

  /**
   * Rows as a CSV file, written as they come: an array, or a generator over the database's
   * cursor, so a million rows never sit in memory at once.
   */
  csv(rows: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>, options: CsvOptions = {}): Reply {
    const headers: Record<string, string> = { "content-type": "text/csv; charset=utf-8" };
    if (options.filename) headers["content-disposition"] = `attachment; filename="${options.filename.replace(/["\\\r\n]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(options.filename)}`;
    return new Reply(0, csvChunks(rows, options), headers);
  }

  /** The request's cookies, by name, read on first use. */
  get cookies(): Record<string, string> {
    return (this._cookies ??= parseCookies(this.head("cookie")));
  }
  /** Sets a cookie on the answer: HttpOnly and SameSite=Lax unless told otherwise. */
  get setCookie(): (name: string, value: string, options?: CookieOptions) => void {
    return (this._setCookie ??= (name, value, options) => void (this.out.cookies ??= []).push(serializeCookie(name, value, options)));
  }
  /** Tells the browser to forget a cookie. Give the path and domain it was set with, if they were not the defaults. */
  get clearCookie(): (name: string, options?: Pick<CookieOptions, "path" | "domain">) => void {
    return (this._clearCookie ??= (name, options) => this.setCookie(name, "", { ...options, maxAge: 0, expires: new Date(0) }));
  }
  /** HTML in the layout of this route's scope (`app.layout(...)`), or as it is when there is none. */
  get render(): (content: SafeHtml | string, props?: Record<string, unknown>) => Reply | Promise<Reply> {
    return (this._render ??= (content, props = {}) => {
      const layout = this._layout;
      if (!layout) return this.html(content);
      const page = layout(content instanceof SafeHtml ? content : new SafeHtml(String(content)), props, this as never);
      return page instanceof Promise ? page.then((p) => this.html(p)) : this.html(page);
    });
  }
}

/**
 * Which proxies to believe about the client's address: `true` for every one (the address
 * the request was first forwarded for), a number for that many hops in front of the app,
 * or a function that says whether an address is a proxy of yours.
 */
export type TrustProxy = boolean | number | ((ip: string) => boolean);

/**
 * The context class of an app with `trustProxy`: `ctx.ip` reads x-forwarded-for, or
 * forwarded when there is none, and `ctx.secure` x-forwarded-proto, or forwarded's
 * `proto=`. Both read the request's own headers, since a header schema may strip them from
 * `ctx.headers`. An app without `trustProxy` never uses it, so it pays nothing for it.
 */
export function trustingContext(Base: typeof RequestContext, trust: TrustProxy): typeof RequestContext {
  return class extends Base {
    override get ip(): string | undefined {
      return clientIp(super.ip, this.rawHeaders as Record<string, string | undefined>, trust);
    }
    override get secure(): boolean {
      return clientSecure(super.secure, super.ip, this.rawHeaders as Record<string, string | undefined>, trust);
    }
  };
}

/** The client's address behind the proxies `trust` names, walking the forwarded chain back from the socket. */
export function clientIp(socket: string | undefined, headers: Record<string, string | undefined>, trust: TrustProxy): string | undefined {
  const list = forwardedFor(headers);
  if (!list.length || trust === false) return socket;
  if (trust === true) return list[0];
  const chain = [...list, socket ?? ""]; // the socket is the nearest hop
  let i = chain.length - 1;
  if (typeof trust === "number") i = Math.max(0, i - trust);
  else while (i > 0 && trust(chain[i]!)) i--;
  return chain[i] || undefined;
}

/**
 * Whether the client's own connection was TLS, as the proxies `trust` names tell it,
 * counted back from the socket as `clientIp` walks. `secure` is the socket's word, kept
 * when no believed proxy says anything.
 */
export function clientSecure(secure: boolean, socket: string | undefined, headers: Record<string, string | undefined>, trust: TrustProxy): boolean {
  const protos = forwardedProtos(headers);
  if (!protos.length || trust === false) return secure;
  const list = forwardedFor(headers);
  const chain = [...list, socket ?? ""]; // the socket is the nearest hop
  let hops: number; // how many proxies, counted back from the socket, are believed
  if (trust === true) hops = chain.length;
  else if (typeof trust === "number") hops = trust;
  else for (hops = 0; hops < chain.length && trust(chain[chain.length - 1 - hops]!); hops++);
  if (hops < 1) return secure;
  // each proxy appends the scheme it was reached over, so the schemes line up with the
  // addresses from the end; a proxy that overwrites the header leaves only its own
  const i = Math.max(0, list.length - hops) - (list.length - protos.length);
  return protos[Math.min(Math.max(i, 0), protos.length - 1)] === "https";
}

/** The schemes a request was forwarded over, in lower case, the client's first. */
function forwardedProtos(headers: Record<string, string | undefined>): string[] {
  const xfp = headers["x-forwarded-proto"];
  if (xfp) return xfp.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const fwd = headers.forwarded;
  if (!fwd) return [];
  const out: string[] = [];
  for (const element of fwd.split(",")) {
    const m = /(?:^|;)\s*proto\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(element);
    if (m) out.push((m[1] ?? m[2] ?? "").trim().toLowerCase());
  }
  return out.filter(Boolean);
}

/** The addresses a request was forwarded for, the client's first. */
function forwardedFor(headers: Record<string, string | undefined>): string[] {
  const xff = headers["x-forwarded-for"];
  if (xff) return xff.split(",").map((s) => s.trim()).filter(Boolean);
  const fwd = headers.forwarded;
  if (!fwd) return [];
  const out: string[] = [];
  // RFC 7239: `for=192.0.2.60;proto=http, for="[2001:db8::17]:4711"`
  for (const element of fwd.split(",")) {
    const m = /(?:^|;)\s*for\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(element);
    if (!m) continue;
    const v = (m[1] ?? m[2] ?? "").trim();
    if (v.startsWith("[")) out.push(v.slice(1, v.indexOf("]") > 0 ? v.indexOf("]") : undefined)); // IPv6, maybe with a port
    else out.push(v.split(":").length === 2 ? v.slice(0, v.indexOf(":")) : v); // IPv4 with a port, or a bare address
  }
  return out.filter(Boolean);
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

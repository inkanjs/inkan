import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HttpProblem, problem, type ProblemBody } from "./problem.ts";
import { Router } from "./router.ts";
import { t, type Infer, type Issue, type Schema } from "./schema.ts";
import { buildOpenAPI, type OpenAPIInfo } from "./openapi.ts";
import { docsPage, inspectorPage } from "./pages.ts";
import { exampleFrom } from "./record.ts";
import { runChecks, type CheckOptions, type CheckReport } from "./check.ts";
import { paint, useColor } from "./color.ts";

// ---------- types ----------

export type Responses = { [status: number]: Schema<any> };

export type Example = {
  name?: string;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  /** The status this example has to answer with. Defaults to the first 2xx in `response`. */
  status?: number;
  /** A part of the response body that has to be in the answer, compared deeply. */
  expect?: unknown;
  /** Values to keep from this answer for examples that come after it: `{ id: "body.id" }`. */
  keep?: Record<string, string>;
  /**
   * Another example that runs first, as `"POST /teas > a new oolong"`. What it keeps fills
   * `{name}` placeholders in this example's params, query, headers and body.
   */
  after?: string;
};

export type RouteSpec<P, Q, B, H, R extends Responses> = {
  summary?: string;
  description?: string;
  tags?: string[];
  operationId?: string;
  deprecated?: boolean;
  /** Keeps the route out of the docs and the OpenAPI document. */
  hidden?: boolean;
  params?: Schema<P>;
  query?: Schema<Q>;
  headers?: Schema<H>;
  body?: Schema<B>;
  response?: R;
  examples?: Example[];
  /** Middleware for this route only. It runs after the input was validated. */
  use?: Middleware[];
};

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type ParamsOf<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? { [K in Name]: string } & ParamsOf<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? { [K in Name]: string }
    : P extends `${string}*${infer W}`
      ? { [K in W extends "" ? "rest" : W]: string }
      : {};
export type PathParams<P extends string> = string extends P ? Record<string, string> : Simplify<ParamsOf<P>>;

type RawQuery = Record<string, string | string[]>;
type RawHeaders = Record<string, string | undefined>;

type SuccessStatus = 200 | 201 | 202 | 203 | 206 | 207;
type SuccessBody<R> = {} extends R
  ? unknown
  : { [K in keyof R]: K extends SuccessStatus ? Infer<R[K]> : never }[keyof R];

export class Reply<S extends number = number, Body = unknown> {
  status: S;
  body: Body;
  headers: Record<string, string>;
  constructor(status: S, body: Body, headers: Record<string, string> = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

/** Answers with a status that is not the default one, or with extra headers. */
export const reply = <S extends number, B>(status: S, body?: B, headers?: Record<string, string>) =>
  new Reply(status, body, headers);

export type Context<P = Record<string, string>, Q = RawQuery, B = unknown, H = RawHeaders, R extends Responses = {}> = {
  method: string;
  path: string;
  url: URL;
  /** The request id: taken from the request id header when it looks safe, otherwise a fresh UUID. */
  id: string;
  params: P;
  query: Q;
  headers: H;
  body: B;
  /** Free space for middleware to hand things to the handler. */
  state: Record<string, unknown>;
  /** The route that matched, as it was written. Undefined before routing. */
  route?: { method: string; path: string };
  /** Sets the status used when the handler returns a plain value. */
  status(code: number): void;
  header(name: string, value: string): void;
  reply<S extends keyof R & number>(status: S, body: Infer<R[S]>, headers?: Record<string, string>): Reply<S>;
  /** Only there when the request came through a socket, not through `inject`. */
  req?: IncomingMessage;
  res?: ServerResponse;
};

type Result<R extends Responses> = SuccessBody<R> | Reply | void;
export type Handler<P, Q, B, H, R extends Responses> = (ctx: Context<P, Q, B, H, R>) => Result<R> | Promise<Result<R>>;
export type Middleware = (ctx: Context<any, any, any, any, any>, next: () => Promise<void>) => unknown;

export type RouteRecord = {
  method: string;
  path: string;
  spec: RouteSpec<any, any, any, any, Responses>;
  handler: Handler<any, any, any, any, any>;
  use: Middleware[];
};

type RouteMethod<Self> = {
  <
    Path extends string,
    P = PathParams<Path>,
    Q = RawQuery,
    B = undefined,
    H = RawHeaders,
    R extends Responses = {},
  >(
    path: Path,
    spec: RouteSpec<P, Q, B, H, R>,
    handler: Handler<P, Q, B, H, R>,
  ): Self;
  <Path extends string>(path: Path, handler: Handler<PathParams<Path>, RawQuery, unknown, RawHeaders, {}>): Self;
};

// ---------- route tables ----------

const joinPath = (a: string, b: string) => "/" + [a, b].join("/").split("/").filter(Boolean).join("/");

/** A set of routes that can be mounted under a prefix. */
export class Routes {
  /** @internal */
  _records: RouteRecord[] = [];
  /** @internal */
  _use: Middleware[] = [];

  /** For a group, middleware that every route in it gets. Add it before mounting. */
  use(...mw: Middleware[]): this {
    this._use.push(...mw);
    return this;
  }

  protected define(method: string, path: string, a: unknown, b?: unknown): this {
    const [spec, handler] = typeof a === "function" ? [{}, a] : [a, b];
    const s = spec as RouteRecord["spec"];
    this.add({ method, path, spec: s, handler: handler as RouteRecord["handler"], use: s.use ?? [] });
    return this;
  }

  /** @internal */
  add(r: RouteRecord) {
    this._records.push({ ...r, use: [...this._use, ...r.use] });
  }

  get: RouteMethod<this> = ((p: string, a: unknown, b?: unknown) => this.define("GET", p, a, b)) as never;
  post: RouteMethod<this> = ((p: string, a: unknown, b?: unknown) => this.define("POST", p, a, b)) as never;
  put: RouteMethod<this> = ((p: string, a: unknown, b?: unknown) => this.define("PUT", p, a, b)) as never;
  patch: RouteMethod<this> = ((p: string, a: unknown, b?: unknown) => this.define("PATCH", p, a, b)) as never;
  delete: RouteMethod<this> = ((p: string, a: unknown, b?: unknown) => this.define("DELETE", p, a, b)) as never;

  mount(prefix: string, group: Routes): this {
    for (const r of group._records) this.add({ ...r, path: joinPath(prefix, r.path) });
    return this;
  }
}

export const routes = () => new Routes();

// ---------- the app ----------

export type AppOptions = OpenAPIInfo & {
  /** Where the docs page lives, or false. Default `/docs`. */
  docs?: string | false;
  /** Where the OpenAPI document lives, or false. Default `/openapi.json`. */
  openapi?: string | false;
  /** The request inspector. On by default in development, and it only answers loopback addresses. */
  inspector?: string | false;
  /** Checks what handlers return against `response`. Default: on in development. */
  validateResponses?: boolean;
  /** Largest accepted request body in bytes. Default 1 MiB. */
  bodyLimit?: number;
  /**
   * One line per request: "pretty" for people, "json" for log collectors, false for none.
   * Default: "pretty" in development, "json" in production.
   */
  log?: boolean | "pretty" | "json";
  /** Takes every request log entry instead of the console, e.g. to hand it to pino or winston. */
  logger?: (entry: RequestLog) => void;
  /** The header that carries the request id, in and out, or false. Default `x-request-id`. */
  requestId?: string | false;
  /** Close in-flight requests cleanly on SIGINT and SIGTERM. Default true. */
  gracefulShutdown?: boolean;
  /** Development mode. Default: NODE_ENV is not "production". */
  dev?: boolean;
  onError?: (error: unknown, ctx: Context<any, any, any, any, any>) => void;
};

export type InjectOptions = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  /** Objects are sent as JSON. */
  body?: unknown;
};

export type InjectResponse = {
  status: number;
  headers: Record<string, string>;
  text: string;
  /** Parsed JSON when the answer was JSON, otherwise the text. */
  body: any;
};

type RawRequest = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: Buffer;
  remote?: string;
  req?: IncomingMessage;
  res?: ServerResponse;
};

type RawResponse = { status: number; headers: Record<string, string>; body?: string | Buffer };

/** What gets logged for every request. */
export type RequestLog = {
  time: string;
  id?: string;
  method: string;
  path: string;
  route?: string;
  status: number;
  ms: number;
  notes: string[];
};

export type LogEntry = {
  requestId?: string;
  id: number;
  at: string;
  method: string;
  path: string;
  route?: string;
  status: number;
  ms: number;
  notes: string[];
  /** `clipped` is true when the body was too long to keep whole; such a request cannot be replayed. */
  request: { headers: Record<string, string>; body?: string; clipped?: boolean };
  response: { body?: string };
  /** The request written as an `examples: [...]` entry, when a route answered it. */
  example?: string;
};

const SAFE_ID = /^[\w.:@-]{1,128}$/; // anything else could smuggle into logs, so it gets a fresh id
const REDACT = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization", "x-api-key"]);
const CLIP = 4096;
const clip = (s: string, n = CLIP) => (s.length > n ? s.slice(0, n) + `… (${s.length - n} more)` : s);
const isLoopback = (addr?: string) =>
  !addr || addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";

export class App extends Routes {
  options: AppOptions;
  dev: boolean;
  private router = new Router<RouteRecord>();
  private global: Middleware[] = [];
  private log: LogEntry[] = [];
  private logId = 0;
  private spec?: Record<string, unknown>;
  private _onListen: (() => void | Promise<void>)[] = [];
  private _onClose: (() => void | Promise<void>)[] = [];

  constructor(options: AppOptions = {}) {
    super();
    this.dev = options.dev ?? process.env.NODE_ENV !== "production";
    this.options = {
      docs: "/docs",
      openapi: "/openapi.json",
      inspector: this.dev ? "/_inkan" : false,
      validateResponses: this.dev,
      bodyLimit: 1024 * 1024,
      log: this.dev ? "pretty" : "json",
      requestId: "x-request-id",
      gracefulShutdown: true,
      ...options,
    };
  }

  /** Middleware for every request, before routing. */
  override use(...mw: Middleware[]): this {
    this.global.push(...mw);
    return this;
  }

  onListen(fn: () => void | Promise<void>): this {
    this._onListen.push(fn);
    return this;
  }

  onClose(fn: () => void | Promise<void>): this {
    this._onClose.push(fn);
    return this;
  }

  /** @internal */
  override add(r: RouteRecord) {
    this.router.add(r.method, r.path, r);
    this._records.push(r);
    this.spec = undefined;
  }

  routes(): RouteRecord[] {
    return [...this._records];
  }

  openapi(): Record<string, unknown> {
    return (this.spec ??= buildOpenAPI(this._records, this.options));
  }

  /** Runs every route's examples against the app, without a socket. */
  check(opts?: CheckOptions): Promise<CheckReport> {
    return runChecks(this, opts);
  }

  /** Sends a request straight into the app. Good for tests: no port, no network. */
  async inject(opts: InjectOptions): Promise<InjectResponse> {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
    let body: Buffer | undefined;
    if (opts.body !== undefined) {
      if (Buffer.isBuffer(opts.body)) body = opts.body;
      else if (typeof opts.body === "string") body = Buffer.from(opts.body);
      else {
        body = Buffer.from(JSON.stringify(opts.body));
        headers["content-type"] ??= "application/json";
      }
    }
    const res = await this.handle({ method: (opts.method ?? "GET").toUpperCase(), url: opts.url, headers, body });
    const text = res.body === undefined ? "" : res.body.toString();
    const json = /json/.test(res.headers["content-type"] ?? "");
    return { status: res.status, headers: res.headers, text, body: json && text ? JSON.parse(text) : text };
  }

  // ----- the request path -----

  /** @internal */
  async handle(raw: RawRequest): Promise<RawResponse> {
    const started = performance.now();
    const url = new URL(raw.url, "http://inkan.local");
    const own = this.builtin(raw, url);
    if (own) return own;

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.headers)) {
      if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
    }
    const out = { status: 0, headers: {} as Record<string, string> };
    const notes: string[] = [];
    if (headers["x-inkan-replay"]) notes.push(`replay of #${headers["x-inkan-replay"].slice(0, 12)}`);
    const idHeader = this.options.requestId ? this.options.requestId.toLowerCase() : undefined;
    const incoming = idHeader ? headers[idHeader] : undefined;
    const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    if (idHeader) out.headers[idHeader] = id;
    let result: unknown;

    const ctx: Context<any, any, any, any, any> = {
      method: raw.method,
      path: url.pathname,
      url,
      id,
      params: {},
      query: queryObject(url.searchParams),
      headers,
      body: undefined,
      state: {},
      status: (code) => void (out.status = code),
      header: (name, value) => void (out.headers[name.toLowerCase()] = value),
      reply: (status, body, h) => new Reply(status, body, h),
      req: raw.req,
      res: raw.res,
    };

    let route: RouteRecord | undefined;
    const dispatch = async () => {
      const m = this.router.match(raw.method, url.pathname);
      if (m.kind === "none") throw problem(404, "not-found", `No route for ${raw.method} ${url.pathname}`);
      if (m.kind === "method") {
        const allow = [...m.allow, "OPTIONS"].join(", ");
        if (raw.method === "OPTIONS") {
          out.status = 204;
          out.headers.allow = allow;
          return;
        }
        const p = problem(405, "method-not-allowed", `${url.pathname} does not take ${raw.method}`);
        p.headers.allow = allow;
        throw p;
      }
      const r = m.route;
      route = r;
      ctx.route = { method: r.method, path: r.path };
      validateInput(ctx, r, m.params, raw);
      await compose(r.use, async () => {
        result = await r.handler(ctx);
      })(ctx);
    };

    let res: RawResponse;
    try {
      await compose(this.global, dispatch)(ctx);
      res = this.respond(result, out, route, notes);
    } catch (err) {
      res = this.fail(err, ctx, url.pathname, notes, out.headers, idHeader ? id : undefined);
    }
    if (raw.method === "HEAD") res.body = undefined;

    const ms = Math.round((performance.now() - started) * 10) / 10;
    this.logRequest({
      time: new Date().toISOString(),
      id: idHeader ? id : undefined,
      method: raw.method,
      path: url.pathname + url.search,
      route: route?.path,
      status: res.status,
      ms,
      notes,
    });
    if (this.options.inspector) this.remember(raw, url, res, route, ms, notes, headers, idHeader ? id : undefined);
    return res;
  }

  private logRequest(entry: RequestLog) {
    const { log, logger } = this.options;
    if (!log) return;
    if (logger) return logger(entry);
    if (log === "json") return console.log(JSON.stringify(entry));
    const c = paint(useColor());
    const flag = entry.notes.length ? c.seal(`  ! ${entry.notes.join("; ")}`) : "";
    console.log(`  ${c.method(entry.method, entry.method.padEnd(6))} ${entry.path}  ${c.status(entry.status)}  ${c.dim(entry.ms + "ms")}${flag}`);
  }

  private respond(
    result: unknown,
    out: { status: number; headers: Record<string, string> },
    route: RouteRecord | undefined,
    notes: string[],
  ): RawResponse {
    const responses = route?.spec.response ?? {};
    let status = out.status;
    let body = result;
    let headers = { ...out.headers };
    if (result instanceof Reply) {
      status = result.status;
      body = result.body;
      headers = { ...headers, ...lower(result.headers) };
    }
    if (!status) {
      // No body means 204. Otherwise the first 2xx the contract lists, or 200.
      const declared = Object.keys(responses).map(Number).filter((s) => s >= 200 && s < 300 && s !== 204).sort();
      status = body === undefined ? 204 : (declared[0] ?? 200);
    }

    if (route && Object.keys(responses).length && status !== 204) {
      const schema = contractFor(route, status);
      if (!schema) notes.push(`status ${status} is not in the contract`);
      else if (this.options.validateResponses) {
        const r = schema.safeParse(body);
        if (!r.ok) {
          notes.push("response broke the contract");
          const lines = r.issues.map((i) => `${i.path || "(body)"} ${i.message}`).join("\n  ");
          console.error(`inkan: ${route.method} ${route.path} answered ${status} with a body that breaks its contract:\n  ${lines}`);
          throw problem(500, "response-contract", "The handler answered with a body that does not match its contract", {
            errors: r.issues.map((i) => ({ in: "response", path: i.path, message: i.message })),
          });
        }
        body = r.value; // this also drops keys the contract does not list, so nothing leaks by accident
      }
    }
    return encode(status, body, headers);
  }

  private fail(
    err: unknown,
    ctx: Context<any, any, any, any, any>,
    path: string,
    notes: string[],
    set: Record<string, string>,
    requestId?: string,
  ): RawResponse {
    let p: HttpProblem;
    if (err instanceof HttpProblem) p = err;
    else {
      if (this.options.onError) this.options.onError(err, ctx);
      else console.error(err);
      const detail = this.dev && err instanceof Error ? err.message : "Something went wrong on our side";
      p = problem(500, "internal", detail);
    }
    if (p.type === "validation") notes.push("input broke the contract");
    const body: ProblemBody = { ...p.toJSON(), instance: path };
    if (requestId) body.requestId = requestId; // so a user's bug report points at the right log line
    return {
      status: p.status,
      headers: { ...set, "content-type": "application/problem+json", ...lower(p.headers) },
      body: JSON.stringify(body),
    };
  }

  private builtin(raw: RawRequest, url: URL): RawResponse | undefined {
    if (raw.method !== "GET" && raw.method !== "HEAD") return;
    const { docs, openapi, inspector } = this.options;
    const p = url.pathname;
    if (openapi && p === openapi) return encode(200, this.openapi(), {});
    if (docs && (p === docs || p === docs + "/")) {
      const page = docsPage({ title: this.options.title ?? "API", specUrl: openapi || "", inspector: inspector || "" });
      return encode(200, page, {
        "content-type": "text/html; charset=utf-8",
      });
    }
    if (inspector && (p === inspector || p.startsWith(inspector + "/"))) {
      if (!isLoopback(raw.remote)) return; // a plain 404 for everybody else
      if (p === inspector + "/log.json") {
        const since = Number(url.searchParams.get("since") ?? 0);
        return encode(200, this.log.filter((e) => e.id > since), { "cache-control": "no-store" });
      }
      return encode(200, inspectorPage({ title: this.options.title ?? "API", base: inspector, docs: docs || "" }), {
        "content-type": "text/html; charset=utf-8",
      });
    }
  }

  private remember(
    raw: RawRequest,
    url: URL,
    res: RawResponse,
    route: RouteRecord | undefined,
    ms: number,
    notes: string[],
    headers: Record<string, string>,
    requestId?: string,
  ) {
    const shown: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) shown[k] = REDACT.has(k) ? "•••" : v;
    const body = raw.body?.length ? raw.body.toString() : undefined;
    const entry: LogEntry = {
      id: ++this.logId,
      requestId,
      at: new Date().toISOString(),
      method: raw.method,
      path: url.pathname + url.search,
      route: route?.path,
      status: res.status,
      ms,
      notes,
      request: { headers: shown, body: body === undefined ? undefined : clip(body), clipped: body !== undefined && body.length > CLIP },
      response: { body: res.body === undefined ? undefined : clip(res.body.toString()) },
    };
    entry.example = exampleFrom(entry);
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
  }

  // ----- the socket -----

  /** A plain Node request listener, for `http.createServer` or anything that takes one. */
  get listener() {
    return (req: IncomingMessage, res: ServerResponse) => void this.serve(req, res);
  }

  private async serve(req: IncomingMessage, res: ServerResponse) {
    const limit = this.options.bodyLimit!;
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = Number(req.headers["content-length"] ?? 0) > limit;
    if (!tooLarge && req.method !== "GET" && req.method !== "HEAD") {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) {
          tooLarge = true;
          break;
        }
        chunks.push(chunk);
      }
    }
    let out: RawResponse;
    if (tooLarge) {
      const p = problem(413, "body-too-large", `Request bodies may be at most ${limit} bytes`);
      out = {
        status: 413,
        headers: { "content-type": "application/problem+json", connection: "close" },
        body: JSON.stringify({ ...p.toJSON(), instance: req.url }),
      };
    } else {
      out = await this.handle({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
        remote: req.socket.remoteAddress,
        req,
        res,
      });
    }
    if (res.headersSent || res.writableEnded) return; // a handler wrote to `res` itself
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  }

  /**
   * Starts listening. The port comes from the argument, then $PORT, then 3000,
   * so it runs under warden, a PaaS or a container without changes.
   */
  listen(port?: number, host?: string): Promise<Server> {
    const server = createServer(this.listener);
    if (process.env.INKAN_NO_LISTEN) return Promise.resolve(server); // the CLI loads the app only to read it
    const p = port ?? (process.env.PORT ? Number(process.env.PORT) : 3000);
    const h = host ?? process.env.HOST;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(p, h, () => {
        server.off("error", reject);
        (async () => {
          for (const hook of this._onListen) await hook();
          const { log, logger } = this.options;
          if (log && !logger) {
            if (log === "json") {
              const addr = server.address();
              const port = typeof addr === "object" && addr ? addr.port : addr;
              console.log(JSON.stringify({ time: new Date().toISOString(), msg: "listening", port }));
            } else this.banner(server);
          }
          if (this.options.gracefulShutdown) shutdownOnSignal(server, this._onClose);
          resolve(server);
        })().catch((err) => server.close(() => reject(err)));
      });
    });
  }

  private banner(server: Server) {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : addr;
    const base = `http://localhost:${port}`;
    const n = this._records.length;
    const ex = this._records.reduce((s, r) => s + (r.spec.examples?.length ?? 0), 0);
    const name = [this.options.title, this.options.version].filter(Boolean).join(" ");
    const c = paint(useColor());
    const lines = [`  ${c.seal("印")} ${c.bold("inkan")}${name ? c.dim("  ·  ") + name : ""}`, `  ${c.dim("├")} ${c.link(base)}`];
    if (this.options.docs) lines.push(`  ${c.dim("├")} docs       ${c.link(base + this.options.docs)}`);
    if (this.options.inspector) lines.push(`  ${c.dim("├")} inspector  ${c.link(base + this.options.inspector)}`);
    lines.push(`  ${c.dim("└")} ${n} route${n === 1 ? "" : "s"}, ${ex} example${ex === 1 ? "" : "s"}`);
    console.log("\n" + lines.join("\n") + "\n");
  }
}

export const inkan = (options?: AppOptions) => new App(options);

/**
 * The schema a status answers with. A route that takes input also promises
 * a 400 problem for input that breaks the contract, without saying so.
 */
export function contractFor(route: RouteRecord, status: number): Schema<any> | undefined {
  const { spec } = route;
  const declared = spec.response?.[status];
  if (declared) return declared;
  if (status === 400 && (spec.params || spec.query || spec.headers || spec.body)) return t.problem();
}

// ---------- helpers ----------

function compose(mw: Middleware[], last: () => Promise<void>) {
  return async (ctx: Context<any, any, any, any, any>) => {
    let index = -1;
    const run = async (i: number): Promise<void> => {
      if (i <= index) throw new Error("next() was called twice in one middleware");
      index = i;
      if (i === mw.length) return last();
      await mw[i](ctx, () => run(i + 1));
    };
    await run(0);
  };
}

function queryObject(sp: URLSearchParams): RawQuery {
  const o: RawQuery = {};
  for (const [k, v] of sp) {
    const prev = o[k];
    o[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return o;
}

const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

type Body = { kind: "none" | "json" | "form" | "text" | "binary"; value: unknown };

function readBody(raw: RawRequest, contentType: string): Body {
  if (!raw.body?.length) return { kind: "none", value: undefined };
  const ct = contentType.split(";")[0].trim().toLowerCase();
  const text = () => raw.body!.toString("utf8");
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

function validateInput(ctx: Context<any, any, any, any, any>, route: RouteRecord, params: Record<string, string>, raw: RawRequest) {
  const { spec } = route;
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

  const body = readBody(raw, contentType);
  if (spec.body && (body.kind === "binary" || body.kind === "text")) {
    throw problem(415, "unsupported-media-type", "Send the body as application/json or application/x-www-form-urlencoded");
  }
  ctx.body = take("body", spec.body, body.value, body.kind === "form");

  if (errors.length) {
    const where = [...new Set(errors.map((e) => e.in))].join(" and ");
    throw new HttpProblem(400, "validation", `The ${where} does not match the contract`, { errors });
  }
}

function encode(status: number, body: unknown, headers: Record<string, string>): RawResponse {
  const h = { ...headers };
  if (body === undefined || body === null || status === 204 || status === 304) {
    return { status, headers: h, body: undefined };
  }
  if (typeof body === "string") {
    h["content-type"] ??= "text/plain; charset=utf-8";
    return { status, headers: h, body };
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    h["content-type"] ??= "application/octet-stream";
    return { status, headers: h, body: Buffer.from(body) };
  }
  h["content-type"] ??= "application/json; charset=utf-8";
  return { status, headers: h, body: JSON.stringify(body) };
}

let shuttingDown = false;
function shutdownOnSignal(server: Server, onClose: (() => void | Promise<void>)[]) {
  const stop = (signal: string) => {
    if (shuttingDown) process.exit(1); // a second ctrl+c means now
    shuttingDown = true;
    console.log(`\n  ${paint(useColor()).warn(signal)}: finishing open requests…`);
    server.close(async () => {
      for (const hook of onClose) await hook();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, 10_000).unref();
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}

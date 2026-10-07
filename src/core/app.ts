import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HttpProblem, problem, type ProblemBody } from "./problem.ts";
import { type Match, Router } from "./router.ts";
import { EventsSchema, t, type Infer, type Issue, type Schema, type UploadedFile } from "../schema/schema.ts";
import { encodeEvents, EventStream, hasFiles, isStream, parseEvents, toFormData, type SseEvent } from "./stream.ts";
import { buildOpenAPI, type OpenAPIInfo } from "../openapi/openapi.ts";
import { docsPage } from "../pages/docs.ts";
import { inspectorPage } from "../pages/inspector.ts";
import { exampleFrom } from "../testing/record.ts";
import { runChecks, type CheckOptions, type CheckReport } from "../testing/check.ts";
import { paint, useColor } from "./color.ts";
import type { Seal } from "../seal/compile.ts";
import { applySeal, type SealState } from "../seal/seal.ts";
import { Reply, type Context, type Example, type Middleware, type RawQuery, type RouteRecord, type Responses, type RouteDefs } from "./route.ts";
import { target, queryObject, type Exchange, type RawRequest, type RawResponse, type Target } from "./context.ts";
import { NO_HOOKS, runHooks, Scope, type Hooks, type Root } from "./scope.ts";
import { readRequestBody, TOO_LARGE, validateInput } from "./input.ts";
import { Buffer } from "node:buffer"; // explicit, for runtimes without a global Buffer

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
  /**
   * The contracts stamped into code by `inkan seal`: `import seal from "./inkan.seal.js"`.
   * Each one is used only while it matches its contract; the rest run as without a seal.
   */
  seal?: Seal;
};

export type InjectOptions = {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  /** Objects are sent as JSON, a FormData (or an object holding a `fileExample`) as multipart. */
  body?: unknown;
  /** For a server-sent event stream: stop reading after this many events. Endless streams need it. */
  events?: number;
};

export type InjectResponse = {
  status: number;
  headers: Record<string, string>;
  text: string;
  /** Parsed JSON when the answer was JSON, the events of an event stream, otherwise the text. */
  body: any;
};

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

export class App<Defs extends RouteDefs = any, Deco = any> extends Scope<Defs, Deco> implements Root {
  options: AppOptions;
  dev: boolean;
  private router = new Router<RouteRecord>();
  private global: Middleware[] = [];
  private log: LogEntry[] = [];
  private logId = 0;
  private spec?: Record<string, unknown>;
  private _onListen: (() => void | Promise<void>)[] = [];
  private _onClose: (() => void | Promise<void>)[] = [];
  /** Plugins still loading, in order; undefined when everything registered so far has run. */
  private loading?: Promise<void>;
  /** Whether every route has its hooks joined; adding a route or a hook undoes it. */
  private built = false;
  /** The app's own hooks, for requests no route matched. */
  private rootHooks: Hooks = NO_HOOKS;

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

  /** @internal Every route, from the app and from every scope inside it, ends up here. */
  _addRoute(r: RouteRecord) {
    r.box ??= this._box;
    this.router.add(r.method, r.path, r);
    this._records.push(r);
    this.spec = undefined;
    this.built = false;
    this.sealState = undefined; // a new route: its contracts get sealed on the next request
  }

  private sealState?: SealState;
  /** How the seal went: how many contracts run on it, and which changed since it was made. */
  sealed(): SealState | undefined {
    if (!this.options.seal) return undefined;
    if (!this.sealState) {
      this.sealState = applySeal(this.options.seal, this._records);
      const { stale, wrongFormat } = this.sealState;
      if (wrongFormat) console.warn("inkan: the seal was made by another version of inkan, so it is not used. Run inkan seal again.");
      else if (stale.length) {
        console.warn(`inkan: ${stale.length} contract${stale.length === 1 ? "" : "s"} changed since the seal was made and run${stale.length === 1 ? "s" : ""} unsealed (${stale.slice(0, 3).join(", ")}${stale.length > 3 ? ", …" : ""}). Run inkan seal again.`);
      }
    }
    return this.sealState;
  }

  /** @internal A hook was added somewhere: the routes' joined hooks are out of date. */
  _changed() {
    this.built = false;
  }

  /** @internal Runs a plugin now, or after the ones still loading, so they run in the order they were registered. */
  _load(run: () => void | Promise<void>) {
    if (!this.loading) {
      const r = run(); // a plugin that throws at once throws out of register()
      if (r instanceof Promise) this.loading = r.then(() => undefined);
      return;
    }
    this.loading = this.loading.then(() => run());
  }

  /** Resolves once every plugin registered so far has loaded; rejects with the error of one that failed. */
  async ready(): Promise<void> {
    while (this.loading) {
      const now = this.loading;
      await now;
      if (this.loading === now) this.loading = undefined; // a plugin may have registered more while it ran
    }
  }

  /** Joins every route's hooks, from the app down to its scope, once instead of per request. */
  private build() {
    for (const r of this._records) r.hooks = r.box!.flatten();
    this.rootHooks = this._box.flatten();
    this.timeAll = this._records.some((r) => r.hooks!.onResponse.length) || this.rootHooks.onResponse.length > 0;
    this.built = true;
  }
  /** Whether any route has an onResponse hook, which needs the time a request took. */
  private timeAll = false;

  routes(): RouteRecord[] {
    return [...this._records];
  }

  openapi(): Record<string, unknown> {
    return (this.spec ??= buildOpenAPI(this._records, this.options));
  }

  /** Runs every route's examples against the app, without a socket. */
  async check(opts?: CheckOptions): Promise<CheckReport> {
    await this.ready();
    return runChecks(this, opts);
  }

  /** Sends a request straight into the app. Good for tests: no port, no network. */
  async inject(opts: InjectOptions): Promise<InjectResponse> {
    if (this.loading) await this.ready();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
    let body: Buffer | undefined;
    const given = hasFiles(opts.body) ? toFormData(opts.body as Record<string, unknown>) : opts.body;
    if (given !== undefined) {
      if (Buffer.isBuffer(given)) body = given;
      else if (typeof given === "string") body = Buffer.from(given);
      else if (given instanceof FormData) {
        const encoded = new Response(given); // the platform writes the multipart body and its boundary
        body = Buffer.from(await encoded.arrayBuffer());
        headers["content-type"] ??= encoded.headers.get("content-type")!;
      } else {
        body = Buffer.from(JSON.stringify(given));
        headers["content-type"] ??= "application/json";
      }
    }
    const res = await this.handle({ method: (opts.method ?? "GET").toUpperCase(), url: opts.url, headers, body });
    const type = res.headers["content-type"] ?? "";
    let text = res.body === undefined ? "" : res.body.toString();
    if (res.stream) {
      const sse = type.startsWith("text/event-stream");
      for await (const chunk of res.stream) {
        text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
        if (sse && opts.events !== undefined && parseEvents(text).length >= opts.events) break; // stops the source too
      }
      res.abort?.abort();
      res.done?.();
      if (type.startsWith("text/event-stream")) return { status: res.status, headers: res.headers, text, body: parseEvents(text) };
    } else res.done?.();
    const json = /json/.test(type);
    return { status: res.status, headers: res.headers, text, body: json && text ? JSON.parse(text) : text };
  }

  // ----- the request path -----

  /**
   * @internal
   * Synchronous as long as nothing on the way is asynchronous: a promise only for a body
   * that has to be read, middleware, or a handler that returns one. Everything else answers
   * in the same turn, without a promise, a closure per step or an extra trip through the
   * microtask queue.
   */
  handle(raw: RawRequest): RawResponse | Promise<RawResponse> {
    if (!this.built) this.build();
    if (this.options.seal && !this.sealState) this.sealed();
    const timed = Boolean(this.options.log || this.options.inspector);
    const started = timed || this.timeAll ? performance.now() : 0;
    const url = target(raw.url);
    const own = this.builtin(raw, url);
    if (own) return own;

    // Node already lower-cases header names; inject does the same. Nothing to copy.
    const headers = raw.headers as Record<string, string>;
    const out = { status: 0, headers: {} as Record<string, string> };
    const notes: string[] = [];
    if (headers["x-inkan-replay"]) notes.push(`replay of #${headers["x-inkan-replay"].slice(0, 12)}`);
    const idHeader = this.options.requestId ? this.options.requestId.toLowerCase() : undefined;
    const incoming = idHeader ? headers[idHeader] : undefined;
    const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    if (idHeader) out.headers[idHeader] = id;

    // the route decides the context: its scope's decorations live on that context's class
    const m = this.router.match(raw.method, url.pathname);
    const route = m.kind === "found" ? m.route : undefined;
    const ctx = new (route ? route.box! : this._box).Ctx(raw, url, id, headers, out) as Context<any, any, any, any, any>;
    const hooks = route ? route.hooks! : this.rootHooks;
    const x: Exchange = { raw, url, ctx, out, notes, headers, started, timed, id: idHeader ? id : undefined, route: undefined, hooks };

    if (this.global.length || hooks !== NO_HOOKS) return this.full(x, m);
    let res: RawResponse;
    try {
      if (!route) {
        const p = this.unmatched(m, raw.method, url.pathname, out);
        res = p ? this.fail(p, x) : this.respond(undefined, x);
      } else {
        const r = (x.route = route);
        ctx.route = { method: r.method, path: r.path };
        const reading = validateInput(ctx, r, (m as { params: Record<string, string> }).params, raw); // a promise only when a body has to be parsed
        if (reading || r.use.length) return this.later(x, r, reading);
        const result = r.handler(ctx);
        if (result instanceof Promise) return this.settle(x, result);
        res = this.respond(result, x);
      }
    } catch (err) {
      res = this.fail(err, x);
    }
    return this.finish(x, res);
  }

  /** No route for the path, or not for this method. A problem to answer with, or nothing for an OPTIONS. */
  private unmatched(m: Match<RouteRecord>, method: string, path: string, out: Exchange["out"]): HttpProblem | undefined {
    if (m.kind === "none") return problem(404, "not-found", `No route for ${method} ${path}`);
    if (m.kind !== "method") return;
    const allow = [...m.allow, "OPTIONS"].join(", ");
    if (method === "OPTIONS") {
      out.status = 204;
      out.headers.allow = allow;
      return;
    }
    const p = problem(405, "method-not-allowed", `${path} does not take ${method}`);
    p.headers.allow = allow;
    return p;
  }

  /** The rest of a request once something on its way returned a promise. */
  private async later(x: Exchange, r: RouteRecord, reading: void | Promise<void>): Promise<RawResponse> {
    let res: RawResponse;
    try {
      if (reading) await reading;
      let result: unknown;
      if (r.use.length) {
        await compose(r.use, async () => {
          result = await r.handler(x.ctx);
        })(x.ctx);
      } else {
        const y = r.handler(x.ctx);
        result = y instanceof Promise ? await y : y;
      }
      res = this.respond(result, x);
    } catch (err) {
      res = this.fail(err, x);
    }
    return this.finish(x, res);
  }

  private async settle(x: Exchange, pending: Promise<unknown>): Promise<RawResponse> {
    let res: RawResponse;
    try {
      res = this.respond(await pending, x);
    } catch (err) {
      res = this.fail(err, x);
    }
    return this.finish(x, res);
  }

  /**
   * The whole way, for a request with hooks or app-wide middleware on it: onRequest,
   * middleware, the input, preHandler, the handler, onSend; onProblem for every problem.
   */
  private async full(x: Exchange, m: Match<RouteRecord>): Promise<RawResponse> {
    const { raw, url, ctx, out, hooks } = x;
    const r = m.kind === "found" ? m.route : undefined;
    if (r) {
      x.route = r;
      ctx.route = { method: r.method, path: r.path };
    }
    let res: RawResponse;
    try {
      let result = hooks.onRequest.length ? await runHooks(hooks.onRequest, ctx) : undefined;
      if (result === undefined) {
        const dispatch = async () => {
          if (!r) {
            const p = this.unmatched(m, raw.method, url.pathname, out);
            if (p) throw p;
            return;
          }
          const reading = validateInput(ctx, r, (m as { params: Record<string, string> }).params, raw);
          if (reading) await reading;
          if (hooks.preHandler.length) {
            const early = await runHooks(hooks.preHandler, ctx);
            if (early !== undefined) return void (result = early);
          }
          if (r.use.length) {
            await compose(r.use, async () => {
              result = await r.handler(ctx);
            })(ctx);
          } else {
            const y = r.handler(ctx);
            result = y instanceof Promise ? await y : y;
          }
        };
        if (this.global.length) await compose(this.global, dispatch)(ctx);
        else await dispatch();
      }
      res = this.respond(result, x);
    } catch (err) {
      res = hooks.onProblem.length ? await this.failWithHooks(err, x) : this.fail(err, x);
    }
    if (hooks.onSend.length) res = await this.sending(x, res);
    return this.finish(x, res);
  }

  /** onSend: every hook sees the answer and may change it, or hand back another. */
  private async sending(x: Exchange, res: RawResponse): Promise<RawResponse> {
    try {
      for (const h of x.hooks.onSend) {
        let v = h(x.ctx, res);
        if (v instanceof Promise) v = await v;
        if (v && typeof v === "object" && v !== res) res = { ...res, ...v };
      }
      return res;
    } catch (err) {
      return this.fail(err, x); // a hook that breaks is a problem like any other, and goes out as it is
    }
  }

  /** onProblem: every hook sees the problem and may change it, or return another, before it becomes the answer. */
  private async failWithHooks(err: unknown, x: Exchange): Promise<RawResponse> {
    let p = this.problemOf(err, x);
    for (const h of x.hooks.onProblem) {
      let v = h(x.ctx, p);
      if (v instanceof Promise) v = await v;
      if (v instanceof HttpProblem) p = v;
    }
    return this.answer(p, x);
  }

  /** onResponse, once the answer is written. Nothing can change the answer now, so a hook that breaks is only logged. */
  private responded(x: Exchange, res: RawResponse) {
    const done: RequestLog = {
      time: new Date().toISOString(),
      id: x.id,
      method: x.raw.method,
      path: x.url.pathname + x.url.search,
      route: x.route?.path,
      status: res.status,
      ms: Math.round((performance.now() - x.started) * 10) / 10,
      notes: x.notes,
    };
    const report = (err: unknown) => (this.options.onError ? this.options.onError(err, x.ctx) : console.error(err));
    for (const h of x.hooks.onResponse) {
      try {
        const v = h(x.ctx, done);
        if (v instanceof Promise) v.catch(report);
      } catch (err) {
        report(err);
      }
    }
  }

  /** HEAD, the log line and the inspector: what every answer goes through last. */
  private finish(x: Exchange, res: RawResponse): RawResponse {
    const { raw, url, route, notes } = x;
    if (x.hooks.onResponse.length) res.done = () => this.responded(x, res);
    if (raw.method === "HEAD") {
      // a HEAD answers with the length the GET would have, and without the body
      if (res.body !== undefined) res.headers["content-length"] = String(Buffer.byteLength(res.body));
      res.body = undefined;
      res.abort?.abort();
      res.stream = undefined;
    }

    if (!x.timed) return res;
    const ms = Math.round((performance.now() - x.started) * 10) / 10;
    if (this.options.log) {
      this.logRequest({
        time: new Date().toISOString(),
        id: x.id,
        method: raw.method,
        path: url.pathname + url.search,
        route: route?.path,
        status: res.status,
        ms,
        notes,
      });
    }
    if (this.options.inspector) this.remember(raw, url, res, route, ms, notes, x.headers, x.id);
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

  private respond(result: unknown, x: Exchange): RawResponse {
    const { out, route, notes } = x;
    const plan = route ? planOf(route) : undefined;
    let status = out.status;
    let body = result;
    const headers = out.headers; // this request's own object: filled in place, never copied
    if (result instanceof Reply) {
      status = result.status;
      body = result.body;
      for (const [k, v] of Object.entries(result.headers)) headers[k.toLowerCase()] = v;
    }
    // No body means 204. Otherwise the first 2xx the contract lists, or 200.
    if (!status) status = body === undefined ? 204 : (plan?.defaultStatus ?? 200);

    if (body instanceof EventStream) {
      const schema = route ? contractFor(route, status) : undefined;
      const abort = new AbortController();
      const check =
        schema instanceof EventsSchema && this.options.validateResponses
          ? (e: SseEvent) => {
              const r = schema.safeParse({ event: e.event ?? "message", data: e.data, id: e.id });
              if (r.ok) return;
              const lines = r.issues.map((i) => `${i.path || "(event)"} ${i.message}`).join("; ");
              console.error(`inkan: ${route!.method} ${route!.path} sent an event that breaks its contract: ${lines}`);
              return `An event broke the contract: ${lines}`;
            }
          : undefined;
      const sseHeaders = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no", ...headers };
      return { status, headers: sseHeaders, stream: encodeEvents(body, abort.signal, check), abort };
    }
    if (isStream(body)) {
      // a stream cannot be checked against a schema before it is sent; it goes out as it comes
      return { status, headers: { "content-type": "application/octet-stream", ...headers }, stream: body };
    }

    let schema: Schema<any> | undefined;
    if (route && plan?.hasContract && status !== 204) {
      schema = contractFor(route, status);
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
        body = r.value;
      }
    }
    // Only what the contract lists leaves the server, in development and in production alike.
    // The writer is built once per schema and knows the shape, so this is also the fast path.
    if (schema && typeof body === "object" && body !== null && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
      headers["content-type"] ??= "application/json; charset=utf-8";
      return encode(status, schema._serializer()(body), headers);
    }
    return encode(status, body, headers);
  }

  private fail(err: unknown, x: Exchange): RawResponse {
    return this.answer(this.problemOf(err, x), x);
  }

  /** A problem as it is, or a 500 for anything else thrown, which gets logged: it is a bug, not an answer. */
  private problemOf(err: unknown, x: Exchange): HttpProblem {
    if (err instanceof HttpProblem) return err;
    if (this.options.onError) this.options.onError(err, x.ctx);
    else console.error(err);
    const detail = this.dev && err instanceof Error ? err.message : "Something went wrong on our side";
    return problem(500, "internal", detail);
  }

  /** A problem written as an RFC 9457 document. */
  private answer(p: HttpProblem, x: Exchange): RawResponse {
    if (p.type === "validation") x.notes.push("input broke the contract");
    const body = p.toJSON();
    body.instance = x.url.pathname;
    if (x.id) body.requestId = x.id; // so a user's bug report points at the right log line
    return {
      status: p.status,
      headers: withProblemHeaders(x.out.headers, p.headers),
      body: JSON.stringify(body),
    };
  }

  private builtin(raw: RawRequest, url: Target): RawResponse | undefined {
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
      if (!isLoopback(raw.remote ?? raw.req?.socket.remoteAddress)) return; // a plain 404 for everybody else
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
    url: Target,
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
      response: { body: res.stream ? "(a stream)" : res.body === undefined ? undefined : clip(res.body.toString()) },
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

  // Synchronous for a request without a body whose handler is: no promise, no extra turn.
  private serve(req: IncomingMessage, res: ServerResponse) {
    const limit = this.options.bodyLimit!;
    const hasBody = req.headers["content-length"] !== undefined || req.headers["transfer-encoding"] !== undefined;
    if (Number(req.headers["content-length"] ?? 0) > limit) return this.tooLarge(req, res, limit);
    if (hasBody && req.method !== "GET" && req.method !== "HEAD") {
      readRequestBody(req, limit).then(
        (read) => (read === TOO_LARGE ? this.tooLarge(req, res, limit) : this.pass(req, res, read)),
        (err) => this.broken(req, res, err),
      );
      return;
    }
    this.pass(req, res, undefined);
  }

  private pass(req: IncomingMessage, res: ServerResponse, body: Buffer | undefined) {
    let out: RawResponse | Promise<RawResponse>;
    try {
      out = this.handle({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body, req, res });
    } catch (err) {
      return this.broken(req, res, err);
    }
    if (out instanceof Promise) {
      out.then(
        (o) => this.send(res, o),
        (err) => this.broken(req, res, err),
      );
    } else this.send(res, out);
  }

  private tooLarge(req: IncomingMessage, res: ServerResponse, limit: number) {
    this.send(res, tooLargeAnswer(req.url ?? "/", limit));
  }

  // ----- web standard -----

  /**
   * The app as a web-standard handler, Request in and Response out, for Bun, Deno and
   * serverless platforms. `remote` is the client's address where the platform knows it;
   * the inspector answers only a loopback address, so without one it stays shut.
   *
   *   Bun.serve({ fetch: (req, server) => app.fetch(req, { remote: server.requestIP(req)?.address }) })
   *   Deno.serve((req, info) => app.fetch(req, { remote: info.remoteAddr.hostname }))
   */
  async fetch(request: Request, info: { remote?: string } = {}): Promise<Response> {
    if (this.loading) await this.ready();
    const url = new URL(request.url);
    const target = url.pathname + url.search;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => (headers[name] = value)); // names come lower-cased
    const limit = this.options.bodyLimit!;
    let body: Buffer | undefined;
    if (request.body && request.method !== "GET" && request.method !== "HEAD") {
      const read = Number(headers["content-length"] ?? 0) > limit ? TOO_LARGE : await readWebBody(request.body, limit);
      if (read === TOO_LARGE) return toWebResponse(tooLargeAnswer(target, limit));
      body = read;
    }
    const out = await this.handle({ method: request.method, url: target, headers, body, remote: info.remote ?? "unknown" });
    return toWebResponse(out);
  }

  /** Something failed outside every handler (the socket, inkan itself): log it and answer 500. */
  private broken(req: IncomingMessage, res: ServerResponse, err: unknown) {
    if (this.options.onError) this.options.onError(err, { req, res } as never);
    else console.error(err);
    if (res.headersSent) return void res.destroy();
    const body = JSON.stringify({ type: "internal", title: "Internal Server Error", status: 500, instance: req.url });
    this.send(res, { status: 500, headers: { "content-type": "application/problem+json" }, body });
  }

  private send(res: ServerResponse, out: RawResponse) {
    if (res.headersSent || res.writableEnded) return; // a handler wrote to `res` itself
    if (!out.stream) {
      // writeHead fixes the headers at once; without a length Node falls back to chunked
      // encoding for a body it already has whole, which costs framing on every answer
      if (out.status !== 204 && out.status !== 304 && out.status >= 200) {
        out.headers["content-length"] ??= String(out.body === undefined ? 0 : Buffer.byteLength(out.body));
      }
      res.writeHead(out.status, out.headers);
      res.end(out.body);
      return void out.done?.();
    }
    res.writeHead(out.status, out.headers);
    void this.pipe(res, out);
  }

  private async pipe(res: ServerResponse, out: RawResponse) {
    const source = out.stream as AsyncIterable<Uint8Array | string> & { destroy?: () => void };
    const stop = () => {
      out.abort?.abort();
      source.destroy?.();
    };
    res.once("close", stop); // the client went away: tell the source, so it stops producing
    try {
      for await (const chunk of source) {
        if (res.destroyed) break;
        if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
      }
    } catch (err) {
      if (this.options.onError) this.options.onError(err, { req: res.req, res } as never);
      else console.error(err);
    } finally {
      res.off("close", stop);
      res.end();
      out.done?.();
    }
  }

  /**
   * Starts listening. The port comes from the argument, then $PORT, then 3000,
   * so it runs under warden, a PaaS or a container without changes.
   */
  listen(port?: number, host?: string): Promise<Server> {
    // every plugin first: a route a plugin adds must be there for the first request, and one that fails stops the start
    return this.ready().then(() => this.open(port, host));
  }

  private open(port?: number, host?: string): Promise<Server> {
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

export const inkan = (options?: AppOptions): App<{}, {}> => new App(options);

type Plan = { hasContract: boolean; defaultStatus: number };
const plans = new WeakMap<RouteRecord, Plan>();
/** What a route's contract says about every answer, worked out on its first request instead of on each. */
function planOf(route: RouteRecord): Plan {
  let plan = plans.get(route);
  if (!plan) {
    const statuses = Object.keys(route.spec.response ?? {}).map(Number);
    const ok = statuses.filter((s) => s >= 200 && s < 300 && s !== 204).sort((a, b) => a - b);
    plan = { hasContract: statuses.length > 0, defaultStatus: ok[0] ?? 200 };
    plans.set(route, plan);
  }
  return plan;
}

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

/** The answer's own headers (CORS, request id) plus the problem's; filled in place, nothing copied. */
function withProblemHeaders(set: Record<string, string>, extra: Record<string, string>) {
  set["content-type"] = "application/problem+json";
  for (const key in extra) set[key.toLowerCase()] = extra[key];
  return set;
}

const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

/** Turns a body into bytes and a content type. Fills `headers` in place: every caller owns it. */
function encode(status: number, body: unknown, headers: Record<string, string>): RawResponse {
  const h = headers;
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

function tooLargeAnswer(instance: string, limit: number): RawResponse {
  const p = problem(413, "body-too-large", `Request bodies may be at most ${limit} bytes`);
  return {
    status: 413,
    headers: { "content-type": "application/problem+json", connection: "close" },
    body: JSON.stringify({ ...p.toJSON(), instance }),
  };
}

/** Reads a web body up to the limit, and stops reading the moment it is passed. */
async function readWebBody(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer | undefined | typeof TOO_LARGE> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel();
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  return size ? Buffer.concat(chunks, size) : undefined;
}

const textEncoder = new TextEncoder();

/** An answer as a web Response. A stream stays a stream, and a client that goes away stops its source. */
function toWebResponse(out: RawResponse): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(out.headers)) if (k !== "connection") headers.set(k, v); // hop-by-hop: the platform's business
  if (!out.stream) {
    const empty = out.status === 204 || out.status === 304 || out.body === undefined;
    const res = new Response(empty ? null : out.body, { status: out.status, headers });
    out.done?.();
    return res;
  }
  const source = out.stream[Symbol.asyncIterator]();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    out.done?.();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await source.next();
        if (done) {
          controller.close();
          finish();
        } else controller.enqueue(typeof value === "string" ? textEncoder.encode(value) : value);
      } catch (err) {
        controller.error(err);
        finish();
      }
    },
    async cancel() {
      out.abort?.abort(); // the client went away: tell the source, so it stops producing
      await source.return?.();
      finish();
    },
  });
  return new Response(body, { status: out.status, headers });
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

// Scopes: where hooks, decorations and plugins live.
//
// The app is the outermost scope. Every `register` opens a scope inside the one it is
// called on: hooks and decorations added there reach the routes defined there and in the
// scopes inside it, and nothing outside, unless the plugin is made with `shared: true`.
//
// Nothing here is looked up per request. Before the first request every route gets the
// hooks of its scope chain joined into one list per hook (see App.build), and a route with
// none anywhere above it keeps the plain, fast request path.

import type { RequestLog } from "./app.ts";
import { RequestContext, type Layout } from "./context.ts";
import { folderOf, loadRoutes } from "./files.ts";
import type { HttpProblem } from "./problem.ts";
import { defineJob, type JobHub, type JobMethod } from "./jobs.ts";
import type { JsonSchema, Schema } from "../schema/schema.ts";
import { joinPath, Routes, type Context, type DecoOf, type OperationRoute, type RouteDefs, type RouteRecord, type WithDeco } from "./route.ts";

type Ctx<Deco> = Context<any, any, any, any, any> & Deco;
/** `decorate` as a property, so its type can name the app or scope it returns. */
export type DecorateMethod<Self> = <K extends string, V>(name: K, value: V) => WithDeco<Self, { [P in K]: V }>;
/** `decorateRequest` as a property, for the same reason. */
export type DecorateRequestMethod<Self> = <K extends string, V>(name: K, init: (ctx: Ctx<DecoOf<Self>>) => V) => WithDeco<Self, { [P in K]: V }>;
/** `register` as a property: the scope it returns knows what a shared plugin decorated. */
export type RegisterMethod<Self> = <O extends object = {}, A = {}>(
  p: Plugin<O, DecoOf<Self>, A> | ((app: Scope<{}, DecoOf<Self>>, options: O) => unknown),
  options?: O & { prefix?: string },
) => WithDeco<Self, A>;

/** An answer on its way out, as onSend sees it. A hook may change it, or return another. */
export type Outgoing = {
  status: number;
  headers: Record<string, string>;
  /** The written body; undefined for no body, or while a stream is the body. */
  body?: string | Buffer;
  /** Set when the body is a stream, which goes out piece by piece. */
  readonly stream?: AsyncIterable<Uint8Array | string>;
  /** Set-Cookie headers, one per cookie. */
  cookies?: string[];
};

/** Returns nothing to go on, or a value to answer with right away, as a handler would. Throws a problem to stop. */
export type RequestHook<Deco = {}> = (ctx: Ctx<Deco>) => unknown;
export type SendHook<Deco = {}> = (ctx: Ctx<Deco>, answer: Outgoing) => void | Outgoing | Promise<void | Outgoing>;
export type ResponseHook<Deco = {}> = (ctx: Ctx<Deco>, done: RequestLog) => unknown;
export type ProblemHook<Deco = {}> = (ctx: Ctx<Deco>, problem: HttpProblem) => void | HttpProblem | Promise<void | HttpProblem>;
/**
 * Adds to the OpenAPI operation of a route. `components` is the document's components
 * object: its `securitySchemes` already hold the schemes the routes ask for, so a hook can
 * fill in details such as `bearerFormat`, or add sections of its own (`responses`, `parameters`).
 * `ref(schema, name?)` lists a `t.*` schema once under `components.schemas` and returns
 * `{ $ref }` to it, as a route's named schemas are; an unnamed schema needs `name`.
 * `route` is the route as written: `method`, `path`, `security`, `meta` and its `spec`.
 */
export type OperationHook = (
  operation: Record<string, any>,
  route: OperationRoute,
  components: Record<string, Record<string, any>>,
  ref: (schema: Schema<any>, name?: string) => JsonSchema,
) => void;

export type Hooks = {
  onRequest: RequestHook<any>[];
  preHandler: RequestHook<any>[];
  onSend: SendHook<any>[];
  onResponse: ResponseHook<any>[];
  onProblem: ProblemHook<any>[];
};
const KINDS = ["onRequest", "preHandler", "onSend", "onResponse", "onProblem"] as const;
const emptyHooks = (): Hooks => ({ onRequest: [], preHandler: [], onSend: [], onResponse: [], onProblem: [] });

/** The one empty set every route without hooks points at; the request path checks for exactly this object. */
export const NO_HOOKS: Hooks = Object.freeze({
  onRequest: Object.freeze([]) as never,
  preHandler: Object.freeze([]) as never,
  onSend: Object.freeze([]) as never,
  onResponse: Object.freeze([]) as never,
  onProblem: Object.freeze([]) as never,
});

/** Names a context has by itself; `decorate` will not cover them. */
const RESERVED = new Set(["method", "path", "id", "ip", "remote", "params", "query", "headers", "body", "state", "route", "req", "res", "status", "header", "target", "host", "out", "_query", "_state", "_status", "_header", "text", "html", "redirect", "notFound", "render", "cookies", "setCookie", "clearCookie", "rawCookie", "_cookies", "_setCookie", "_clearCookie", "_render", "_layout", "_forwarded", "raw", "rawHeaders", "secure", "protocol"]);

/**
 * What a scope holds. Its context class extends the one of the scope around it, so a
 * decoration made outside is seen inside, even when it is made later, and never the
 * other way round.
 */
export class Box {
  parent?: Box;
  hooks: Hooks = emptyHooks();
  /** onSend hooks that run after every other one: `onSend(fn, { last: true })`. */
  lastSend: SendHook<any>[] = [];
  /** What this scope adds to the OpenAPI operations of its routes: `describe(fn)`. */
  describers: OperationHook[] = [];
  Ctx: typeof RequestContext;
  constructor(parent?: Box) {
    this.parent = parent;
    this.Ctx = class extends (parent?.Ctx ?? RequestContext) {};
  }

  /** The boxes from the app down to here, the app's first. */
  chain(): Box[] {
    const chain: Box[] = [];
    for (let b: Box | undefined = this; b; b = b.parent) chain.unshift(b);
    return chain;
  }

  /**
   * Every hook from the app down to here, outermost first; NO_HOOKS when there is none.
   * onSend hooks marked `last` come after all the others, again outermost first: that is
   * where `compress` sits, so a hook that reads the body (an ETag) sees it unpacked,
   * wherever it was registered.
   */
  flatten(): Hooks {
    const chain = this.chain();
    const out = emptyHooks();
    for (const b of chain) for (const k of KINDS) (out[k] as unknown[]).push(...b.hooks[k]);
    for (const b of chain) out.onSend.push(...b.lastSend);
    return KINDS.some((k) => out[k].length) ? out : NO_HOOKS;
  }
}

/** What the app does for every scope inside it. */
export interface Root {
  /** @internal */
  _dev: boolean;
  _addRoute(r: RouteRecord): void;
  _load(run: () => unknown): void;
  _changed(): void;
  _jobHub(): JobHub;
}

const SHARED = Symbol("inkan.shared");
/** Only a type: what a shared plugin puts on the context of the scope it is registered in. */
declare const ADDS: unique symbol;

/**
 * A plugin: a function that gets a scope of its own and the options it was registered with.
 * Make one with `plugin()` to name it or to share what it adds with the scope around it.
 * `Deco` is what it needs on the context, `Adds` what a shared one puts there.
 */
export type Plugin<O = any, Deco = any, Adds = {}> = ((app: Scope<{}, Deco>, options: O) => unknown) & {
  readonly [SHARED]?: boolean;
  readonly pluginName?: string;
  readonly [ADDS]?: Adds;
};

/**
 * Makes a plugin. `shared: true` puts its hooks and decorations into the scope it is
 * registered in instead of a scope of its own: right for a plugin whose whole point is to
 * act on the routes around it, like a rate limit or CORS.
 *
 * A shared plugin that returns its scope hands on the types of its decorations: after
 * `app.register(auth)` the handlers see `ctx.user` typed. Type the options on the
 * parameter, not as a type argument, or there is nothing left to infer them from.
 *
 *   const auth = plugin((app, o: AuthOptions) => app.decorateRequest("user", (ctx) => read(ctx, o)), { shared: true });
 */
export function plugin<O = {}, Deco = {}, R = void>(
  setup: (app: Scope<{}, Deco>, options: O) => R,
  opts: { name?: string; shared: true },
): Plugin<O, Deco, DecoOf<Awaited<R>>>;
export function plugin<O = {}, Deco = {}>(setup: (app: Scope<{}, Deco>, options: O) => unknown, opts?: { name?: string; shared?: boolean }): Plugin<O, Deco>;
export function plugin(setup: (app: Scope, options: unknown) => unknown, opts: { name?: string; shared?: boolean } = {}): Plugin {
  const p = (app: Scope, options: unknown) => setup(app, options);
  return Object.defineProperties(p, {
    [SHARED]: { value: Boolean(opts.shared) },
    pluginName: { value: opts.name ?? setup.name },
  }) as Plugin;
}

/**
 * Routes with hooks, decorations and plugins of their own. The app is one; `register`
 * hands every plugin another, inside the one it is registered on.
 */
export class Scope<Defs extends RouteDefs = any, Deco = any> extends Routes<Defs, Deco> {
  /** @internal */
  _root: Root;
  /** @internal */
  _box: Box;
  /** @internal */
  _prefix: string;

  constructor(root?: Root, box?: Box, prefix = "") {
    super();
    this._root = root ?? (this as unknown as Root);
    this._box = box ?? new Box();
    this._prefix = prefix;
  }

  /** Whether the app runs in development: its `dev` option, by default NODE_ENV is not "production". */
  get dev(): boolean {
    return this._root._dev;
  }

  /** This scope's path prefix: "" for the app, "/v1" for a plugin registered with `{ prefix: "/v1" }`. */
  get prefix(): string {
    return this._prefix;
  }

  /** @internal A route of this scope: under its prefix, with its middleware, its hooks and its decorations. */
  override add(r: RouteRecord) {
    this._root._addRoute({
      ...r,
      path: this._prefix ? joinPath(this._prefix, r.path) : r.path,
      use: [...this._use, ...r.use],
      security: r.security ?? this._security,
      box: this._box,
    });
  }

  private hook<K extends keyof Hooks>(kind: K, fn: Hooks[K][number]): this {
    (this._box.hooks[kind] as unknown[]).push(fn);
    this._root._changed();
    return this;
  }

  /**
   * Runs once a route is found, before the body is read: auth, rate limits. Return a value to
   * answer at once. The pages inkan serves itself (`/docs`, `/openapi.json`, `/_inkan`) are
   * answered before any hook runs, so no hook sees them.
   */
  onRequest(fn: RequestHook<Deco>): this {
    return this.hook("onRequest", fn);
  }
  /** Runs after the input is checked, before the handler: rules that need the typed input. */
  preHandler(fn: RequestHook<Deco>): this {
    return this.hook("preHandler", fn);
  }
  /**
   * Sees every answer before it is written, problems too, and may change it: headers,
   * compression, envelopes. Hooks run outermost scope first, in the order they were added.
   * `{ last: true }` runs a hook after every other onSend hook of the route instead, for one
   * that changes the body's bytes: `compress` is one, so a hook that reads the body (an
   * ETag, a signature) always sees it before it is packed, wherever either was registered.
   * The pages inkan serves itself (`/docs`, `/openapi.json`, `/_inkan`) are answered before
   * any hook runs: headers set here (secure headers, CORS) do not reach them.
   */
  onSend(fn: SendHook<Deco>, options?: { last?: boolean }): this {
    if (!options?.last) return this.hook("onSend", fn);
    this._box.lastSend.push(fn);
    this._root._changed();
    return this;
  }
  /** Runs after the answer is written: metrics, audit logs. It cannot change the answer any more. */
  onResponse(fn: ResponseHook<Deco>): this {
    return this.hook("onResponse", fn);
  }
  /** Sees every problem before it becomes an answer, and may change it or return another. */
  onProblem(fn: ProblemHook<Deco>): this {
    return this.hook("onProblem", fn);
  }

  /**
   * How the pages of this scope look around what `ctx.render(content, props)` hands in: the
   * head, the header, the footer. A plugin can have its own; inside one, the closest wins.
   *
   *   app.layout((content, { title }) => html`<!doctype html><title>${title}</title><main>${content}</main>`);
   */
  layout(fn: Layout): this {
    this._box.Ctx.prototype._layout = fn;
    return this;
  }

  /**
   * Puts a value on the context of every handler and hook in this scope: `ctx.db`. It is
   * set once, on the context's prototype, so it costs nothing per request. A name the
   * context already has, by itself or from a decoration around it, is refused.
   */
  decorate: DecorateMethod<this> = ((name: string, value: unknown) => {
    const proto = this._box.Ctx.prototype;
    if (RESERVED.has(name) || name in proto) throw new Error(`Cannot decorate ctx.${name}: the context already has a ${name}`);
    Object.defineProperty(proto, name, { value, writable: true, enumerable: true, configurable: true });
    return this;
  }) as never;

  /**
   * Puts a value on the context of every handler and hook in this scope that is made anew
   * for each request: `ctx.user`. `init` runs the first time a request reads it and the
   * value is kept on that context, so it runs at most once per request, and not at all for
   * one that never asks. Only the scopes that use it pay for it: a getter on their
   * context's prototype. Names are refused as with `decorate`.
   *
   *   app.decorateRequest("user", (ctx) => sessions.get(ctx.cookies.sid));
   */
  decorateRequest: DecorateRequestMethod<this> = ((name: string, init: (ctx: any) => unknown) => {
    const proto = this._box.Ctx.prototype;
    if (RESERVED.has(name) || name in proto) throw new Error(`Cannot decorate ctx.${name}: the context already has a ${name}`);
    const keep = (ctx: object, value: unknown) => Object.defineProperty(ctx, name, { value, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(proto, name, {
      get(this: object) {
        const value = init(this);
        keep(this, value); // an own property from now on: init runs once per request
        return value;
      },
      set(this: object, value: unknown) {
        keep(this, value);
      },
      enumerable: true,
      configurable: true,
    });
    return this;
  }) as never;

  /**
   * Work that takes longer than a request: five routes around a queue. `POST path` starts a
   * job (202, with its location), `GET path/:id` tells how it stands, `GET path/:id/events`
   * follows it as server-sent events, `GET path/:id/result?wait=10` hands over what it made,
   * `DELETE path/:id` cancels it. Jobs run in this process: one still running when it ends is lost.
   *
   *   app.job("/exports", { body, progress, result }, async (job) => {
   *     job.progress({ done: 1, total: 2 });
   *     return { url: "/x.csv", rows: 2 };
   *   });
   */
  job: JobMethod<this> = ((path: string, options: object, run: (job: never) => unknown) => {
    defineJob(this._root._jobHub(), (m, p, spec, h) => void this.define(m, p, spec, h), this._prefix, path, options, run as never);
    return this;
  }) as never;

  /**
   * Adds to the OpenAPI operation of every route in this scope and the scopes inside it:
   * header parameters, answers, descriptions, details of a security scheme. Runs when the
   * document is written, never per request. Outer scopes' hooks run first.
   *
   *   app.describe((op, route, components, ref) => {
   *     if (components.securitySchemes?.bearer) components.securitySchemes.bearer.bearerFormat = "JWT";
   *     if (route.security?.length) op.responses["403"] ??= { description: "Not allowed for these credentials" };
   *     op.responses["409"] ??= { description: "Replayed", content: { "application/json": { schema: ref(Conflict, "Conflict") } } };
   *   });
   */
  describe(fn: OperationHook): this {
    this._box.describers.push(fn);
    this._root._changed();
    return this;
  }

  /**
   * A route for every file in a folder: `teas/[id].ts` exporting `GET` is `GET /teas/:id`,
   * under this scope's prefix. It loads in order with the plugins, and `ready()` waits for it.
   * Pass `new URL("./routes", import.meta.url)` to name the folder next to the file.
   */
  load(dir: string | URL): this {
    const folder = folderOf(dir);
    this._root._load(() => loadRoutes(folder, (method, path, spec, handler) => void this.define(method, path, spec, handler)));
    return this;
  }

  /**
   * Runs a plugin with a scope of its own, under `prefix` if given. Plugins run in the order
   * they are registered; one that returns a promise holds back the ones after it, and
   * `await app.ready()` (or `listen`) waits for all of them.
   */
  register: RegisterMethod<this> = ((p: Plugin, options?: { prefix?: string }) => {
    const shared = p[SHARED] === true;
    const prefix = options?.prefix ? joinPath(this._prefix, options.prefix) : this._prefix;
    const scope = new Scope<{}, Deco>(this._root, shared ? this._box : new Box(this._box), prefix);
    this._root._load(() => p(scope, options ?? {}));
    return this;
  }) as never;
}

/** Runs request hooks in order; the first one that returns something ends the run with that. */
export async function runHooks(list: RequestHook<any>[], ctx: Ctx<unknown>): Promise<unknown> {
  for (const h of list) {
    let v = h(ctx);
    if (v instanceof Promise) v = await v;
    if (v !== undefined) return v;
  }
  return undefined;
}

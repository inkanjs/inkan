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
import { RequestContext } from "./context.ts";
import { folderOf, loadRoutes } from "./files.ts";
import type { HttpProblem } from "./problem.ts";
import { joinPath, Routes, type Context, type RouteDefs, type RouteRecord, type WithDeco } from "./route.ts";

type Ctx<Deco> = Context<any, any, any, any, any> & Deco;
/** `decorate` as a property, so its type can name the app or scope it returns. */
export type DecorateMethod<Self> = <K extends string, V>(name: K, value: V) => WithDeco<Self, { [P in K]: V }>;

/** An answer on its way out, as onSend sees it. A hook may change it, or return another. */
export type Outgoing = {
  status: number;
  headers: Record<string, string>;
  /** The written body; undefined for no body, or while a stream is the body. */
  body?: string | Buffer;
  /** Set when the body is a stream, which goes out piece by piece. */
  readonly stream?: AsyncIterable<Uint8Array | string>;
};

/** Returns nothing to go on, or a value to answer with right away, as a handler would. Throws a problem to stop. */
export type RequestHook<Deco = {}> = (ctx: Ctx<Deco>) => unknown;
export type SendHook<Deco = {}> = (ctx: Ctx<Deco>, answer: Outgoing) => void | Outgoing | Promise<void | Outgoing>;
export type ResponseHook<Deco = {}> = (ctx: Ctx<Deco>, done: RequestLog) => unknown;
export type ProblemHook<Deco = {}> = (ctx: Ctx<Deco>, problem: HttpProblem) => void | HttpProblem | Promise<void | HttpProblem>;

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
const RESERVED = new Set(["method", "path", "id", "params", "query", "headers", "body", "state", "route", "req", "res", "status", "header", "target", "host"]);

/**
 * What a scope holds. Its context class extends the one of the scope around it, so a
 * decoration made outside is seen inside, even when it is made later, and never the
 * other way round.
 */
export class Box {
  parent?: Box;
  hooks: Hooks = emptyHooks();
  Ctx: typeof RequestContext;
  constructor(parent?: Box) {
    this.parent = parent;
    this.Ctx = class extends (parent?.Ctx ?? RequestContext) {};
  }

  /** Every hook from the app down to here, outermost first; NO_HOOKS when there is none. */
  flatten(): Hooks {
    const chain: Box[] = [];
    for (let b: Box | undefined = this; b; b = b.parent) chain.unshift(b);
    const out = emptyHooks();
    for (const b of chain) for (const k of KINDS) (out[k] as unknown[]).push(...b.hooks[k]);
    return KINDS.some((k) => out[k].length) ? out : NO_HOOKS;
  }
}

/** What the app does for every scope inside it. */
export interface Root {
  _addRoute(r: RouteRecord): void;
  _load(run: () => void | Promise<void>): void;
  _changed(): void;
}

const SHARED = Symbol("inkan.shared");

/**
 * A plugin: a function that gets a scope of its own and the options it was registered with.
 * Make one with `plugin()` to name it or to share what it adds with the scope around it.
 */
export type Plugin<O = any, Deco = any> = ((app: Scope<{}, Deco>, options: O) => void | Promise<void>) & {
  readonly [SHARED]?: boolean;
  readonly pluginName?: string;
};

/**
 * Makes a plugin. `shared: true` puts its hooks and decorations into the scope it is
 * registered in instead of a scope of its own: right for a plugin whose whole point is to
 * act on the routes around it, like a rate limit or CORS.
 */
export function plugin<O = {}, Deco = {}>(
  setup: (app: Scope<{}, Deco>, options: O) => void | Promise<void>,
  opts: { name?: string; shared?: boolean } = {},
): Plugin<O, Deco> {
  const p = (app: Scope<{}, Deco>, options: O) => setup(app, options);
  return Object.defineProperties(p, {
    [SHARED]: { value: Boolean(opts.shared) },
    pluginName: { value: opts.name ?? setup.name },
  }) as Plugin<O, Deco>;
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

  /** Runs once a route is found, before the body is read: auth, rate limits. Return a value to answer at once. */
  onRequest(fn: RequestHook<Deco>): this {
    return this.hook("onRequest", fn);
  }
  /** Runs after the input is checked, before the handler: rules that need the typed input. */
  preHandler(fn: RequestHook<Deco>): this {
    return this.hook("preHandler", fn);
  }
  /** Sees every answer before it is written, problems too, and may change it: headers, compression, envelopes. */
  onSend(fn: SendHook<Deco>): this {
    return this.hook("onSend", fn);
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
  register<O extends object = {}>(p: Plugin<O, Deco> | ((app: Scope<{}, Deco>, options: O) => void | Promise<void>), options?: O & { prefix?: string }): this {
    const shared = (p as Plugin)[SHARED] === true;
    const prefix = options?.prefix ? joinPath(this._prefix, options.prefix) : this._prefix;
    const scope = new Scope<{}, Deco>(this._root, shared ? this._box : new Box(this._box), prefix);
    this._root._load(() => p(scope, (options ?? {}) as O));
    return this;
  }
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

import { Reply, type Context, type Middleware } from "../core/route.ts";
import { plugin, Scope, type Plugin } from "../core/scope.ts";
import type { Origins, PreContext } from "../core/ws.ts";
import { deprecate } from "../core/deprecate.ts";

export type CorsOptions = {
  /**
   * Which origins may call: `"*"` (the default), a list, or a function that decides, given
   * the Origin header and the request. A request without an Origin is no cross-origin call
   * and gets no CORS headers, so the function is only asked about one with an Origin.
   */
  origins?: Origins;
  /** @deprecated Use `origins`: a list instead of one origin, and a function that gets `(origin, ctx)`. */
  origin?: "*" | string | string[] | ((origin: string) => boolean);
  /** Lets the browser send cookies and auth headers. The origin is then echoed instead of `*`. */
  credentials?: boolean;
  /** How long, in seconds, the browser may reuse a preflight answer. */
  maxAge?: number;
  /** Methods a preflight allows. Default: every method inkan routes. */
  methods?: string[];
  /** Request headers a preflight allows. Default: whatever the browser asks for. */
  allowHeaders?: string[];
  /** Response headers the page may read besides the simple ones. */
  exposeHeaders?: string[];
};

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

/** `cors(…)`: a plugin to register, and for now still middleware for `app.use`. */
export type Cors = Plugin<{}, {}> & Middleware;

/**
 * Answers browser preflights and marks every answer for allowed origins. A shared plugin:
 * `app.register(cors(…))` covers every route of the app, `scope.register(cors(…))` the
 * routes of that scope. Preflights to a path without an OPTIONS route are answered too.
 * Passed to `app.use`, as before 0.8, it still works as middleware, and is deprecated so.
 */
export function cors(options: CorsOptions = {}): Cors {
  const { credentials = false, maxAge, methods = METHODS, allowHeaders, exposeHeaders } = options;
  if (options.origin !== undefined && options.origins === undefined) deprecate("cors({ origin })", "cors({ origins })");
  const old = options.origin;
  const origin: Origins = options.origins ?? (typeof old === "string" && old !== "*" ? [old] : (old as Origins | undefined)) ?? "*";
  const allowed: (o: string, ctx: PreContext) => boolean =
    typeof origin === "function" ? (o, ctx) => origin(o, ctx) === true : Array.isArray(origin) ? (o) => origin.includes(o) : () => true;

  /** Marks the answer; true for a preflight, which is answered right away with a 204. */
  const mark = (ctx: Context<any, any, any, any, any>): boolean => {
    const from = ctx.rawHeaders.origin as string | undefined;
    if (!from || !allowed(from, ctx as PreContext)) return false;

    const echo = origin !== "*" || credentials;
    ctx.header("access-control-allow-origin", echo ? from : "*");
    if (echo) ctx.header("vary", "origin");
    if (credentials) ctx.header("access-control-allow-credentials", "true");

    const preflight = ctx.method === "OPTIONS" && ctx.rawHeaders["access-control-request-method"];
    if (!preflight) {
      if (exposeHeaders?.length) ctx.header("access-control-expose-headers", exposeHeaders.join(", "));
      return false;
    }
    ctx.header("access-control-allow-methods", methods.join(", "));
    const asked = allowHeaders?.join(", ") ?? (ctx.rawHeaders["access-control-request-headers"] as string | undefined);
    if (asked) ctx.header("access-control-allow-headers", asked);
    if (maxAge !== undefined) ctx.header("access-control-max-age", String(maxAge));
    return true;
  };

  const shared = plugin((app) => void app.onRequest((ctx) => (mark(ctx) ? new Reply(204, undefined) : undefined)), { name: "cors", shared: true });
  let warned = false;
  // the middleware of 0.7, for app.use(cors()): the same marks, before routing
  const middleware: Middleware = (ctx, next) => {
    if (!warned) {
      warned = true;
      deprecate("app.use(cors())", "app.register(cors())");
    }
    if (!mark(ctx)) return next();
    ctx.status(204);
  };
  const both = (a: unknown, b: unknown) => (a instanceof Scope ? shared(a, b as {}) : middleware(a as never, b as never));
  return Object.defineProperties(both, Object.getOwnPropertyDescriptors(shared)) as unknown as Cors;
}

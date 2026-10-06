import type { Middleware } from "./app.ts";

export type CorsOptions = {
  /** Which origins may call: `"*"` (the default), one origin, a list, or a function that decides. */
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

/** Answers browser preflights and marks every answer for allowed origins. Add it with `app.use(cors(…))`. */
export function cors(options: CorsOptions = {}): Middleware {
  const { origin = "*", credentials = false, maxAge, methods = METHODS, allowHeaders, exposeHeaders } = options;
  const allowed =
    typeof origin === "function"
      ? origin
      : Array.isArray(origin)
        ? (o: string) => origin.includes(o)
        : (o: string) => origin === "*" || origin === o;

  return async (ctx, next) => {
    const from = ctx.headers.origin;
    if (!from || !allowed(from)) return next();

    const echo = origin !== "*" || credentials;
    ctx.header("access-control-allow-origin", echo ? from : "*");
    if (echo) ctx.header("vary", "origin");
    if (credentials) ctx.header("access-control-allow-credentials", "true");

    const preflight = ctx.method === "OPTIONS" && ctx.headers["access-control-request-method"];
    if (!preflight) {
      if (exposeHeaders?.length) ctx.header("access-control-expose-headers", exposeHeaders.join(", "));
      return next();
    }
    ctx.header("access-control-allow-methods", methods.join(", "));
    const asked = allowHeaders?.join(", ") ?? ctx.headers["access-control-request-headers"];
    if (asked) ctx.header("access-control-allow-headers", asked);
    if (maxAge !== undefined) ctx.header("access-control-max-age", String(maxAge));
    ctx.status(204);
  };
}

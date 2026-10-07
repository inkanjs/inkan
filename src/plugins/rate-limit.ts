// A rate limit, built on nothing but the public plugin API: one onRequest hook. Shared,
// so it acts on the routes of the scope it is registered in.
//
//   app.register(rateLimit({ max: 100, window: 60_000 }))   // every route
//   inside a plugin: app.register(rateLimit({ max: 5 }))     // that plugin's routes only

import type { Context } from "../core/route.ts";
import { HttpProblem } from "../core/problem.ts";
import { plugin } from "../core/scope.ts";

export type RateLimitOptions = {
  /** Requests a client may make per window. */
  max: number;
  /** The window in milliseconds. Default one minute. */
  window?: number;
  /** Who counts as one client. Default: the remote address, or "local" without a socket. */
  key?: (ctx: Context<any, any, any, any, any>) => string;
};

type Count = { n: number; reset: number };

/**
 * At most `max` requests per client per `window`; the one after gets a 429 problem with
 * `retry-after`. Every answer says how many are left in `x-ratelimit-remaining`. Counts
 * live in memory, per process: behind several processes, each one counts for itself.
 */
export const rateLimit = (opts: RateLimitOptions) =>
  plugin(
    (app) => {
      const window = opts.window ?? 60_000;
      const counts = new Map<string, Count>();
      let sweep = Date.now() + window;
      const keyOf = opts.key ?? ((ctx) => ctx.req?.socket.remoteAddress ?? "local");

      app.onRequest((ctx) => {
        const now = Date.now();
        if (now > sweep) {
          // forget clients whose window is over, so the map does not grow without end
          for (const [k, c] of counts) if (c.reset <= now) counts.delete(k);
          sweep = now + window;
        }
        const key = keyOf(ctx);
        let c = counts.get(key);
        if (!c || c.reset <= now) counts.set(key, (c = { n: 0, reset: now + window }));
        c.n++;
        ctx.header("x-ratelimit-limit", String(opts.max));
        ctx.header("x-ratelimit-remaining", String(Math.max(0, opts.max - c.n)));
        if (c.n > opts.max) {
          const wait = Math.ceil((c.reset - now) / 1000);
          throw new HttpProblem(429, "rate-limited", `At most ${opts.max} requests per ${window / 1000}s; try again in ${wait}s`, {}, {
            "retry-after": String(wait),
          });
        }
      });
    },
    { name: "rate-limit", shared: true },
  );

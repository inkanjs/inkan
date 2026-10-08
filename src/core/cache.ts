// A route's handler, remembered: the same input within the time given gets the same value,
// and requests that come in while it is still being worked out wait for that one answer
// instead of each asking the database again.

import type { Context, Handler } from "./route.ts";
import { Reply } from "./route.ts";
import { EventStream, isStream } from "./stream.ts";

export type CacheRule = {
  /** How long an answer is kept. */
  seconds: number;
  /**
   * Answers are kept per caller unless this is true: the request's authorization and cookie
   * headers are part of the key, so one user never gets another's answer. Set it only for
   * answers that are the same for everybody.
   */
  shared?: boolean;
  /** At most this many answers are kept; past it the oldest goes. Default 1000. */
  max?: number;
};

type Entry = { until: number; value: unknown; status: number; headers: Record<string, string> };
type Ctx = Context<any, any, any, any, any> & { _caller(): string; _out(): { status: number; headers: Record<string, string> } };

/** Plain values only: an answer that is a stream, an event stream or a reply is made anew each time. */
const keepable = (v: unknown) => !(v instanceof Reply) && !(v instanceof EventStream) && !isStream(v);

/** The handler with a memory, per route and per process. A handler that throws keeps nothing. */
export function cached(handler: Handler<any, any, any, any, any>, rule: CacheRule): Handler<any, any, any, any, any> {
  const ms = rule.seconds * 1000;
  const max = rule.max ?? 1000;
  const kept = new Map<string, Entry>();
  const pending = new Map<string, Promise<Entry | undefined>>();

  const replay = (ctx: Ctx, e: Entry) => {
    const out = ctx._out();
    if (e.status) out.status = e.status;
    Object.assign(out.headers, e.headers);
    return e.value;
  };

  return (c) => {
    const ctx = c as Ctx;
    const key = JSON.stringify([ctx.params, ctx.query, rule.shared ? "" : ctx._caller()]);
    const hit = kept.get(key);
    if (hit && hit.until > Date.now()) return replay(ctx, hit) as never;
    if (hit) kept.delete(key);
    const waiting = pending.get(key);
    if (waiting) return waiting.then((e) => (e ? replay(ctx, e) : handler(ctx))) as never;

    // the headers before the handler, so only what the handler adds is kept with the value
    const out = ctx._out();
    const before = new Set(Object.keys(out.headers));
    const remember = (value: unknown): unknown => {
      if (!keepable(value) || out.status >= 300) return value;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(out.headers)) if (!before.has(k)) headers[k] = v;
      kept.set(key, { until: Date.now() + ms, value, status: out.status, headers });
      if (kept.size > max) kept.delete(kept.keys().next().value!);
      return value;
    };
    const result = handler(ctx);
    if (!(result instanceof Promise)) return remember(result) as never;
    // the ones that come in meanwhile wait for this answer; a failure lets each try on its own
    const work = result.then(remember);
    pending.set(
      key,
      work.then(
        () => kept.get(key),
        () => undefined,
      ),
    );
    return work.finally(() => pending.delete(key)) as never;
  };
}

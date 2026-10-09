// The context of the request being answered, for code far from the handler: `context()`.
// Made only when an app asks for it (`context: true`); until then there is no storage at all.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "./route.ts";

/** What a request's store holds. Filled once the request has its context, a moment after the store is entered. */
export type Cell = { ctx: Context<any, any, any, any, any> | undefined };

let storage: AsyncLocalStorage<Cell> | undefined;

/** @internal The one storage of the process, made by the first app with `context: true`. */
export function contextStorage(): AsyncLocalStorage<Cell> {
  return (storage ??= new AsyncLocalStorage<Cell>());
}

/**
 * The context of the request being answered, wherever the code is that asks: a database
 * helper, a logger, a function three calls down from the handler. Needs an app made with
 * `context: true`; without one anywhere in the process it throws, since it could only ever
 * hand back undefined. Outside a request (at startup, in a timer started outside one) it is
 * undefined. A background job runs with its own: `job.ctx`, not the request that started it.
 *
 *   const log = (msg: string) => console.log(`[${context()?.id ?? "-"}] ${msg}`);
 */
export function context<C = Context<any, any, any, any, any>>(): C | undefined {
  if (!storage) throw new Error("inkan: context() needs an app made with { context: true }; without it there is no request to hand back");
  return storage.getStore()?.ctx as C | undefined;
}

/**
 * @internal Runs `fn` with `ctx` as what `context()` hands back, or with nothing for
 * undefined: so work that outlives a request (a job, a timer) does not keep the request's
 * store. Without any app using `context`, just runs it.
 */
export function within<T>(ctx: Context<any, any, any, any, any> | undefined, fn: () => T): T {
  if (!storage) return fn();
  return ctx ? storage.run({ ctx }, fn) : storage.exit(fn);
}

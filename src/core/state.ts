// Typed slots in `ctx.state`: a plugin hands a value to the hooks and handlers after it
// without agreeing on a string key with anyone, and both ends see the same type.

/**
 * One slot in `ctx.state`. Its key is a symbol of its own, so two plugins that pick the
 * same name never meet, and `ctx.state` stays a plain record for everyone else.
 *
 *   export const tenant = stateKey<Tenant>("tenant");
 *   app.onRequest((ctx) => tenant.set(ctx, lookUp(ctx)));
 *   app.get("/me", (ctx) => tenant.get(ctx)?.name);
 *
 * @experimental
 */
export type StateKey<T> = {
  /** The name it was made with, for messages. */
  readonly name: string;
  /** The value set for this request, or undefined. */
  get(ctx: { readonly state: object }): T | undefined;
  set(ctx: { readonly state: object }, value: T): void;
};

/**
 * A typed slot in `ctx.state`; see `StateKey`. Make it once, at the top of a module.
 * @experimental
 */
export function stateKey<T>(name: string): StateKey<T> {
  const key = Symbol(name);
  return Object.freeze({
    name,
    get: (ctx: { readonly state: object }) => (ctx.state as Record<symbol, T | undefined>)[key],
    set: (ctx: { readonly state: object }, value: T) => void ((ctx.state as Record<symbol, T>)[key] = value),
  });
}

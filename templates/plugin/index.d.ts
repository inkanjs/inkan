import type { Plugin } from "@vxnsin/inkan";

export type MyPluginOptions = {
  /** The header to read. Default `"x-tenant"`. */
  header?: string;
};

/**
 * Asks every request for a header, answers 400 without it, and puts it on the context as
 * `ctx.tenant`. Shared: register it on the app or the scope whose routes it serves.
 */
export declare function myPlugin(options?: MyPluginOptions): Plugin<{}, {}, { tenant: string }>;
export default myPlugin;

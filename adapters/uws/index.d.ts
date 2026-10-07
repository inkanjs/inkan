import type { App } from "@vxnsin/inkan";

export type Served = {
  /** The port it listens on, also when it was asked for 0. */
  readonly port: number;
  /** Stops taking requests, then runs the app's onClose hooks. */
  close(): Promise<void>;
};

/** Serves an inkan app on uWebSockets.js. Resolves once it listens, after the app's plugins and onListen hooks. */
export function serve(app: App, options?: { port?: number; host?: string }): Promise<Served>;

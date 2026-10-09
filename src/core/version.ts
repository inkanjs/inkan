// The version of inkan that runs, for plugins that name the versions they work with.
//
// Read from inkan's own package.json, which sits two folders up from here both in the
// repository (src/core/) and in the package (dist/core/), the way the CLI reads it. Read
// once, the first time a plugin asks; an app whose plugins name no range never reads it.

import { readFileSync } from "node:fs";
import { satisfies } from "./semver.ts";

let known: string | null | undefined;

/**
 * The running inkan's version, or undefined where its package.json is not there to read:
 * bundled into one file, say. Then no range can be checked, and none is.
 */
export function inkanVersion(): string | undefined {
  if (known === undefined) {
    try {
      const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
      known = pkg.name === "@vxnsin/inkan" && typeof pkg.version === "string" ? pkg.version : null;
    } catch {
      known = null;
    }
  }
  return known ?? undefined;
}

/** Throws when `running` is not in the range a plugin asks for, with what it asks and what runs. */
export function checkInkan(name: string, range: string, running = inkanVersion()): void {
  if (running === undefined || satisfies(running, range)) return;
  throw new Error(`${name} needs inkan ${range}, this app runs ${running}`);
}

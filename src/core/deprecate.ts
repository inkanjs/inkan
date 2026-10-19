// Old names that still work: one warning each, the first time one is used, and only in
// development. Called where the old name is read (when a route, a plugin or an option is
// set up), never on the request path.

const warned = new Set<string>();

/**
 * @internal Says once per process that `name` is deprecated and what to use instead. Silent
 * when NODE_ENV is "production". See docs/STABILITY.md for how long an old name stays.
 */
export function deprecate(name: string, use: string): void {
  if (warned.has(name) || process.env.NODE_ENV === "production") return;
  warned.add(name);
  console.warn(`inkan: ${name} is deprecated, use ${use}. It keeps working until a later minor release removes it (see the CHANGELOG).`);
}

// Environment variables, checked once at startup with the same schemas as everything else.

import type { InferShape, ObjectSchema, Shape } from "../schema/schema.ts";

/** Names whose values never appear in a message: `JWT_SECRET`, `API_TOKEN`, `STRIPE_KEY`, `DB_PASSWORD`. */
const SECRET = /SECRET|TOKEN|KEY|PASSWORD/i;

/**
 * Reads the environment through a `t.object` schema, coerced as a query string is: numbers,
 * booleans (`true`/`false`/`1`/`0`), enums, defaults and optional fields. An empty variable
 * (`PORT=`) counts as unset, so its default applies. Hands back the typed, frozen value, or
 * throws one error that lists every problem at once; the value of a variable whose name looks
 * secret (SECRET, TOKEN, KEY, PASSWORD) is never part of it.
 *
 *   export const config = env(t.object({
 *     PORT: t.int().default(3000),
 *     DATABASE_URL: t.string(),
 *     LOG: t.enum(["pretty", "json"]).optional(),
 *   }));
 */
export function env<S extends Shape>(schema: ObjectSchema<S>, source: Record<string, string | undefined> = process.env): Readonly<InferShape<S>> {
  const given: Record<string, string> = {};
  for (const key of Object.keys(schema.shape)) {
    const v = source[key];
    if (v !== undefined && v !== "") given[key] = v;
  }
  const r = schema.safeParse(given, { coerce: true });
  if (r.ok) return Object.freeze(r.value);
  const lines = r.issues.map((i) => {
    const key = i.path.split(".")[0] ?? i.path;
    let message = i.message.replace(/^expected /, "must be ");
    if (SECRET.test(key)) message = message.replace(/, got .*$/s, "");
    return `  ${i.path || "(env)"} ${message}`;
  });
  const n = lines.length;
  throw new Error(`inkan: ${n} environment variable${n === 1 ? " is" : "s are"} not as expected:\n${lines.join("\n")}`);
}

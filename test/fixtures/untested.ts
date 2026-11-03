import { inkan, t } from "../../src/index.ts";

// A status the route shows on purpose with no example (its own `untested`), and one of a
// route the app takes from elsewhere, a plugin's (the entry's `untested`).
export const app = inkan({ title: "Untested", log: false, gracefulShutdown: false })
  .get(
    "/login",
    {
      response: { 200: t.object({ ok: t.boolean() }), 429: t.problem() },
      untested: { 429: "a lockout takes many failed logins" },
      examples: [{ name: "fine", expect: { ok: true } }],
    },
    () => ({ ok: true }),
  )
  .get("/plugin", { response: { 200: t.object({ ok: t.boolean() }), 503: t.problem() }, examples: [{ name: "fine" }] }, () => ({ ok: true }));

export const untested = { "GET /plugin": { 503: "too many at once" } };

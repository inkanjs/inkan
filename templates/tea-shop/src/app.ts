import { inkan, t } from "@vxnsin/inkan";
import { store } from "./store.ts";
import { teas } from "./teas.ts";

// 1. The app puts the pieces together. Routes live in their own files (see teas.ts).
export const app = inkan({
  title: "Tea Shop",
  version: "1.0.0",
  description: "A small tea shop. Every example on this page is also a test.",
});

// 2. Middleware for every request. It runs around the route: before next(), and after it.
app.use(async (ctx, next) => {
  const started = performance.now();
  await next();
  ctx.header("server-timing", `app;dur=${(performance.now() - started).toFixed(1)}`);
});

app.get(
  "/health",
  { summary: "Is it up?", response: { 200: t.object({ ok: t.boolean() }) }, examples: [{ name: "up" }] },
  () => ({ ok: true }),
);

// 3. The group from teas.ts, under /teas.
app.mount("/teas", teas);

// 4. Examples change data: "a new oolong" adds a tea, "removes it" deletes one.
//    `inkan check` calls an exported beforeEach before every example, so each one
//    starts from the same three teas, in any order.
export const beforeEach = () => store.reset();
store.reset();

app.listen();

import { test } from "node:test";
import assert from "node:assert/strict";
import { currentContext, inkan, stateKey, t, type Context } from "../src/index.ts";

const quiet = { log: false, gracefulShutdown: false } as const;
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// first in this file: no app has turned it on yet
test("currentContext(): throws while no app in the process has context: true", () => {
  assert.throws(() => currentContext(), /needs an app made with \{ context: true \}/);
  inkan(quiet).get("/x", {}, () => "x"); // an app without it changes nothing
  assert.throws(() => currentContext(), /context: true/);
});

/** Deep code: knows nothing of the handler. */
async function whoAsks() {
  await sleep(1);
  return currentContext<Context<any, any, any, any, any> & { user: string }>();
}

test("currentContext(): the request's own context, deep in sync and async code, through middleware and hooks", async () => {
  const seen: string[] = [];
  const app = inkan({ ...quiet, context: true })
    .decorateRequest("user", (ctx) => `user-of-${ctx.id}`)
    .onRequest(() => void seen.push(`hook:${currentContext()!.path}`))
    .use(async (_ctx, next) => {
      seen.push(`mw:${currentContext()!.path}`);
      await next();
    })
    .get("/sync", {}, (ctx) => ({ same: currentContext() === ctx }))
    .get("/deep", {}, async (ctx) => {
      const c = await whoAsks();
      return { same: c === ctx, user: c!.user, id: ctx.id };
    })
    .post("/body", { body: t.object({ n: t.int() }) }, async (ctx) => ({ same: (await whoAsks()) === ctx }));
  assert.equal(currentContext(), undefined, "outside a request");
  assert.deepEqual((await app.inject({ url: "/sync" })).body, { same: true });
  const deep = (await app.inject({ url: "/deep" })).body;
  assert.equal(deep.same, true);
  assert.equal(deep.user, `user-of-${deep.id}`);
  assert.deepEqual((await app.inject({ method: "POST", url: "/body", body: { n: 1 } })).body, { same: true });
  assert.deepEqual(seen.slice(0, 2), ["hook:/sync", "mw:/sync"]);
  assert.equal(currentContext(), undefined, "nothing stays behind");
});

test("currentContext(): concurrent requests never see each other's context", async () => {
  const app = inkan({ ...quiet, context: true }).get("/n/:n", { params: t.object({ n: t.int() }) }, async (ctx) => {
    for (let i = 0; i < 5; i++) {
      await sleep(Math.random() * 5);
      if (currentContext() !== ctx) return { ok: false };
    }
    return { ok: true, n: (currentContext() as typeof ctx).params.n };
  });
  const answers = await Promise.all(Array.from({ length: 60 }, (_, n) => app.inject({ url: `/n/${n}` })));
  answers.forEach((res, n) => assert.deepEqual(res.body, { ok: true, n }));
});

test("currentContext(): a job runs with its own job.ctx, not inside the request that started it", async () => {
  let started: Context<any, any, any, any, any> | undefined;
  let inJob: unknown;
  let jobCtx: unknown;
  const app = inkan({ ...quiet, context: true })
    .use(async (ctx, next) => {
      if (ctx.method === "POST") started = ctx;
      await next();
    })
    .job("/work", {}, async (job) => {
      await sleep(5); // the request is over by now
      inJob = currentContext();
      jobCtx = job.ctx;
      return 1;
    });
  const res = await app.inject({ method: "POST", url: "/work" });
  assert.equal(res.status, 202);
  await app.inject({ url: `/work/${res.body.id}/result?wait=5` });
  assert.equal(inJob, jobCtx);
  assert.notEqual(inJob, started, "not the request's own context object");
  assert.equal((inJob as Context<any, any, any, any, any>).id, started!.id, "but it reads like it");
  await app.stopped();
});

test("stateKey: a typed slot in ctx.state that no string key reaches", async () => {
  const tenant = stateKey<{ name: string }>("tenant");
  const other = stateKey<number>("tenant");
  const app = inkan({ log: false })
    .onRequest((ctx) => {
      tenant.set(ctx, { name: "tea house" });
      ctx.state.tenant = "a string of someone else";
    })
    .get("/me", (ctx) => ({ name: tenant.get(ctx)?.name, other: other.get(ctx) ?? null, plain: ctx.state.tenant, keys: Object.keys(ctx.state) }));
  assert.deepEqual((await app.inject({ url: "/me" })).body, { name: "tea house", other: null, plain: "a string of someone else", keys: ["tenant"] });
  assert.equal(tenant.name, "tenant");
});

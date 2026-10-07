// The bench routes, as an inkan app. Shared by servers.mjs and inproc.mjs.
// Every other server in servers.mjs does the same work by its own means.
// inkan runs with its defaults, request ids included, although the others create none.
import { inkan, problem, t } from "../src/index.ts";
import { LIST, ROUTE_COUNT, user } from "./data.mjs";

const Item = t.object({
  id: t.int(),
  name: t.string(),
  tags: t.array(t.string()),
  price: t.number(),
  inStock: t.boolean(),
  meta: t.object({ created: t.string(), updated: t.string() }),
});
const NewTea = t.object({ name: t.string().min(1), kind: t.enum(["green", "black", "oolong"]), grams: t.int().min(1), price: t.number().min(0) });
const stamp = (name) => async (ctx, next) => {
  ctx.header(`x-${name}`, "1");
  ctx.state.n = (ctx.state.n ?? 0) + 1;
  await next();
};

export const app = (dev = false, seal = undefined) => {
  const a = inkan({ dev, log: false, gracefulShutdown: false, inspector: false, seal })
    .get("/hello", { response: { 200: t.object({ hello: t.string() }) } }, () => ({ hello: "world" }))
    .get(
      "/users/:id",
      {
        params: t.object({ id: t.int() }),
        query: t.object({ fields: t.string().optional() }),
        response: { 200: t.object({ id: t.int(), fields: t.string().nullable() }) },
      },
      ({ params, query }) => user(params.id, query.fields),
    )
    .post(
      "/users",
      {
        body: t.object({ name: t.string().min(1), age: t.int() }),
        response: { 201: t.object({ id: t.int(), name: t.string(), age: t.int() }) },
      },
      ({ body }) => ({ id: 1, ...body }),
    )
    .get("/teas", { response: { 200: t.array(Item) } }, () => LIST)
    .post(
      "/teas/bulk",
      { body: t.object({ items: t.array(NewTea).max(500) }), response: { 201: t.object({ count: t.int() }) } },
      ({ body }) => ({ count: body.items.length }),
    )
    .get(
      "/mw",
      { use: [stamp("a"), stamp("b"), stamp("c")], response: { 200: t.object({ n: t.int() }) } },
      ({ state }) => ({ n: state.n }),
    )
    .get(
      "/async/:id",
      { params: t.object({ id: t.int() }), response: { 200: t.object({ id: t.int() }), 404: t.problem() } },
      async ({ params }) => {
        await new Promise((resolve) => setImmediate(resolve)); // one real hop through the event loop, like a database call
        if (params.id < 0) throw problem(404, "missing");
        return { id: params.id };
      },
    );
  // a router with hundreds of routes; the bench asks for the last one
  for (let i = 0; i < ROUTE_COUNT; i++) {
    a.get(`/static/s${i}`, () => ({ i }));
    a.get(
      `/p${i}/:id/items/:item`,
      { params: t.object({ id: t.int(), item: t.int() }), response: { 200: t.object({ id: t.int(), item: t.int() }) } },
      ({ params }) => ({ id: params.id, item: params.item }),
    );
  }
  return a;
};

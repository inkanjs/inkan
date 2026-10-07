import { problem, routes, t } from "@vxnsin/inkan";
import { Kind, NewTea, Tea, TeaChange } from "./schemas.ts";
import { store } from "./store.ts";

// 1. A group of routes. It knows nothing about where it is mounted: app.ts puts it at /teas.
export const teas = routes();

// 2. One problem() helper, so every route says "not found" the same way.
//    Clients switch on `type`, people read `detail`.
const notFound = (id: number) => problem(404, "tea-not-found", `There is no tea with id ${id}`);

// 3. A contract piece used by several routes.
const byId = t.object({ id: t.int().min(1) });

teas.get(
  "/",
  {
    summary: "List teas",
    tags: ["teas"],
    // 4. Query strings arrive as text. The schema makes `inStock` a boolean and `limit` a number,
    //    and fills in `limit` when it is missing.
    query: t.object({
      kind: Kind.optional(),
      inStock: t.boolean().optional().describe("Only what can ship today"),
      limit: t.int().min(1).max(100).default(20),
    }),
    response: { 200: t.array(Tea) },
    examples: [
      { name: "everything", expect: [{ name: "Sencha" }, { name: "Earl Grey" }, { name: "Tie Guan Yin" }] },
      { name: "only green", query: { kind: "green" }, expect: [{ name: "Sencha" }] },
      { name: "what ships today", query: { inStock: true, limit: 1 }, expect: [{ name: "Sencha" }] },
      { name: "a kind that does not exist", query: { kind: "coffee" }, status: 400 },
    ],
  },
  ({ query }) =>
    store
      .all()
      .filter((x) => !query.kind || x.kind === query.kind)
      .filter((x) => query.inStock === undefined || x.inStock === query.inStock)
      .slice(0, query.limit),
);

teas.get(
  "/:id",
  {
    summary: "Get one tea",
    tags: ["teas"],
    params: byId,
    response: { 200: Tea, 404: t.problem() },
    examples: [
      { name: "found", params: { id: 1 }, expect: { name: "Sencha" } },
      { name: "missing", params: { id: 99 }, status: 404 },
      { name: "not a number", params: { id: "abc" }, status: 400 },
    ],
  },
  ({ params }) => {
    const tea = store.find(params.id);
    if (!tea) throw notFound(params.id);
    return tea;
  },
);

teas.post(
  "/",
  {
    summary: "Add a tea",
    tags: ["teas"],
    body: NewTea,
    // 5. 201 is the first 2xx in the contract, so it is the default status of this route.
    response: { 201: Tea, 409: t.problem() },
    examples: [
      {
        name: "a new oolong",
        body: { name: "Da Hong Pao", kind: "oolong", grams: 50, price: 14, inStock: true },
        expect: { id: 4, name: "Da Hong Pao" },
      },
      { name: "a name that is taken", body: { name: "sencha", kind: "green", grams: 50, price: 5, inStock: true }, status: 409 },
      { name: "a price below zero", body: { name: "Free tea", kind: "green", grams: 10, price: -1, inStock: true }, status: 400 },
    ],
  },
  ({ body, reply }) => {
    if (store.byName(body.name)) throw problem(409, "name-taken", `There is already a tea called ${body.name}`);
    const tea = store.add(body);
    // 6. reply() for a status or headers of your own. It is typed: reply(418, ...) would not compile.
    return reply(201, tea, { location: `/teas/${tea.id}` });
  },
);

teas.patch(
  "/:id",
  {
    summary: "Change a tea",
    tags: ["teas"],
    params: byId,
    body: TeaChange,
    response: { 200: Tea, 404: t.problem() },
    examples: [
      { name: "a new price", params: { id: 2 }, body: { price: 6.5 }, expect: { name: "Earl Grey", price: 6.5 } },
      { name: "missing", params: { id: 99 }, body: { price: 1 }, status: 404 },
    ],
  },
  ({ params, body }) => {
    const tea = store.change(params.id, body);
    if (!tea) throw notFound(params.id);
    return tea;
  },
);

teas.delete(
  "/:id",
  {
    summary: "Remove a tea",
    tags: ["teas"],
    params: byId,
    // 7. No body means 204. t.empty() says so in the contract.
    response: { 204: t.empty(), 404: t.problem() },
    examples: [
      { name: "removes it", params: { id: 3 }, status: 204 },
      { name: "already gone", params: { id: 99 }, status: 404 },
    ],
  },
  ({ params }) => {
    if (!store.remove(params.id)) throw notFound(params.id);
  },
);

import { inkan, problem, routes, t } from "@vxnsin/inkan";
import { authenticate, requireRole, userOf } from "./auth.ts";

export const app = inkan({ title: "Notes", version: "1.0.0", description: "Notes behind a token. Try demo-reader and demo-admin." });

const Note = t.object({ id: t.int(), text: t.string(), by: t.string() }).named("Note");
const User = t.object({ name: t.string(), role: t.enum(["reader", "admin"]) }).named("User");

let notes: { id: number; text: string; by: string }[] = [];
export const beforeEach = () => {
  notes = [
    { id: 1, text: "Buy more sencha", by: "Mio" },
    { id: 2, text: "Water at 75 °C, not boiling", by: "Rin" },
  ];
};
beforeEach();

// 1. Open to everybody: no middleware.
app.get(
  "/status",
  { summary: "Open to everybody", response: { 200: t.object({ ok: t.boolean() }) }, examples: [{ name: "up" }] },
  () => ({ ok: true }),
);

// 2. A group where every route needs a token: the middleware is added to the group.
//    Example headers are sent like any other part of the example.
const reader = { authorization: "Bearer demo-reader" };
const admin = { authorization: "Bearer demo-admin" };
const signedIn = routes().use(authenticate);

signedIn.get(
  "/me",
  {
    summary: "Who am I?",
    tags: ["signed in"],
    // 3. The 401 is part of the contract like any other answer, with its own examples.
    response: { 200: User, 401: t.problem() },
    examples: [
      { name: "as a reader", headers: reader, expect: { name: "Rin", role: "reader" } },
      { name: "without a token", status: 401 },
      { name: "with a wrong token", headers: { authorization: "Bearer nope" }, status: 401 },
    ],
  },
  (ctx) => userOf(ctx),
);

signedIn.get(
  "/notes",
  {
    summary: "Read every note",
    tags: ["signed in"],
    response: { 200: t.array(Note), 401: t.problem() },
    examples: [
      { name: "a reader may read", headers: reader, expect: [{ id: 1 }, { id: 2 }] },
      { name: "nobody may not", status: 401 },
    ],
  },
  () => notes,
);

signedIn.delete(
  "/notes/:id",
  {
    summary: "Remove a note",
    tags: ["signed in"],
    params: t.object({ id: t.int() }),
    // 4. Middleware for this one route, after the group's: only admins get here.
    use: [requireRole("admin")],
    response: { 204: t.empty(), 401: t.problem(), 403: t.problem(), 404: t.problem() },
    examples: [
      { name: "an admin may", headers: admin, params: { id: 1 }, status: 204 },
      { name: "a reader may not", headers: reader, params: { id: 1 }, status: 403 },
      { name: "nobody may not", params: { id: 1 }, status: 401 },
      { name: "already gone", headers: admin, params: { id: 99 }, status: 404 },
    ],
  },
  ({ params }) => {
    const before = notes.length;
    notes = notes.filter((n) => n.id !== params.id);
    if (notes.length === before) throw problem(404, "note-not-found", `There is no note ${params.id}`);
  },
);

app.mount("/", signedIn);
app.listen();

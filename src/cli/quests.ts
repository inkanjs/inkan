// The quests of `inkan learn`, in order. Each one teaches one idea, asks for one change to
// the practice app, and checks it the way a user of the API would see it: through inject,
// no port needed. A check answers true, or what is still missing, in a sentence.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../core/app.ts";
import { diffOpenAPI } from "../openapi/diff.ts";

export type QuestContext = {
  app: App;
  /** The practice folder. */
  dir: string;
  /** What the running practice server saw: a request sent from the docs page. */
  seen: { fromDocs: boolean };
  /** Where the practice server listens, for quests that send you there. */
  url: string;
};

export type Quest = {
  title: string;
  /** The idea, in a few lines. */
  teach: string;
  /** What to do. */
  task: string;
  /** From a nudge to the answer. `{url}` is where the practice app runs. */
  hints: string[];
  check(c: QuestContext): Promise<true | string>;
};

const has = (o: unknown, key: string, value: unknown) => JSON.stringify((o as Record<string, unknown> | undefined)?.[key]) === JSON.stringify(value);
const said = (r: { status: number; text: string }) => `${r.status} ${r.text.length > 120 ? r.text.slice(0, 120) + "…" : r.text}`;

export const QUESTS: Quest[] = [
  {
    title: "a first route",
    teach: "A route is a method, a path and a handler. What the handler returns goes out as JSON.",
    task: 'Add GET /hello that answers { "hello": "world" }.',
    hints: ["app.get(path, handler), and the handler returns an object.", 'app.get("/hello", () => ({ hello: "world" }));'],
    async check({ app }) {
      const r = await app.inject({ url: "/hello" });
      if (r.status === 404) return "GET /hello is not there yet";
      if (!has(r.body, "hello", "world")) return `GET /hello answered ${said(r)}, not { "hello": "world" }`;
      return true;
    },
  },
  {
    title: "typed params",
    teach:
      "A contract says what a route takes. With a params schema, inkan turns :id into a number\nbefore your handler runs, and answers 400 for anything that is not one.",
    task: "Add GET /teas/:id that answers the tea with that id, with id as a number (t.int()).",
    hints: [
      "Give the route a contract: { params: t.object({ id: t.int() }) }. Then params.id is a number.",
      'app.get("/teas/:id", { params: t.object({ id: t.int() }) }, ({ params }) => teas.find((tea) => tea.id === params.id));',
    ],
    async check({ app }) {
      const r = await app.inject({ url: "/teas/2" });
      if (r.status === 404 && r.body?.type === "not-found") return "GET /teas/:id is not there yet";
      if (r.body?.name !== "Gyokuro") return `GET /teas/2 answered ${said(r)}, not the tea with id 2 (Gyokuro)`;
      const bad = await app.inject({ url: "/teas/abc" });
      if (bad.status !== 400) return `GET /teas/abc answered ${bad.status}; with id as t.int() it would be a 400`;
      return true;
    },
  },
  {
    title: "rules for a body",
    teach: "A body schema is checked before your handler runs. A body that breaks it never reaches you:\nthe caller gets a 400 that says which field and why.",
    task: "Add POST /teas that takes { name, grams }: name at least 1 character, grams a whole number of at least 1.\nIt adds the tea and answers it with 201.",
    hints: [
      "body: t.object({ name: t.string().min(1), grams: t.int().min(1) }), and response: { 201: … } makes 201 the status.",
      'app.post("/teas", { body: t.object({ name: t.string().min(1), grams: t.int().min(1) }), response: { 201: t.object({ id: t.int(), name: t.string(), grams: t.int() }) } },\n  ({ body }) => { const tea = { id: teas.length + 1, ...body }; teas.push(tea); return tea; });',
    ],
    async check({ app }) {
      const ok = await app.inject({ method: "POST", url: "/teas", body: { name: "Matcha", grams: 20 } });
      if (ok.status === 404 || ok.status === 405) return "POST /teas is not there yet";
      if (ok.status !== 201 || ok.body?.name !== "Matcha") return `POST /teas with { name: "Matcha", grams: 20 } answered ${said(ok)}, not 201 with the tea`;
      const grams = await app.inject({ method: "POST", url: "/teas", body: { name: "Matcha", grams: -5 } });
      if (grams.status !== 400) return `POST /teas with { grams: -5 } answered ${grams.status}: it got in. Give grams a .min(1)`;
      const name = await app.inject({ method: "POST", url: "/teas", body: { name: "", grams: 5 } });
      if (name.status !== 400) return `POST /teas with { name: "" } answered ${name.status}: it got in. Give name a .min(1)`;
      return true;
    },
  },
  {
    title: "examples are tests",
    teach:
      "An example on a route is documentation and a test at once: the docs page shows it with a send\nbutton, and `inkan check` runs it in CI. If it ever stops answering as it says, check fails.",
    task: "Give POST /teas an example, and make sure every example in the app passes.",
    hints: [
      'In the contract: examples: [{ name: "a new tea", body: { name: "Bancha", grams: 40 } }]',
      'app.post("/teas", { body: …, response: …, examples: [{ name: "a new tea", body: { name: "Bancha", grams: 40 } }] }, …)',
    ],
    async check({ app }) {
      const route = app.routes().find((r) => r.method === "POST" && r.path === "/teas");
      if (!route?.spec.examples?.length) return "POST /teas has no examples yet";
      const report = await app.check();
      const broken = report.results.filter((r) => !r.ok);
      if (broken.length) return `${broken.length} example${broken.length === 1 ? " does" : "s do"} not answer as promised: ${broken[0].method} ${broken[0].path} · ${broken[0].example}, ${broken[0].problems[0] ?? ""}`;
      return true;
    },
  },
  {
    title: "problems",
    teach:
      'Every error in inkan has one shape (RFC 9457): a status, a stable "type" to switch on, and a\nsentence for people. throw problem(…) wherever you are, and that is the answer.',
    task: 'Make GET /teas/:id answer 404 with the type "tea-not-found" for a tea that does not exist.',
    hints: [
      'Look the tea up; when there is none, throw problem(404, "tea-not-found", "…").',
      'const tea = teas.find((tea) => tea.id === params.id);\nif (!tea) throw problem(404, "tea-not-found", `There is no tea ${params.id}`);\nreturn tea;',
    ],
    async check({ app }) {
      const r = await app.inject({ url: "/teas/999" });
      if (r.status !== 404) return `GET /teas/999 answered ${said(r)}, not a 404`;
      if (r.body?.type !== "tea-not-found") return `GET /teas/999 is a 404 of the type "${r.body?.type}", not "tea-not-found"`;
      return true;
    },
  },
  {
    title: "groups",
    teach: "routes() makes a group of routes that can be mounted under a prefix. Big apps are a few groups.",
    task: 'Make a group with GET /stats that answers { "teas": <how many> }, and mount it under /admin.',
    hints: [
      'import { routes } as well; const admin = routes().get("/stats", …); then app.mount("/admin", admin).',
      'const admin = routes().get("/stats", () => ({ teas: teas.length }));\napp.mount("/admin", admin);',
    ],
    async check({ app }) {
      const r = await app.inject({ url: "/admin/stats" });
      if (r.status === 404) return "GET /admin/stats is not there yet";
      if (r.status === 401) return true; // already locked: the next quest is done too, which is fine
      if (typeof r.body?.teas !== "number") return `GET /admin/stats answered ${said(r)}, not { "teas": <a number> }`;
      return true;
    },
  },
  {
    title: "who may call it",
    teach:
      'security: "bearer" on a route (or .security("bearer") on a group) makes inkan refuse a request\nwithout a token with a 401, before anything else runs. Whether the token is good stays yours.',
    task: "Let only callers with a bearer token see /admin/stats.",
    hints: ['routes().security("bearer").get("/stats", …), or { security: "bearer" } in the route\'s contract.', 'const admin = routes().security("bearer").get("/stats", () => ({ teas: teas.length }));'],
    async check({ app }) {
      const none = await app.inject({ url: "/admin/stats" });
      if (none.status !== 401) return `GET /admin/stats without a token answered ${none.status}, not 401`;
      const token = await app.inject({ url: "/admin/stats", headers: { authorization: "Bearer letmein" } });
      if (token.status !== 200) return `GET /admin/stats with a bearer token answered ${said(token)}, not 200`;
      return true;
    },
  },
  {
    title: "hooks",
    teach: "Hooks run at fixed points of every request. onSend sees every answer before it goes out,\nproblems too, and may change it.",
    task: "Make every answer carry the header x-tea: yes, a 404 too.",
    hints: ["app.onSend((ctx, answer) => { … }): answer.headers is yours to change.", 'app.onSend((ctx, answer) => { answer.headers["x-tea"] = "yes"; });'],
    async check({ app }) {
      for (const url of ["/teas", "/nowhere/at/all"]) {
        const r = await app.inject({ url });
        if (r.headers["x-tea"] !== "yes") return `GET ${url} (${r.status}) has no x-tea: yes header`;
      }
      return true;
    },
  },
  {
    title: "the docs page",
    teach: "inkan serves docs for your API at /docs, built from the contracts, with a send button on every\nexample. In development /_inkan shows every request that came in.",
    task: "Open the docs page of your practice app and press send on an example.",
    hints: ["The practice app is running: open {url}/docs in a browser.", "Find POST /teas, the example you wrote, and press send."],
    async check({ seen }) {
      return seen.fromDocs ? true : "No request from the docs page yet";
    },
  },
  {
    title: "changes that break clients",
    teach:
      "`inkan diff` compares the OpenAPI document of your last release with the app now, and names\nevery change that would break a client written against it. CI can fail on those.",
    task: "Press o to save the OpenAPI document as openapi.json. Then change a contract so that an old\nclient breaks: make a field required that was not, or a rule stricter.",
    hints: ["After pressing o, make POST /teas ask for grams of at least 10 instead of 1.", "grams: t.int().min(10): every client that sends 5 now gets a 400, so that breaks them."],
    async check({ app, dir }) {
      const file = join(dir, "openapi.json");
      if (!existsSync(file)) return "There is no openapi.json yet: press o";
      const breaking = diffOpenAPI(JSON.parse(readFileSync(file, "utf8")), app.openapi()).filter((c) => c.breaking);
      if (!breaking.length) return "Nothing that would break a client has changed since openapi.json was saved";
      return true;
    },
  },
  {
    title: "the seal",
    teach:
      "`inkan seal` stamps every contract into plain code of its own, ahead of time. Big bodies and\nbig answers take about half the time, and a contract that changed since is never checked by\nthe old code.",
    task: "Press w to write src/inkan.seal.js, then give it to the app: inkan({ title: …, seal }).",
    hints: ['import seal from "./inkan.seal.js"; at the top of src/app.ts.', 'export const app = inkan({ title: "Tea Shop", seal });'],
    async check({ app }) {
      const state = app.sealed();
      if (!state) return "The app runs without a seal: pass it as inkan({ seal })";
      if (state.stale.length) return `${state.stale.length} contract(s) changed since the seal was written: press w again, then restart inkan learn`;
      if (!state.sealed) return "The seal holds none of the app's contracts: press w again";
      return true;
    },
  },
  {
    title: "plugins",
    teach: "A plugin is a function that gets a scope of its own: its routes, hooks and decorations stay\nthere, under the prefix it is registered with.",
    task: 'Write a plugin that adds GET /ping answering { "pong": true }, and register it under /v2.',
    hints: [
      'import { plugin } as well; const v2 = plugin((app) => { app.get(…) }); app.register(v2, { prefix: "/v2" });',
      'const v2 = plugin((app) => { app.get("/ping", () => ({ pong: true })); });\napp.register(v2, { prefix: "/v2" });',
    ],
    async check({ app }) {
      const r = await app.inject({ url: "/v2/ping" });
      if (r.status === 404) return "GET /v2/ping is not there yet";
      if (!has(r.body, "pong", true)) return `GET /v2/ping answered ${said(r)}, not { "pong": true }`;
      if ((await app.inject({ url: "/ping" })).status !== 404) return 'GET /ping answers too: register the plugin with { prefix: "/v2" }';
      return true;
    },
  },
];

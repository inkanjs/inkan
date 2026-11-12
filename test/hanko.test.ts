import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { card, find, loadCatalog, runHanko, type Plugin } from "../src/cli/hanko.ts";

const kinds = [
  { kind: "built-in", label: "built-in", note: "In the core." },
  { kind: "middleware", label: "middleware", note: "Official packages." },
  { kind: "store", label: "stores", note: "One Store." },
];
const plugins: Plugin[] = [
  { name: "cors", description: "Lets pages on other origins call the API.", kind: "built-in", href: "https://x/docs/cors", code: `import { cors } from "@inkanjs/inkan"`, tags: ["headers", "browser"] },
  { name: "@inkanjs/session", description: "Cookie sessions without dependencies.", kind: "middleware", href: "https://x/docs/session", npm: "@inkanjs/session", tags: ["cookies"], version: "0.2.1", weekly: 1234 },
  { name: "@inkanjs/redis", description: "A Redis store: sessions, jobs and rate limits.", kind: "store", href: "https://x/docs/redis", npm: "@inkanjs/redis", tags: ["store", "sessions"] },
];
const site = { kinds, plugins };

const fetcher = (answers: Record<string, unknown>) => async (url: string) => {
  const key = Object.keys(answers).find((k) => url.includes(k));
  if (!key) throw new Error("offline");
  return { ok: true, json: async () => answers[key] };
};

test("find: every word has to match, the name counts most, a kind narrows", () => {
  assert.deepEqual(find(plugins, "session").map((p) => p.name), ["@inkanjs/session", "@inkanjs/redis"]);
  assert.deepEqual(find(plugins, "redis sessions").map((p) => p.name), ["@inkanjs/redis"]);
  assert.deepEqual(find(plugins, "session", "store").map((p) => p.name), ["@inkanjs/redis"]);
  assert.equal(find(plugins, "").length, 3);
  assert.equal(find(plugins, "graphql").length, 0);
});

test("loadCatalog: inkan.dev first, npm when the site is gone, nothing when both are", async () => {
  const fromSite = await loadCatalog(fetcher({ "hanko.json": site }), "https://site/hanko.json");
  assert.equal(fromSite?.source, "inkan.dev");
  assert.equal(fromSite?.plugins.length, 3);

  const npm = {
    objects: [
      { package: { name: "@inkanjs/auth", description: "Logins.", keywords: ["inkan", "auth"] } },
      { package: { name: "@inkanjs/inkan", keywords: ["inkan"] } },
      { package: { name: "inkan-quota", description: "Quotas.", keywords: ["inkan-plugin", "quota"] } },
      { package: { name: "inkan-standard", keywords: ["inkan"] } },
    ],
  };
  const fromNpm = await loadCatalog(fetcher({ "registry.npmjs.org": npm }), "https://site/hanko.json");
  assert.equal(fromNpm?.source, "npm");
  assert.deepEqual(fromNpm?.plugins.map((p) => `${p.name}:${p.kind}`), ["@inkanjs/auth:official", "inkan-quota:community"]);
  assert.deepEqual(fromNpm?.plugins[1]?.tags, ["quota"]);

  assert.equal(await loadCatalog(fetcher({}), "https://site/hanko.json"), undefined);
});

test("card: the facts, the install line for the package manager, the code for a built-in", () => {
  const session = card(plugins[1]!, kinds, false, "pnpm");
  assert.match(session, /@inkanjs\/session {2}middleware {2}· {2}v0\.2\.1 · 1\.2k\/week/);
  assert.match(session, /│ pnpm add @inkanjs\/session/);
  assert.match(session, /#cookies/);
  const cors = card(plugins[0]!, kinds, false);
  assert.match(cors, /│ import \{ cors \} from "@inkanjs\/inkan"/);
  assert.doesNotMatch(cors, /npm install/);
});

async function capture(fn: () => Promise<number>) {
  const log = console.log;
  let out = "";
  console.log = (...a: unknown[]) => void (out += a.join(" ") + "\n");
  try {
    return { code: await fn(), out };
  } finally {
    console.log = log;
  }
}
const fail = (msg: string): never => {
  throw new Error(msg);
};

test("runHanko without a terminal: grouped by kind, --json, --kind, and the mistakes", async () => {
  const ctx = { color: false, fail, tty: false, fetch: fetcher({ "hanko.json": site }) };
  const listed = await capture(() => runHanko(["session"], ctx));
  assert.equal(listed.code, 0);
  assert.match(listed.out, /middleware \(1\)\n {2}│ @inkanjs\/session +Cookie sessions/);
  assert.match(listed.out, /stores \(1\)\n {2}│ @inkanjs\/redis/);

  const json = await capture(() => runHanko(["--json", "--kind=store"], ctx));
  assert.deepEqual(JSON.parse(json.out).map((p: Plugin) => p.name), ["@inkanjs/redis"]);

  assert.equal((await capture(() => runHanko(["graphql"], ctx))).code, 1);
  await assert.rejects(runHanko(["--kind", "nope"], ctx), /--kind takes one of built-in, middleware, store, not "nope"/);
  await assert.rejects(runHanko(["--wat"], ctx), /There is no option --wat/);
  await assert.rejects(runHanko([], { ...ctx, fetch: fetcher({}) }), /Neither inkan.dev nor npm answered/);
});

test("runHanko in a terminal: a kind, a search as you type, the card, done", async () => {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(on: boolean) { input.isRaw = on; } });
  let screen = "";
  const io = { input, output: { write: (s: string) => (screen += s), columns: 120 }, color: false };
  // middleware, then "sess", pick it, then "done" (there is no install outside a project)
  const keys = ["\x1b[B", "\x1b[B", "\r", ..."sess", "\r", "\x1b[B", "\r"];
  const typing = (async () => {
    for (const k of keys) {
      await new Promise((r) => setTimeout(r, 2));
      input.write(k);
    }
  })();
  const run = await capture(() => runHanko([], { color: false, fail, tty: true, io, cwd: "/nowhere", fetch: fetcher({ "hanko.json": site }) }));
  await typing;
  assert.equal(run.code, 0);
  const plain = screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  assert.match(plain, /✔ what are you looking for\? · middleware/);
  assert.match(plain, /✔ search · @inkanjs\/session/);
  assert.match(plain, /✔ and now\? · done/);
  assert.match(run.out, /install @inkanjs\/session/);
  assert.doesNotMatch(plain, /❯ install/);
});

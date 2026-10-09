// The schema alone: nanoseconds per call of the checks and the writer's fit test that the
// request path uses, on the bench's own data; the lowest of a few repeats. For changes to
// src/schema; not a comparison with other validators.
//
//   node bench/schema.mjs                      this inkan
//   node bench/schema.mjs inkan,inkan-base 5   against the inkan at $INKAN_BASE, 5 rounds

import { BULK, LIST } from "./data.mjs";

const N = Number(process.env.N ?? 200000);
const REPEATS = 7;

function cases(t) {
  const Item = t.object({
    id: t.int(),
    name: t.string(),
    tags: t.array(t.string()),
    price: t.number(),
    inStock: t.boolean(),
    meta: t.object({ created: t.string(), updated: t.string() }),
  });
  const NewTea = t.object({ name: t.string().min(1), kind: t.enum(["green", "black", "oolong"]), grams: t.int().min(1), price: t.number().min(0) });
  const Bulk = t.object({ items: t.array(NewTea).max(500) });
  const User = t.object({ name: t.string().min(1), age: t.int() });
  const Hello = t.object({ hello: t.string() });
  const List = t.array(Item);
  const bulk = JSON.parse(BULK);
  const bad = { name: "", age: "x" };
  const into = (s, v) => () => {
    const issues = [];
    return s._into(v, false, issues);
  };
  return [
    ["_into bulk body (50)", into(Bulk, bulk), 0.02],
    ["_into small body", into(User, { name: "Mio", age: 3 }), 1],
    ["_into 400 body", into(User, bad), 0.5],
    ["_into params {id}, coerced", ((s) => () => s._into({ id: "9" }, true, []))(t.object({ id: t.int() })), 1],
    ["fits {hello}", ((f) => () => f({ hello: "world" }))(Hello._fitter()), 1], // a new answer each time, as a handler makes it
    ["fits big answer (100)", ((f, v) => () => f(v))(List._fitter(), LIST), 0.01],
    ["write big answer (100)", ((f, v) => () => f(v))(List._serializer(), LIST), 0.005],
  ];
}

function time(fn, n) {
  let sink;
  for (let i = 0; i < Math.max(1000, n / 4); i++) sink = fn();
  const runs = [];
  for (let r = 0; r < REPEATS; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) sink = fn();
    runs.push(Number(process.hrtime.bigint() - t0) / n);
  }
  globalThis.__sink = sink;
  return Math.min(...runs); // noise only adds time
}

if (process.env.SIDE) {
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const root = process.env.SIDE === "inkan-base" ? process.env.INKAN_BASE ?? "" : join(import.meta.dirname, "..");
  const { t } = await import(pathToFileURL(join(root, "src/index.ts")).href);
  const out = {};
  for (const [name, fn, share] of cases(t)) out[name] = time(fn, Math.max(1000, Math.round(N * share)));
  console.log(JSON.stringify(out));
} else {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const sides = (process.argv[2] ?? "inkan").split(",");
  const rounds = Number(process.argv[3] ?? (sides.length > 1 ? 3 : 1));
  const run = (side) => JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, SIDE: side } }).toString());
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const span = (xs, d = 0) => `${Math.min(...xs).toFixed(d)}–${Math.max(...xs).toFixed(d)}`;
  const got = Object.fromEntries(sides.map((s) => [s, []]));
  for (let r = 0; r < rounds; r++) for (const side of r % 2 ? [...sides].reverse() : sides) got[side].push(run(side));
  const others = sides.slice(1);
  const names = Object.keys(got[sides[0]][0]);
  const lines = [
    `### ns per call, median of ${rounds} rounds (spread)`,
    "",
    `| | ${[...sides, ...others.map((s) => `${sides[0]}/${s} × 100`)].join(" | ")} |`,
    `| --- |${" ---: |".repeat(sides.length + others.length)}`,
  ];
  for (const name of names) {
    const cells = sides.map((s) => {
      const xs = got[s].map((g) => g[name]);
      return `${median(xs).toFixed(0)} (${span(xs)})`;
    });
    const ratios = others.map((s) => {
      const xs = got[s].map((g, i) => (got[sides[0]][i][name] / g[name]) * 100);
      return `${median(xs).toFixed(1)} (${span(xs, 1)})`;
    });
    lines.push(`| ${name} | ${[...cells, ...ratios].join(" | ")} |`);
  }
  console.log(lines.join("\n"));
}

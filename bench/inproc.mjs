// inkan alone, without a network: microseconds per request through routing,
// validation and the answer, for every scenario of the HTTP bench. For comparing inkan
// before and after a change on any machine. It does not compare frameworks: other
// frameworks' inject() do different work.
//
//   node bench/inproc.mjs                      this inkan
//   node bench/inproc.mjs inkan,inkan-base 5   against the inkan at $INKAN_BASE, 5 rounds
//   MODE=dev node bench/inproc.mjs             the same in dev mode
//   ONLY="hello,404" node bench/inproc.mjs     some scenarios only
//
// Every scenario runs in a process of its own, a round each: what one scenario leaves in
// the JIT changes the next. With two sides both live in that one process, each with its own
// code, and take turns in short batches, so a busy moment on the machine slows both alike.
// The table shows the median of the rounds and their spread, and the first side as a share
// of the second, batch by batch (lower is faster).

import { BULK } from "./data.mjs";

const json = { "content-type": "application/json" };
const cases = [
  { name: "hello", req: { method: "GET", url: "/hello" } },
  { name: "params+query", req: { method: "GET", url: "/users/42?fields=name" } },
  { name: "small body", req: { method: "POST", url: "/users", headers: json, body: '{"name":"Mio","age":3}' } },
  { name: "bulk body (50)", req: { method: "POST", url: "/teas/bulk", headers: json, body: BULK }, n: 0.1 },
  { name: "big answer", req: { method: "GET", url: "/teas" }, n: 0.05 },
  { name: "router 400", req: { method: "GET", url: "/p199/42/items/7" } },
  { name: "3 middlewares", req: { method: "GET", url: "/mw" } },
  { name: "async", req: { method: "GET", url: "/async/9" }, n: 0.5 },
  { name: "404", req: { method: "GET", url: "/nowhere/at/all" } },
  { name: "400", req: { method: "POST", url: "/users", headers: json, body: '{"name":"","age":"x"}' } },
];
const N = Number(process.env.N ?? 40000);
const BATCHES = 20;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function batch(target, req, n) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) await target.inject(req);
  return Number(process.hrtime.bigint() - t0) / n / 1000;
}

if (process.env.CASE) {
  // one scenario, every side, in this process: prints a JSON line { side: [µs per batch] }
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const sides = process.env.SIDES.split(",");
  const c = cases.find((x) => x.name === process.env.CASE);
  const n = Math.max(100, Math.round((N * (c.n ?? 1)) / BATCHES));
  const targets = [];
  for (const side of sides) {
    const from = side === "inkan-base" ? pathToFileURL(join(process.env.INKAN_BASE ?? "", "bench/inkan-app.mjs")).href : "./inkan-app.mjs";
    targets.push((await import(from)).app(process.env.MODE === "dev"));
  }
  for (const t of targets) await batch(t, c.req, Math.max(2000, n * 5)); // let the JIT settle
  const out = sides.map(() => []);
  for (let b = 0; b < BATCHES; b++) {
    const order = b % 2 ? targets.map((_, i) => i).reverse() : targets.map((_, i) => i);
    for (const i of order) out[i].push(await batch(targets[i], c.req, n));
  }
  console.log(JSON.stringify(Object.fromEntries(sides.map((s, i) => [s, out[i]]))));
} else {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const sides = (process.argv[2] ?? "inkan").split(",");
  const rounds = Number(process.argv[3] ?? 3);
  const only = process.env.ONLY?.split(",");
  const span = (xs, d = 2) => `${Math.min(...xs).toFixed(d)}–${Math.max(...xs).toFixed(d)}`;
  const rows = [];
  const logs = [];
  for (const c of cases.filter((x) => !only || only.includes(x.name))) {
    const us = sides.map(() => []); // per side: the round's lowest batch
    const ratios = []; // per round: the median of first ÷ second, batch by batch
    for (let r = 0; r < rounds; r++) {
      const order = r % 2 ? [...sides].reverse() : sides;
      const got = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, SIDES: order.join(","), CASE: c.name } }).toString());
      sides.forEach((s, i) => us[i].push(Math.min(...got[s])));
      if (sides.length > 1) ratios.push(median(got[sides[0]].map((x, i) => (x / got[sides[1]][i]) * 100)));
      process.stderr.write(`${c.name} round ${r + 1}/${rounds}\n`);
    }
    const cells = us.map((xs) => `${median(xs).toFixed(2)} (${span(xs)})`);
    if (ratios.length) {
      logs.push(Math.log(median(ratios) / 100));
      cells.push(`${median(ratios).toFixed(1)} (${span(ratios, 1)})`);
    }
    rows.push(`| ${c.name} | ${cells.join(" | ")} |`);
  }
  const ratio = sides.length > 1 ? [`${sides[0]}/${sides[1]} × 100`] : [];
  const lines = [
    `### ${process.env.MODE ?? "prod"}, µs per request (lowest batch), median of ${rounds} rounds (spread)`,
    "",
    `| scenario | ${[...sides, ...ratio].join(" | ")} |`,
    `| --- |${" ---: |".repeat(sides.length + ratio.length)}`,
    ...rows,
  ];
  if (logs.length) lines.push(`| **geomean** | ${sides.map(() => "").join(" | ")} | **${(Math.exp(logs.reduce((a, b) => a + b, 0) / logs.length) * 100).toFixed(1)}** |`);
  console.log(lines.join("\n"));
}

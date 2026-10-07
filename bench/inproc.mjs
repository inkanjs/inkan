// inkan alone, without a network: microseconds per request through routing,
// validation and the answer. For comparing inkan before and after a change on any
// machine. It does not compare frameworks: other frameworks' inject() do different work.
//
//   node bench/inproc.mjs

import { app } from "./inkan-app.mjs";

const cases = [
  { name: "hello", req: { method: "GET", url: "/hello" } },
  { name: "params+query", req: { method: "GET", url: "/users/42?fields=name" } },
  { name: "POST body", req: { method: "POST", url: "/users", headers: { "content-type": "application/json" }, body: '{"name":"Mio","age":3}' } },
];
const N = Number(process.env.N ?? 40000);
const ROUNDS = 5;

async function perRequest(target, req) {
  for (let i = 0; i < 5000; i++) await target.inject(req); // let the JIT settle
  const runs = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) await target.inject(req);
    runs.push(Number(process.hrtime.bigint() - t0) / N / 1000);
  }
  return runs.sort((a, b) => a - b)[Math.floor(ROUNDS / 2)]; // the median
}

// Each mode in a process of its own: measured one after the other in one process, the
// second one inherits the first one's optimised code and looks several times slower.
if (!process.env.MODE) {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  for (const mode of ["prod", "dev"]) {
    process.stdout.write(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, MODE: mode } }));
  }
} else {
  const dev = process.env.MODE === "dev";
  const target = app(dev);
  const line = [];
  for (const c of cases) line.push(`${c.name} ${(await perRequest(target, c.req)).toFixed(2)}µs`);
  console.log(`${dev ? "dev " : "prod"}  ${line.join("   ")}`);
}

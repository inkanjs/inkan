// Every server, every scenario, a few rounds; the median of each.
//
// Before a server is measured on a scenario it has to give the right answer, so nobody
// wins by doing less. Prints Markdown tables (throughput, p99 latency, peak memory and an
// overall score) and adds them to the GitHub Actions job summary when there is one.
//
//   cd bench && npm install && node run.mjs [servers] [seconds] [rounds]
//   node run.mjs node,fastify,hono,inkan,express 15 3

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import autocannon from "autocannon";
import { BULK } from "./data.mjs";

const servers = (process.argv[2] ?? "node,fastify,hono,inkan,express").split(",");
const seconds = Number(process.argv[3] ?? 15);
const rounds = Number(process.argv[4] ?? 3);
const warmup = 3;
// Leave the server a core of its own; the load comes from the others.
const workers = Math.max(1, Math.min(4, availableParallelism() - 1));
const json = { "content-type": "application/json" };

const scenarios = [
  { name: "hello · 10 connections", path: "/hello", connections: 10, status: 200 },
  { name: "hello · 100 connections", path: "/hello", status: 200 },
  { name: "hello · 512 connections", path: "/hello", connections: 512, status: 200 },
  { name: "params + query", path: "/users/42?fields=name", status: 200, check: (b) => b.id === 42 && b.fields === "name" },
  { name: "small JSON body", path: "/users", method: "POST", headers: json, body: '{"name":"Mio","age":3}', status: 201, check: (b) => b.name === "Mio" },
  { name: "big JSON body (50 items)", path: "/teas/bulk", method: "POST", headers: json, body: BULK, status: 201, check: (b) => b.count === 50 },
  { name: "big answer (100 items)", path: "/teas", status: 200, check: (b) => b.length === 100 && b[99].meta.updated },
  { name: "router with 400 routes", path: "/p199/42/items/7", status: 200, check: (b) => b.id === 42 && b.item === 7 },
  { name: "3 middlewares", path: "/mw", status: 200, check: (b) => b.n === 3 },
  { name: "async handler", path: "/async/9", status: 200, check: (b) => b.id === 9 },
  { name: "404", path: "/nowhere/at/all", status: 404 },
  { name: "400 (invalid body)", path: "/users", method: "POST", headers: json, body: '{"name":"","age":"x"}', status: 400 },
];

const cannon = (opts) => new Promise((resolve, reject) => autocannon(opts, (err, res) => (err ? reject(err) : resolve(res))));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function start(name, port) {
  const child = spawn(process.execPath, ["servers.mjs", name, String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => String(d).includes("ready") && resolve());
    child.once("exit", (code) => reject(new Error(`${name} exited with ${code}`)));
  });
  return child;
}

// Linux only: the most memory the process ever held, in MB.
function peakMemory(pid) {
  try {
    const kb = Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))[1]);
    return Math.round(kb / 1024);
  } catch {
    return undefined;
  }
}

async function verify(name, base, s) {
  const res = await fetch(base + s.path, { method: s.method ?? "GET", headers: s.headers, body: s.body });
  const text = await res.text();
  if (res.status !== s.status) throw new Error(`${name} answered ${s.path} with ${res.status}, expected ${s.status}: ${text.slice(0, 200)}`);
  if (s.check && !s.check(JSON.parse(text))) throw new Error(`${name} answered ${s.path} with the wrong body: ${text.slice(0, 200)}`);
}

const results = {}; // scenario -> server -> { rps: [], p99: [] }
const memory = {}; // server -> [MB]
let port = 4800;
for (let round = 0; round < rounds; round++) {
  // a different order every round, so warm-up and thermals do not favour anybody
  const order = round % 2 ? [...servers].reverse() : servers;
  for (const name of order) {
    const p = port++;
    const child = await start(name, p);
    const base = `http://127.0.0.1:${p}`;
    for (const s of scenarios) {
      await verify(name, base, s);
      const opts = { url: base + s.path, method: s.method ?? "GET", headers: s.headers, body: s.body, connections: s.connections ?? 100, workers };
      await cannon({ ...opts, duration: warmup }); // warm the JIT
      const r = await cannon({ ...opts, duration: seconds });
      const codes = Object.keys(r.statusCodeStats ?? {}).map(Number);
      if (r.errors || codes.some((c) => c !== s.status)) {
        throw new Error(`${name} · ${s.name}: ${r.errors} errors, statuses ${JSON.stringify(r.statusCodeStats)}`);
      }
      const cell = ((results[s.name] ??= {})[name] ??= { rps: [], p99: [] });
      cell.rps.push(r.requests.average);
      cell.p99.push(r.latency.p99);
      process.stderr.write(`round ${round + 1}/${rounds}  ${name.padEnd(10)} ${s.name.padEnd(26)} ${Math.round(r.requests.average)} req/s\n`);
    }
    (memory[name] ??= []).push(peakMemory(child.pid));
    child.kill();
  }
}

// ---------- the report ----------

const rps = (s, n) => median(results[s.name][n].rps);
const header = (title) => [`| ${title} | ${servers.join(" | ")} |`, `| --- | ${servers.map(() => "---:").join(" | ")} |`];
const fmt = (x) => Math.round(x).toLocaleString("en");
const base = servers.includes("node") ? "node" : servers[0];

const throughput = header("req/s (median)");
for (const s of scenarios) {
  const best = Math.max(...servers.map((n) => rps(s, n)));
  const cells = servers.map((n) => {
    const text = `${fmt(rps(s, n))}${n === base ? "" : ` (${Math.round((rps(s, n) / rps(s, base)) * 100)} %)`}`;
    return rps(s, n) === best ? `**${text}**` : text;
  });
  throughput.push(`| ${s.name} | ${cells.join(" | ")} |`);
}

const latency = header("p99 latency, ms");
for (const s of scenarios) latency.push(`| ${s.name} | ${servers.map((n) => median(results[s.name][n].p99)).join(" | ")} |`);
latency.push(`| peak memory, MB | ${servers.map((n) => median(memory[n].filter((x) => x !== undefined)) ?? "–").join(" | ")} |`);

// The overall score: the geometric mean over every scenario of the throughput relative to
// the baseline, so no single scenario can carry or sink a server.
const score = (n) => Math.exp(scenarios.reduce((sum, s) => sum + Math.log(rps(s, n) / rps(s, base)), 0) / scenarios.length);
const ranking = [...servers].sort((a, b) => score(b) - score(a));
const overall = [
  `| rank | server | score (geometric mean, ${base} = 100) |`,
  "| ---: | --- | ---: |",
  ...ranking.map((n, i) => `| ${i + 1} | ${i === 0 ? `**${n}**` : n} | ${(score(n) * 100).toFixed(1)} |`),
];

const report = [
  `Node ${process.version} · ${availableParallelism()} cores · ${workers} load workers · ${seconds}s per measurement after ${warmup}s warm-up · ${rounds} rounds, median · every answer checked before it is measured`,
  "",
  "### Overall",
  "",
  ...overall,
  "",
  "### Throughput",
  "",
  ...throughput,
  "",
  "### Latency and memory",
  "",
  ...latency,
].join("\n");
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## inkan bench\n\n${report}\n`);

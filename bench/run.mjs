// Every server, every scenario, a few rounds; the median of each. Prints a
// Markdown table, and adds it to the GitHub Actions job summary when there is one.
//
//   cd bench && npm install && node run.mjs [servers] [seconds] [rounds]
//   node run.mjs node,fastify,inkan 10 3

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import autocannon from "autocannon";

const servers = (process.argv[2] ?? "node,fastify,inkan,inkan-dev,express").split(",");
const seconds = Number(process.argv[3] ?? 10);
const rounds = Number(process.argv[4] ?? 3);
// Leave the server a core of its own; the load comes from the others.
const workers = Math.max(1, Math.min(4, availableParallelism() - 1));

const scenarios = [
  { name: "GET /hello", path: "/hello" },
  { name: "GET /users/:id?fields", path: "/users/42?fields=name" },
  { name: "POST /users (JSON body)", path: "/users", method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"Mio","age":3}' },
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

const results = {}; // scenario -> server -> { rps, p99 }
let port = 4800;
for (let round = 0; round < rounds; round++) {
  // a different order every round, so warm-up and thermals do not favour anybody
  const order = round % 2 ? [...servers].reverse() : servers;
  for (const name of order) {
    const p = port++;
    const child = await start(name, p);
    for (const s of scenarios) {
      const opts = { url: `http://127.0.0.1:${p}${s.path}`, method: s.method ?? "GET", headers: s.headers, body: s.body, connections: 100, workers };
      await cannon({ ...opts, duration: 2 }); // warm the JIT
      const r = await cannon({ ...opts, duration: seconds });
      if (r.errors || r.non2xx) throw new Error(`${name} ${s.name}: ${r.errors} errors, ${r.non2xx} non-2xx`);
      const cell = ((results[s.name] ??= {})[name] ??= { rps: [], p99: [] });
      cell.rps.push(r.requests.average);
      cell.p99.push(r.latency.p99);
      process.stderr.write(`round ${round + 1} ${name.padEnd(10)} ${s.name.padEnd(26)} ${Math.round(r.requests.average)} req/s\n`);
    }
    child.kill();
  }
}

const lines = [
  `Node ${process.version}, ${availableParallelism()} cores, ${workers} load workers, 100 connections, ${seconds}s × ${rounds} rounds, median.`,
  "",
  `| | ${servers.join(" | ")} |`,
  `| --- | ${servers.map(() => "---:").join(" | ")} |`,
];
for (const s of scenarios) {
  const best = Math.max(...servers.map((n) => median(results[s.name][n].rps)));
  const cells = servers.map((n) => {
    const rps = Math.round(median(results[s.name][n].rps));
    const text = `${rps.toLocaleString("en")} req/s · p99 ${median(results[s.name][n].p99)} ms`;
    return rps === Math.round(best) ? `**${text}**` : text;
  });
  lines.push(`| ${s.name} | ${cells.join(" | ")} |`);
}
const table = lines.join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## inkan bench\n\n${table}\n`);

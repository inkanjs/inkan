// CPU time the server spends per request, scenario by scenario, in the order the HTTP bench
// uses. Unlike req/s it does not depend on how fast the load generator is: it is what one
// request costs the server. Several rounds, the lowest of each, since noise only adds time.
//
//   cd bench && npm install && node cpu.mjs [servers] [seconds] [rounds]

import { fork } from "node:child_process";
import { appendFileSync } from "node:fs";
import autocannon from "autocannon";
import { BULK } from "./data.mjs";

const servers = (process.argv[2] ?? "node,fastify,hono,inkan").split(",");
const seconds = Number(process.argv[3] ?? 5);
const rounds = Number(process.argv[4] ?? 3);
const json = { "content-type": "application/json" };
const scenarios = [
  ["hello", "/hello"],
  ["params + query", "/users/42?fields=name"],
  ["small JSON body", "/users", "POST", '{"name":"Mio","age":3}'],
  ["big JSON body", "/teas/bulk", "POST", BULK],
  ["big answer", "/teas"],
  ["router, 400 routes", "/p199/42/items/7"],
  ["3 middlewares", "/mw"],
  ["async handler", "/async/9"],
  ["404", "/nowhere/at/all"],
  ["400", "/users", "POST", '{"name":"","age":"x"}'],
  ["hello, at the end", "/hello"],
];
const cannon = (o) => new Promise((resolve, reject) => autocannon(o, (e, r) => (e ? reject(e) : resolve(r))));

const best = {}; // scenario -> server -> µs
let port = 5900;
for (let round = 0; round < rounds; round++) {
  for (const name of round % 2 ? [...servers].reverse() : servers) {
    const p = port++;
    const child = fork("cpu-server.mjs", [name, String(p)], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
    await new Promise((resolve) => child.stdout.on("data", (d) => String(d).includes("ready") && resolve()));
    const ask = (m) => new Promise((resolve) => (child.once("message", resolve), child.send(m)));
    for (const [label, path, method, body] of scenarios) {
      const o = { url: `http://127.0.0.1:${p}${path}`, method: method ?? "GET", body, headers: json, connections: 50 };
      await cannon({ ...o, duration: 2 });
      await ask("mark");
      await cannon({ ...o, duration: seconds });
      const { us } = await ask("read");
      const row = (best[label] ??= {});
      row[name] = Math.min(row[name] ?? Infinity, us);
      process.stderr.write(`round ${round + 1}  ${name.padEnd(8)} ${label.padEnd(20)} ${us.toFixed(1)} µs\n`);
    }
    child.kill();
  }
}

const lines = [
  `| CPU µs per request (lowest of ${rounds}) | ${servers.join(" | ")} |`,
  `| --- | ${servers.map(() => "---:").join(" | ")} |`,
  ...scenarios.map(([label]) => {
    const row = best[label];
    const low = Math.min(...servers.map((n) => row[n]));
    return `| ${label} | ${servers.map((n) => (row[n] === low ? `**${row[n].toFixed(1)}**` : row[n].toFixed(1))).join(" | ")} |`;
  }),
];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CPU per request\n\n${lines.join("\n")}\n`);

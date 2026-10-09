import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";

type Line = { msg?: string; port?: number; worker?: number; path?: string; status?: number; pid?: number; id?: string | number; slot?: string; armed?: boolean };

/** Starts a cluster fixture and hands back its JSON log lines as they come. */
function start(fixture = "cluster-app.ts", ...args: string[]) {
  const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures", fixture), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const lines: Line[] = [];
  let errors = "";
  let buffered = "";
  child.stdout.on("data", (d) => {
    buffered += d;
    const parts = buffered.split("\n");
    buffered = parts.pop()!;
    for (const p of parts) if (p.trim().startsWith("{")) lines.push(JSON.parse(p));
  });
  child.stderr.on("data", (d) => (errors += d));
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(ok(), `${what}; log: ${JSON.stringify(lines)} ${errors}`);
  };
  return { child, lines, until, errors: () => errors };
}

test("workers share one port, say which of them answered, and one that dies is replaced", { timeout: 30_000 }, async () => {
  const { child, lines, until, errors } = start();
  try {
    const listening = () => lines.filter((l) => l.msg === "listening");
    await until(() => listening().length === 2, "two workers listen");
    const [a, b] = listening();
    assert.equal(a.port, b.port, "one port for both");
    assert.notEqual(a.worker, b.worker);

    const base = `http://127.0.0.1:${a.port}`;
    for (let i = 0; i < 4; i++) assert.equal((await fetch(`${base}/who`)).status, 200);
    await until(() => lines.some((l) => l.path === "/who" && typeof l.worker === "number"), "the log says which worker answered");

    // every request id is new across the whole cluster, and names the worker that made it
    await Promise.all(Array.from({ length: 40 }, () => fetch(`${base}/who`).then((r) => r.arrayBuffer())));
    const answered = () => lines.filter((l) => l.path === "/who");
    await until(() => answered().length === 44, "every request is logged");
    assert.equal(new Set(answered().map((l) => l.id)).size, 44, "no id twice");
    for (const l of answered()) assert.match(String(l.id), new RegExp(`w${l.worker!.toString(36)}-`), "the id names its worker");

    await fetch(`${base}/crash`).catch(() => undefined); // the worker exits mid-answer
    await until(() => listening().length === 3, "a new worker takes its place");
    assert.match(errors(), /worker \d+ stopped with 3; starting another/);
    assert.equal((await fetch(`${base}/who`)).status, 200);
  } finally {
    child.kill("SIGKILL");
  }
});

test("SIGTERM lets every worker finish and run onClose", { timeout: 30_000, skip: process.platform === "win32" && "Windows has no SIGTERM to send" }, async () => {
  const { child, lines, until } = start();
  await until(() => lines.filter((l) => l.msg === "listening").length === 2, "two workers listen");
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
  assert.equal(lines.filter((l) => l.msg === "closed").length, 2, "onClose ran in each worker");
});

test("jobs in memory and workers do not go together: listen says so before it starts any", async () => {
  const { inkan, memoryStore } = await import("../src/index.ts");
  const app = inkan({ log: false, workers: 2 }).job("/work", {}, () => null);
  assert.throws(() => app.listen(0), /background jobs keep their queue in this process.*workers: 2/);
  // a store the processes share is fine
  const shared = { ...memoryStore(), shared: true };
  const ok = inkan({ log: false, workers: 2 }).job("/work", { store: shared }, () => null);
  assert.equal(ok._jobs?.local(), false);
});

test("a job's schedule runs in worker slot 1 only, and the worker that replaces it takes it over", { timeout: 30_000 }, async () => {
  const { child, lines, until } = start("cluster-cron-app.ts");
  try {
    const up = () => lines.filter((l) => l.msg === "up");
    await until(() => up().length === 2, "two workers listen");
    const [one, two] = [up().find((l) => l.slot === "1"), up().find((l) => l.slot === "2")];
    assert.equal(one?.armed, true, "slot 1 arms the schedule");
    assert.equal(two?.armed, false, "slot 2 does not");

    // the fixture tells slot 1 to die once: its replacement has another cluster id, the same slot, and the schedule
    await until(() => up().length === 3, "a new worker takes slot 1");
    const next = up()[2];
    assert.equal(next.slot, "1");
    assert.notEqual(next.id, one!.id);
    assert.equal(next.armed, true);
  } finally {
    child.kill("SIGKILL");
  }
});

test("in a cluster made without inkan's workers, the schedule runs in the worker with id 1", { timeout: 30_000 }, async () => {
  const { child, lines, until } = start("cluster-cron-app.ts", "own");
  try {
    const up = () => lines.filter((l) => l.msg === "up");
    await until(() => up().length === 2, "two workers listen");
    const seen = up().map((l) => [l.slot, l.id, l.armed]).sort((a, b) => Number(a[1]) - Number(b[1]));
    assert.deepEqual(seen, [[undefined, 1, true], [undefined, 2, false]]);
  } finally {
    child.kill("SIGKILL");
  }
});

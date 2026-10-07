import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";

type Line = { msg?: string; port?: number; worker?: number; path?: string; status?: number; pid?: number };

/** Starts the cluster fixture and hands back its JSON log lines as they come. */
function start() {
  const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures/cluster-app.ts")], { stdio: ["ignore", "pipe", "pipe"] });
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

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Cron } from "../src/core/cron.ts";
import { inkan, t, type Job } from "../src/index.ts";

const quiet = { log: false, gracefulShutdown: false } as const;
const iso = (d: Date | undefined) => d?.toISOString().slice(0, 16);
const next = (expr: string, after: string) => iso(new Cron(expr).next(new Date(after + ":00Z")));

test("cron: the next minute that matches, in UTC", () => {
  const vectors: [string, string, string | undefined][] = [
    ["0 3 * * *", "2026-01-01T00:00", "2026-01-01T03:00"],
    ["0 3 * * *", "2026-01-01T03:00", "2026-01-02T03:00"], // strictly after
    ["* * * * *", "2026-01-01T10:07", "2026-01-01T10:08"],
    ["*/15 * * * *", "2026-01-01T10:07", "2026-01-01T10:15"],
    ["*/15 * * * *", "2026-01-01T10:45", "2026-01-01T11:00"],
    ["5/15 * * * *", "2026-01-01T10:21", "2026-01-01T10:35"],
    ["10-50/20 * * * *", "2026-01-01T10:31", "2026-01-01T10:50"],
    ["10-50/20 * * * *", "2026-01-01T10:51", "2026-01-01T11:10"],
    ["30 4 1,15 * *", "2026-01-02T00:00", "2026-01-15T04:30"],
    ["59 23 31 12 *", "2026-12-31T23:59", "2027-12-31T23:59"],
    ["0 0 1 1 *", "2026-06-15T12:00", "2027-01-01T00:00"],
    ["0 0 1 jan *", "2026-06-15T12:00", "2027-01-01T00:00"],
    ["0 12 * JUN-aug *", "2026-01-10T00:00", "2026-06-01T12:00"],
    // Feb 29: leap years only, and 2100 is none
    ["0 0 29 2 *", "2026-03-01T00:00", "2028-02-29T00:00"],
    ["0 0 29 2 *", "2096-03-01T00:00", "2104-02-29T00:00"],
    // the 31st skips the months without one; ranges to the end of the month
    ["0 0 31 * *", "2026-04-01T00:00", "2026-05-31T00:00"],
    ["0 0 31 * *", "2026-01-31T00:00", "2026-03-31T00:00"],
    ["0 0 28-31 * *", "2026-02-27T12:00", "2026-02-28T00:00"],
    ["0 0 28-31 * *", "2026-02-28T00:00", "2026-03-28T00:00"],
    ["0 0 29-31 2 *", "2026-01-01T00:00", "2028-02-29T00:00"],
    // days of the week: 2026-10-09 is a Friday
    ["0 9 * * mon-fri", "2026-10-09T09:00", "2026-10-12T09:00"],
    ["0 9 * * 1-5", "2026-10-09T08:00", "2026-10-09T09:00"],
    ["0 0 * * 0", "2026-10-09T00:00", "2026-10-11T00:00"],
    ["0 0 * * 7", "2026-10-09T00:00", "2026-10-11T00:00"],
    ["0 0 * * sun", "2026-10-09T00:00", "2026-10-11T00:00"],
    ["0 0 * * sat,sun", "2026-10-09T00:00", "2026-10-10T00:00"],
    // both day fields restricted: either matches (the 13th, or any Friday)
    ["0 0 13 * fri", "2026-10-01T00:00", "2026-10-02T00:00"],
    ["0 0 13 * fri", "2026-10-10T00:00", "2026-10-13T00:00"],
    // one of them a star, even a stepped one: both must match
    ["0 0 */2 * fri", "2026-10-01T00:00", "2026-10-09T00:00"],
    ["0 0 1 * *", "2026-10-02T00:00", "2026-11-01T00:00"],
    // macros
    ["@hourly", "2026-01-01T10:07", "2026-01-01T11:00"],
    ["@daily", "2026-01-01T10:07", "2026-01-02T00:00"],
    ["@weekly", "2026-10-09T10:00", "2026-10-11T00:00"],
    ["@monthly", "2026-10-09T10:00", "2026-11-01T00:00"],
    ["@yearly", "2026-10-09T10:00", "2027-01-01T00:00"],
    // never
    ["0 0 30 2 *", "2026-01-01T00:00", undefined],
    ["0 0 31 4,6,9,11 *", "2026-01-01T00:00", undefined],
  ];
  for (const [expr, after, want] of vectors) assert.equal(next(expr, after), want, `${expr} after ${after}`);
});

test("cron: seconds are dropped, and the result is on a whole minute", () => {
  assert.equal(new Cron("* * * * *").next(new Date("2026-01-01T10:07:59.999Z"))!.toISOString(), "2026-01-01T10:08:00.000Z");
});

test("cron: local time reads the process's own clock", () => {
  const d = new Cron("30 3 * * *").next(new Date(2026, 0, 1, 12, 0), "local")!;
  assert.deepEqual([d.getDate(), d.getHours(), d.getMinutes()], [2, 3, 30]);
});

test("cron: what is wrong is said", () => {
  const cases: [string, RegExp][] = [
    ["* * * *", /five fields/],
    ["61 * * * *", /minute "61" has 61, outside 0-59/],
    ["* 24 * * *", /hour/],
    ["* * 0 * *", /day of month/],
    ["* * * 13 *", /month/],
    ["* * * * 8", /day of week/],
    ["a * * * *", /not a number/],
    ["* * * foo *", /not a number or a name/],
    ["5-1 * * * *", /backwards/],
    ["*/0 * * * *", /step/],
    ["1-2-3 * * * *", /not a value/],
    ["1,,2 * * * *", /not a value/],
  ];
  for (const [expr, msg] of cases) assert.throws(() => new Cron(expr), msg, expr);
});

// ---------- scheduling ----------

const START = Date.UTC(2026, 0, 1, 2, 59, 30);
/** Lets the job's promises run; setImmediate is not mocked. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
const DAY = 24 * 3600_000;

function timers(now = START) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  return { [Symbol.dispose]: () => mock.timers.reset() };
}

test("every: runs the job on its schedule once the app has started, and stops on shutdown", async () => {
  using _ = timers();
  const runs: { at: string; input: unknown; method: string; path: string }[] = [];
  const app = inkan(quiet).job("/nightly", { every: "0 3 * * *", owner: (ctx) => ctx.headers["x-user"] as string }, async (job) => {
    runs.push({ at: new Date().toISOString(), input: job.input, method: job.ctx.method, path: job.ctx.path });
    return 1;
  });
  mock.timers.tick(60_000);
  await settle();
  assert.equal(runs.length, 0, "nothing before the app starts");

  await app.started(); // 03:00 today went by before the start: tomorrow is the next one
  mock.timers.tick(DAY - 60_000);
  await settle();
  assert.equal(runs.length, 0);
  mock.timers.tick(30_000);
  await settle();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.at, "2026-01-02T03:00:00.000Z");
  assert.deepEqual([runs[0]!.method, runs[0]!.path, runs[0]!.input], ["POST", "/nightly", undefined]);
  mock.timers.tick(DAY);
  await settle();
  assert.equal(runs.length, 2);
  assert.equal(runs[1]!.at, "2026-01-03T03:00:00.000Z", "no drift");

  await app.stopped();
  mock.timers.tick(7 * DAY);
  await settle();
  assert.equal(runs.length, 2, "stopped");
});

test("every: a run is skipped while the last scheduled one still runs", async () => {
  using _ = timers(Date.UTC(2026, 0, 1, 0, 0, 0));
  let open!: () => void;
  let started = 0;
  const app = inkan(quiet).job("/minutely", { every: "* * * * *" }, async (job: Job) => {
    started++;
    if (started === 1) await new Promise<void>((r) => (open = r));
    return job.id;
  });
  await app.started();
  mock.timers.tick(60_000);
  await settle();
  assert.equal(started, 1);
  mock.timers.tick(60_000);
  await settle();
  assert.equal(started, 1, "the first is still running: skipped");
  open();
  await settle();
  mock.timers.tick(60_000);
  await settle();
  assert.equal(started, 2);
  await app.stopped();
});

test("every: a job with a body needs input, checked against it; the run gets it as job.input and ctx.body", async () => {
  using _ = timers(Date.UTC(2026, 0, 1, 0, 0, 0));
  const Body = t.object({ rows: t.int(), format: t.enum(["csv", "json"]).default("csv") });
  assert.throws(() => inkan(quiet).job("/a", { body: Body, every: "* * * * *" }, () => 1), /needs \{ cron, input \}/);
  assert.throws(() => inkan(quiet).job("/b", { body: Body, every: { cron: "* * * * *", input: { rows: "x" } as never } }, () => 1), /every.input does not match the body: rows expected an integer/);
  assert.throws(() => inkan(quiet).job("/c", { every: "* * *" }, () => 1), /app.job\("\/c"\): cron "\* \* \*": five fields/);
  assert.throws(() => inkan(quiet).job("/d", { every: "0 0 30 2 *" }, () => 1), /never matches/);
  assert.throws(() => inkan(quiet).job("/e", { every: { cron: "@daily", timezone: "Europe/Berlin" as never } }, () => 1), /timezone/);

  let got: unknown[] = [];
  const app = inkan(quiet).job("/export", { body: Body, every: { cron: "*/5 * * * *", input: { rows: 3, format: "json" } } }, async (job) => {
    got = [job.input, job.ctx.body];
    return 1;
  });
  await app.started();
  mock.timers.tick(5 * 60_000);
  await settle();
  assert.deepEqual(got, [{ rows: 3, format: "json" }, { rows: 3, format: "json" }]);
  await app.stopped();
});

test("every: a wait longer than a timer takes goes in hops and still lands on the minute", async () => {
  using _ = timers(Date.UTC(2026, 2, 1, 0, 0, 0));
  const at: string[] = [];
  const app = inkan(quiet).job("/leap", { every: "0 0 29 2 *" }, async () => void at.push(new Date().toISOString()));
  await app.started();
  const longest = 2 ** 31 - 1;
  let left = Date.UTC(2028, 1, 29) - Date.now() - 1000;
  while (left > 0) {
    const step = Math.min(left, longest);
    mock.timers.tick(step);
    left -= step;
  }
  await settle();
  assert.deepEqual(at, [], "not a second early");
  mock.timers.tick(1000);
  await settle();
  assert.deepEqual(at, ["2028-02-29T00:00:00.000Z"]);
  await app.stopped();
});

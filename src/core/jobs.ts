// Background jobs: work that takes longer than a request should. `app.job(path, options, run)`
// defines five ordinary routes around a queue, so the docs, OpenAPI, hooks, security, the
// typed client and `inkan check` see them like any other:
//
//   POST   /exports                  starts one: 202, the job, and where to find it
//   GET    /exports/:id              how it stands
//   GET    /exports/:id/events       how it goes, as server-sent events, until it ends
//   GET    /exports/:id/result       what it made, waiting up to ?wait=30 seconds for it
//   DELETE /exports/:id              cancels it, or forgets it once it is over
//
// Jobs run in this process. A job still running when the process ends is lost: there are no
// retries and nothing is written to disk. The store only holds what a job looks like, so that
// another store (a database, Redis) can be put in where several processes share it.

import { randomBytes } from "node:crypto";
import { HttpProblem, problem, type ProblemBody } from "./problem.ts";
import { EventsSchema, t, type Issue, type Schema } from "../schema/schema.ts";
import { sse } from "./stream.ts";
import { within as withContext } from "./request-context.ts";
import { Cron, type CronZone } from "./cron.ts";
import { joinPath, reply, type Context, type DecoOf, type Example, type JoinPath, type PathParams, type RawHeaders, type RawQuery, type Security, type WithRoutes } from "./route.ts";

export type JobState = "queued" | "running" | "done" | "failed" | "canceled";

/** A job as the store keeps it. */
export type JobRecord = {
  id: string;
  /** The job's kind: the path it was started at, as it was defined (`/exports`). */
  kind: string;
  /** Whose job it is, as `owner(ctx)` said when it was started. */
  owner?: string;
  state: JobState;
  /** What it was started with; dropped once it is over. */
  input?: unknown;
  progress?: unknown;
  /** Its place in the queue, 1 for next, while it waits. */
  position?: number;
  result?: unknown;
  error?: ProblemBody;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  /** When the store may forget it (ms since the epoch); set once it is over. */
  expiresAt?: number;
  /** Someone asked to cancel it; whoever runs it stops it. */
  cancelRequested?: boolean;
};

type Maybe<T> = T | Promise<T>;

/**
 * Where jobs are kept. `memoryStore()` is the one inkan has; a store several processes share
 * (`shared: true`) lets an app with jobs run with `workers`.
 */
export interface JobStore {
  /** Whether every process sees the same jobs. The memory store does not. */
  readonly shared: boolean;
  get(id: string): Maybe<JobRecord | undefined>;
  /** Keeps the job as it is now and tells everyone watching it. */
  set(job: JobRecord): Maybe<void>;
  delete(id: string): Maybe<void>;
  /** Forgets every job whose `expiresAt` is `now` or earlier. */
  sweep(now: number): Maybe<void>;
  /** Calls `fn` with the job each time it is set, until the function it returns is called. */
  watch(id: string, fn: (job: JobRecord) => void): () => void;
  /** Marks a job that is not over yet as to be canceled; watchers see `cancelRequested`. */
  cancel(id: string): Maybe<void>;
}

const FINAL = (s: JobState) => s === "done" || s === "failed" || s === "canceled";

/**
 * Jobs in this process's memory: lost when it ends, and not seen by other workers. Holds at
 * most `max` jobs (default 1000); past that the oldest finished one goes first.
 */
export function memoryStore(options: { max?: number } = {}): JobStore {
  const max = options.max ?? 1000;
  const jobs = new Map<string, JobRecord>();
  const watchers = new Map<string, Set<(job: JobRecord) => void>>();
  const store: JobStore = {
    shared: false,
    get: (id) => jobs.get(id),
    set(job) {
      const fresh = !jobs.has(job.id);
      jobs.set(job.id, job);
      if (fresh && jobs.size > max) {
        for (const [id, j] of jobs) {
          if (FINAL(j.state)) {
            jobs.delete(id);
            break;
          }
        }
      }
      const fns = watchers.get(job.id);
      if (fns) for (const fn of [...fns]) fn(job);
    },
    delete(id) {
      jobs.delete(id);
    },
    sweep(now) {
      for (const [id, j] of jobs) if (j.expiresAt !== undefined && j.expiresAt <= now) jobs.delete(id);
    },
    watch(id, fn) {
      let set = watchers.get(id);
      if (!set) watchers.set(id, (set = new Set()));
      set.add(fn);
      return () => {
        set.delete(fn);
        if (!set.size && watchers.get(id) === set) watchers.delete(id);
      };
    },
    cancel(id) {
      const j = jobs.get(id);
      if (j && !FINAL(j.state)) store.set({ ...j, cancelRequested: true });
    },
  };
  return store;
}

// ---------- types ----------

/** A job as the routes answer with it. */
export type JobBody<P = unknown> = {
  id: string;
  state: JobState;
  progress?: P;
  position?: number;
  error?: ProblemBody;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
};

/** What the function that does the work gets. */
export type Job<B = unknown, P = unknown, Deco = {}> = {
  id: string;
  /** The checked body it was started with. */
  input: B;
  /** Aborted when the job is canceled, runs out of time, or the server stops. */
  signal: AbortSignal;
  /** Tells whoever follows the job how far it is. Only the latest is kept. */
  progress(p: P): void;
  /**
   * The context of the request that started it, for decorations and `state`. That request is
   * over: its `signal` throws, use `job.signal`.
   */
  ctx: Context<any, any, B, any, any> & Deco;
};

export type JobOptions<B, P, R, Deco = {}> = {
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  hidden?: boolean;
  security?: Security | Security[] | false;
  /** The name of the job schema in OpenAPI is `<name>Job`. Default: the last part of the path, `/exports` is `Exports`. */
  name?: string;
  body?: Schema<B>;
  progress?: Schema<P>;
  result?: Schema<R>;
  /** How many run at the same time, in this process. Default 1. */
  concurrency?: number;
  /** How many may wait; past that, starting one is a 503. Default 100. */
  queue?: number;
  /** Seconds a finished job is kept for its result. Default 3600. */
  keep?: number;
  /** Milliseconds a job may run before it fails and `job.signal` is aborted. Default: no limit. */
  timeout?: number;
  /** Whose job it is. Anybody else gets a 404 for it. */
  owner?: (ctx: Context<any, any, B, any, any> & Deco) => string | undefined;
  /** Where jobs are kept. Default: one memory store for the app. */
  store?: JobStore;
  /** Examples for starting one. The routes around it get examples that build on the first. */
  examples?: Example[];
  /**
   * Starts the job on a schedule as well, as a POST would: the same queue, concurrency and
   * store, without an owner. A five-field cron expression (`"0 3 * * *"`, in UTC), or
   * `{ cron, input, timezone }` with the input to start it with (needed when the job has a
   * `body`, and checked against it) and `"local"` for the process's own time zone. A run
   * is skipped while the one this schedule started before is still waiting or running.
   * Schedules start once the app listens (`listen`, or `app.started()` for an adapter),
   * stop on shutdown, and with `workers` run in worker 1 only. `job.ctx` of a scheduled
   * run is a context of no real request: a POST to the job's path, no headers, its input as
   * the body.
   */
  every?: string | { cron: string; input?: B; timezone?: CronZone };
};

type ProblemSchema = Schema<ProblemBody>;
type JobSchema<P> = Schema<JobBody<P>>;

/** The five routes of a job, as the typed client knows them. */
export type JobRoutes<Path extends string, B, P, R> = {
  [K in `POST ${Path}`]: { params: PathParams<Path>; query: RawQuery; body: B; headers: RawHeaders; response: { 202: JobSchema<P>; 503: ProblemSchema } };
} & {
  [K in `GET ${JoinPath<Path, "/:id">}`]: { params: PathParams<JoinPath<Path, "/:id">>; query: RawQuery; body: undefined; headers: RawHeaders; response: { 200: JobSchema<P>; 404: ProblemSchema } };
} & {
  [K in `GET ${JoinPath<Path, "/:id/events">}`]: {
    params: PathParams<JoinPath<Path, "/:id/events">>;
    query: RawQuery;
    body: undefined;
    headers: RawHeaders;
    response: { 200: EventsSchema<{ status: JobSchema<P>; progress: Schema<P>; end: JobSchema<P> }>; 404: ProblemSchema };
  };
} & {
  [K in `GET ${JoinPath<Path, "/:id/result">}`]: {
    params: PathParams<JoinPath<Path, "/:id/result">>;
    query: { wait?: number };
    body: undefined;
    headers: RawHeaders;
    response: { 200: Schema<R>; 404: ProblemSchema; 409: ProblemSchema };
  };
} & {
  [K in `DELETE ${JoinPath<Path, "/:id">}`]: {
    params: PathParams<JoinPath<Path, "/:id">>;
    query: RawQuery;
    body: undefined;
    headers: RawHeaders;
    response: { 202: JobSchema<P>; 204: Schema<undefined>; 404: ProblemSchema };
  };
};

/** `job` as a property, so its type can name the app or scope it returns. */
export type JobMethod<Self> = <Path extends string, B = undefined, P = unknown, R = unknown>(
  path: Path,
  options: JobOptions<B, P, R, DecoOf<Self>>,
  run: (job: Job<B, P, DecoOf<Self>>) => NoInfer<R> | Promise<NoInfer<R>>,
) => WithRoutes<Self, JobRoutes<Path, B, P, R>>;

// ---------- running them ----------

/** What the jobs need from the app. */
export interface JobHost {
  dev: boolean;
  options: { validateResponses?: boolean; onError?: (error: unknown, ctx: Context<any, any, any, any, any>) => void };
}

const newId = () => randomBytes(16).toString("base64url"); // not the request id: that one is a counter, easy to guess

/** Every kind of job of one app: their store, the sweep, and the shutdown. */
export class JobHub {
  host: JobHost;
  kinds: JobKind[] = [];
  closing = false;
  private store?: JobStore;
  private sweeper?: ReturnType<typeof setInterval>;
  private scheduling = false;
  constructor(host: JobHost) {
    this.host = host;
  }

  defaultStore(): JobStore {
    return (this.store ??= memoryStore());
  }

  /** Whether any kind keeps its jobs where only this process sees them. */
  local(): boolean {
    return this.kinds.some((k) => !k.store.shared);
  }

  /** One timer for the app, made with the first job and never holding the process open. */
  sweepSoon() {
    if (this.sweeper) return;
    const keep = Math.min(...this.kinds.map((k) => k.keep));
    const every = Math.max(1000, Math.min(60_000, keep));
    // made while a request starts a job: outside its store, which the timer would keep forever
    this.sweeper = withContext(undefined, () => setInterval(() => {
      const now = Date.now();
      for (const s of new Set(this.kinds.map((k) => k.store))) {
        try {
          const r = s.sweep(now);
          if (r instanceof Promise) r.catch((err) => this.report(err));
        } catch (err) {
          this.report(err);
        }
      }
    }, every));
    this.sweeper.unref?.();
  }

  /** Arms every kind's schedule, once. */
  schedule() {
    if (this.scheduling || this.closing) return;
    this.scheduling = true;
    for (const k of this.kinds) k.arm();
  }

  report(err: unknown, ctx?: Context<any, any, any, any, any>) {
    if (this.host.options.onError) this.host.options.onError(err, ctx as never);
    else console.error(err);
  }

  /**
   * The server is stopping: nothing new starts, waiting jobs are canceled and every event
   * stream ends now. Running jobs get `grace` ms to finish, then their signal is aborted.
   */
  async stop(grace = 8_000): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.sweeper) clearInterval(this.sweeper);
    for (const k of this.kinds) k.unschedule();
    for (const k of this.kinds) k.closeDown();
    const running = this.kinds.flatMap((k) => k.runs());
    if (!running.length) return;
    if (!(await within(Promise.all(running), grace))) {
      for (const k of this.kinds) k.abortAll();
      await within(Promise.all(running), 500);
    }
  }
}

/** Whether `work` settled within `ms`. */
async function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  try {
    return await Promise.race([work.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A job of this process, waiting or running. */
type Live = {
  rec: JobRecord;
  ctx: Context<any, any, any, any, any>;
  ctl?: AbortController;
  settled?: Promise<void>;
};

const notFound = (id: string) => problem(404, "job-not-found", `No job ${id}`);
const later = (status: number, type: string, detail: string, seconds: number) => new HttpProblem(status, type, detail, {}, { "retry-after": String(seconds) });
const TIMEOUT = Symbol("timeout");
/** The longest delay a timer takes: 2^31 - 1 ms, almost 25 days. Longer waits go in hops. */
const LONGEST = 2 ** 31 - 1;

/** A kind's schedule, from `every`. */
type Schedule = {
  cron: Cron;
  zone: CronZone;
  input: unknown;
  /** A context for a run that no request started. */
  ctx: () => Context<any, any, any, any, any>;
  timer?: ReturnType<typeof setTimeout>;
  /** The minute the timer is for. */
  at?: number;
  /** The job the schedule started last, so the next run waits for it. */
  last?: string;
};

/** One kind of job: its queue, its slots, and the routes' work. */
export class JobKind {
  hub: JobHub;
  path: string;
  store: JobStore;
  keep: number;
  private opts: JobOptions<any, any, any, any>;
  private run: (job: Job<any, any, any>) => unknown;
  private concurrency: number;
  private limit: number;
  private queue: string[] = [];
  private live = new Map<string, Live>();
  private running = 0;
  /** Wakes every open event stream, so it can see the server is stopping. */
  private streams = new Set<() => void>();
  /** @internal */
  schedule?: Schedule;

  constructor(hub: JobHub, path: string, opts: JobOptions<any, any, any, any>, run: (job: Job<any, any, any>) => unknown) {
    this.hub = hub;
    this.path = path;
    this.opts = opts;
    this.run = run;
    this.store = opts.store ?? hub.defaultStore();
    this.keep = (opts.keep ?? 3600) * 1000;
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.limit = Math.max(0, opts.queue ?? 100);
  }

  private get checks(): boolean {
    return Boolean(this.hub.host.options.validateResponses);
  }

  /** Keeps a job as it is now. A store that fails is reported; the job goes on. */
  private save(rec: JobRecord) {
    try {
      const r = this.store.set(rec);
      if (r instanceof Promise) r.catch((err) => this.hub.report(err));
    } catch (err) {
      this.hub.report(err);
    }
  }

  private update(l: Live, patch: Partial<JobRecord>) {
    l.rec = { ...l.rec, ...patch };
    this.save(l.rec);
  }

  /** The job behind `:id`, or a 404 when there is none, it is another kind, or someone else's. */
  private async find(ctx: Context<any, any, any, any, any>): Promise<JobRecord> {
    const id = (ctx.params as { id: string }).id;
    const rec = await this.store.get(id);
    if (!rec || rec.kind !== this.path) throw notFound(id);
    if (this.opts.owner && rec.owner !== this.opts.owner(ctx)) throw notFound(id);
    return rec;
  }

  // ----- the routes -----

  async start(ctx: Context<any, any, any, any, any>) {
    const owner = this.opts.owner?.(ctx);
    const rec = this.admit(ctx, ctx.body, owner);
    await this.store.set(rec);
    this.pump();
    return reply(202, view(this.live.get(rec.id)?.rec ?? rec), { location: `${ctx.path.replace(/\/+$/, "")}/${rec.id}` });
  }

  /** A new job in the queue, or a 503 when the server stops or the queue is full. */
  private admit(ctx: Context<any, any, any, any, any>, input: unknown, owner: string | undefined): JobRecord {
    if (this.hub.closing) throw later(503, "shutting-down", "The server is shutting down", 5);
    if (this.queue.length >= this.limit) throw later(503, "job-queue-full", `${this.queue.length} jobs are waiting already`, 5);
    const rec: JobRecord = { id: newId(), kind: this.path, state: "queued", input, position: this.queue.length + 1, createdAt: new Date() };
    if (owner !== undefined) rec.owner = owner;
    this.live.set(rec.id, { rec, ctx });
    this.queue.push(rec.id);
    this.hub.sweepSoon();
    return rec;
  }

  // ----- the schedule -----

  /** Sets the timer for the next run after `from`. A wait longer than a timer takes goes in hops. */
  arm(from = Date.now()) {
    const s = this.schedule;
    if (!s || this.hub.closing) return;
    const next = s.cron.next(Math.max(from, Date.now()), s.zone);
    if (!next) return;
    s.at = next.getTime();
    this.wait(s);
  }

  private wait(s: Schedule) {
    const left = s.at! - Date.now();
    const hop = left > LONGEST;
    // made outside any request's store, which the timer would otherwise keep
    s.timer = withContext(undefined, () => setTimeout(() => (hop ? this.wait(s) : this.fire(s)), hop ? LONGEST : Math.max(0, left)));
    s.timer.unref?.();
  }

  /** A scheduled run: started as a POST would be, unless the last one is still waiting or running. */
  private fire(s: Schedule) {
    const at = s.at!;
    s.timer = undefined;
    if (this.hub.closing) return;
    if (!(s.last && this.live.has(s.last))) {
      try {
        const ctx = s.ctx();
        ctx.body = s.input;
        const rec = this.admit(ctx, s.input, undefined);
        s.last = rec.id;
        Promise.resolve(this.store.set(rec)).then(
          () => this.pump(),
          (err) => this.hub.report(err),
        );
      } catch (err) {
        this.hub.report(err); // a full queue: this run is lost, the next one comes as planned
      }
    }
    this.arm(at); // the next minute after this one, not after now: no drift, and none twice
  }

  unschedule() {
    if (this.schedule?.timer) clearTimeout(this.schedule.timer);
  }

  async status(ctx: Context<any, any, any, any, any>) {
    return view(await this.find(ctx));
  }

  async result(ctx: Context<any, any, any, any, any>) {
    let rec = await this.find(ctx);
    const wait = (ctx.query as { wait?: number }).wait ?? 0;
    if (!FINAL(rec.state) && wait > 0) rec = await this.until(rec, wait * 1000, ctx.signal);
    if (rec.state === "done") return reply(200, rec.result);
    if (rec.state === "failed") throw problem(409, "job-failed", "The job failed", { error: rec.error });
    if (rec.state === "canceled") throw problem(409, "job-canceled", "The job was canceled", rec.error ? { error: rec.error } : {});
    throw later(409, "job-not-done", `The job is ${rec.state}`, 1);
  }

  async cancel(ctx: Context<any, any, any, any, any>) {
    const rec = await this.find(ctx);
    if (FINAL(rec.state)) {
      await this.store.delete(rec.id);
      return reply(204, undefined);
    }
    const l = this.live.get(rec.id);
    if (l && l.rec.state === "queued") {
      // still waiting here: out of the queue at once
      this.queue.splice(this.queue.indexOf(rec.id), 1);
      this.finish(l, "canceled", {});
      this.reposition();
      return reply(202, view(l.rec));
    }
    l?.ctl?.abort(new DOMException("The job was canceled", "AbortError"));
    await this.store.cancel(rec.id); // for a job another process runs, it watches the store
    return reply(202, view((await this.store.get(rec.id)) ?? rec));
  }

  events(ctx: Context<any, any, any, any, any>) {
    return this.find(ctx).then((first) => {
      const kind = this;
      return sse(async function* (signal) {
        let latest = first;
        let changed = false;
        let wake: (() => void) | undefined;
        const poke = () => {
          changed = true;
          wake?.();
        };
        const off = kind.store.watch(first.id, (r) => {
          latest = r;
          poke();
        });
        kind.streams.add(poke);
        signal.addEventListener("abort", poke);
        try {
          latest = (await kind.store.get(first.id)) ?? latest; // whatever happened before the stream was read
          yield { event: "status", data: view(latest) };
          let state = latest.state;
          let position = latest.position;
          let progress = latest.progress;
          while (!FINAL(latest.state) && !kind.hub.closing) {
            if (!changed) await new Promise<void>((resolve) => (wake = resolve));
            wake = undefined;
            changed = false;
            if (signal.aborted) return;
            // only the latest: a slow reader skips what it missed, nothing piles up
            const now = latest;
            if (!FINAL(now.state) && (now.state !== state || now.position !== position)) {
              state = now.state;
              position = now.position;
              yield { event: "status", data: view(now) };
            }
            if (now.progress !== undefined && now.progress !== progress) {
              progress = now.progress;
              yield { event: "progress", data: now.progress };
            }
          }
          if (!signal.aborted) yield { event: "end", data: view(latest) };
        } finally {
          off();
          kind.streams.delete(poke);
          signal.removeEventListener("abort", poke);
        }
      });
    });
  }

  /** The job once it is over, or as it is when `ms` run out or the client goes away. */
  private until(rec: JobRecord, ms: number, signal: AbortSignal): Promise<JobRecord> {
    return new Promise((resolve) => {
      let latest = rec;
      let over = false;
      const done = () => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        off();
        signal.removeEventListener("abort", done);
        resolve(latest);
      };
      const off = this.store.watch(rec.id, (r) => {
        latest = r;
        if (FINAL(r.state)) done();
      });
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done);
      Promise.resolve(this.store.get(rec.id)).then((r) => {
        if (r && FINAL(r.state)) {
          latest = r;
          done();
        }
      }, done);
    });
  }

  // ----- the queue -----

  private pump() {
    while (this.running < this.concurrency && this.queue.length && !this.hub.closing) {
      const l = this.live.get(this.queue.shift()!);
      if (!l) continue;
      this.running++;
      // the job's own context for context(), not the store of the request that started it
      const ctx = jobContext(l.ctx);
      l.settled = withContext(ctx, () => this.execute(l, ctx));
    }
    this.reposition();
  }

  /** Keeps every waiting job's place current. */
  private reposition() {
    this.queue.forEach((id, i) => {
      const l = this.live.get(id);
      if (l && l.rec.position !== i + 1) this.update(l, { position: i + 1 });
    });
  }

  /** Runs one job to its end. Never rejects. */
  private async execute(l: Live, ctx: Context<any, any, any, any, any>): Promise<void> {
    const ctl = (l.ctl = new AbortController());
    const id = l.rec.id;
    const off = this.store.watch(id, (r) => {
      if (r.cancelRequested && !ctl.signal.aborted) ctl.abort(new DOMException("The job was canceled", "AbortError"));
    });
    if (l.rec.cancelRequested) ctl.abort(new DOMException("The job was canceled", "AbortError"));
    this.update(l, { state: "running", startedAt: new Date(), position: undefined });

    const { progress: progressSchema, result: resultSchema, timeout } = this.opts;
    const trim = progressSchema?._trimmer();
    let broken: HttpProblem | undefined;
    const job: Job<any, any, any> = {
      id,
      input: l.rec.input,
      signal: ctl.signal,
      ctx,
      progress: (p) => {
        if (this.live.get(id) !== l || ctl.signal.aborted) return; // over or stopping: late progress is dropped
        if (progressSchema && this.checks) {
          const r = progressSchema.safeParse(p);
          if (!r.ok) {
            broken = this.contract("progress", r.issues);
            ctl.abort(broken);
            throw broken;
          }
        }
        this.update(l, { progress: trim ? trim(p) : p });
      },
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
    try {
      const work = (async () => this.run(job))();
      if (timeout) {
        work.catch(() => {}); // what it does after its time is up nobody waits for
        const late = new Promise<typeof TIMEOUT>((resolve) => (timer = setTimeout(() => resolve(TIMEOUT), timeout)));
        outcome = { ok: true, value: await Promise.race([work, late]) };
      } else outcome = { ok: true, value: await work };
    } catch (error) {
      outcome = { ok: false, error };
    }
    clearTimeout(timer);
    off();

    if (outcome.ok && outcome.value === TIMEOUT) {
      const p = problem(504, "job-timeout", `The job took longer than ${timeout} ms`);
      ctl.abort(new DOMException(p.detail!, "TimeoutError"));
      this.finish(l, "failed", { error: p.toJSON() });
    } else if (broken) this.finish(l, "failed", { error: broken.toJSON() });
    else if (ctl.signal.aborted) {
      // canceled or stopped: whatever it returned is not wanted any more
      this.finish(l, "canceled", this.hub.closing ? { error: problem(503, "shutting-down", "The server stopped before the job was done").toJSON() } : {});
    } else if (!outcome.ok) this.finish(l, "failed", { error: this.failure(outcome.error, l.ctx) });
    else {
      const value = outcome.value;
      const r = resultSchema && this.checks ? resultSchema.safeParse(value) : undefined;
      if (r && !r.ok) this.finish(l, "failed", { error: this.contract("result", r.issues).toJSON() });
      else this.finish(l, "done", { result: value });
    }
  }

  /** A job breaks its contract in development: it fails, and the console says why. */
  private contract(what: "progress" | "result", issues: Issue[]): HttpProblem {
    const lines = issues.map((i) => `${i.path || `(${what})`} ${i.message}`).join("\n  ");
    console.error(`inkan: the job at ${this.path} sent a ${what} that breaks its contract:\n  ${lines}`);
    return problem(500, "job-contract", `The job's ${what} does not match its contract`, {
      errors: issues.map((i) => ({ in: what, path: i.path, message: i.message })),
    });
  }

  /** A problem as it is; anything else is a bug: reported, and a 500 problem without its message outside development. */
  private failure(err: unknown, ctx: Context<any, any, any, any, any>): ProblemBody {
    if (err instanceof HttpProblem) return err.toJSON();
    this.hub.report(err, ctx);
    const detail = this.hub.host.dev && err instanceof Error ? err.message : "Something went wrong on our side";
    return problem(500, "job-failed", detail).toJSON();
  }

  private finish(l: Live, state: JobState, patch: Partial<JobRecord>) {
    const wasRunning = l.rec.state === "running";
    const now = new Date();
    this.live.delete(l.rec.id);
    l.rec = { ...l.rec, ...patch, state, finishedAt: now, expiresAt: now.getTime() + this.keep, input: undefined, position: undefined, cancelRequested: undefined };
    this.save(l.rec);
    if (wasRunning) {
      this.running--;
      this.pump();
    }
  }

  // ----- shutdown -----

  /** Cancels every waiting job and ends every event stream. */
  closeDown() {
    for (const id of this.queue.splice(0)) {
      const l = this.live.get(id);
      if (l) this.finish(l, "canceled", { error: problem(503, "shutting-down", "The server stopped before the job started").toJSON() });
    }
    for (const poke of [...this.streams]) poke();
  }

  runs(): Promise<void>[] {
    return [...this.live.values()].flatMap((l) => (l.settled ? [l.settled] : []));
  }

  abortAll() {
    for (const l of this.live.values()) l.ctl?.abort(new DOMException("The server is shutting down", "AbortError"));
  }
}

/** A job as the routes answer with it: only what the contract lists. */
function view(r: JobRecord): JobBody {
  const v: JobBody = { id: r.id, state: r.state, createdAt: r.createdAt };
  if (r.progress !== undefined) v.progress = r.progress;
  if (r.position !== undefined && r.state === "queued") v.position = r.position;
  if (r.error) v.error = r.error;
  if (r.startedAt) v.startedAt = r.startedAt;
  if (r.finishedAt) v.finishedAt = r.finishedAt;
  return v;
}

/** The starting request's context, for the job: everything but its signal, which ended with the request. */
function jobContext<C extends object>(ctx: C): C {
  const c = Object.create(ctx);
  Object.defineProperty(c, "signal", {
    get() {
      throw new Error("job.ctx.signal belongs to the request that started the job, which is over: use job.signal");
    },
  });
  return c;
}

// ---------- defining one ----------

let warnedServerless = false;

/** `/exports` is `Exports`, `/daily-reports` is `DailyReports`. */
function nameOf(path: string): string {
  const last = path.split("/").filter((s) => s && !s.startsWith(":") && !s.startsWith("*")).pop() ?? "Background";
  return last.replace(/(^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_, __, c: string) => c.toUpperCase());
}

/** A params schema with every `:name` of the path, so none of them is stripped. */
function paramsOf(path: string) {
  return t.object(Object.fromEntries([...path.matchAll(/:(\w+)/g)].map((m) => [m[1]!, t.string()])));
}

type Define = (method: string, path: string, spec: object, handler: (ctx: any) => unknown) => void;

/** A job's `every`, read and checked when the job is defined, so a wrong one stops the start. */
function scheduleOf(path: string, full: string, opts: JobOptions<any, any, any, any>, ctxFor: (path: string) => Context<any, any, any, any, any>): Schedule {
  const every = typeof opts.every === "string" ? { cron: opts.every } : opts.every!;
  const where = `app.job("${path}")`;
  if (/:\w/.test(full)) throw new Error(`${where}: every needs a path without parameters, since no request names them`);
  let cron: Cron;
  try {
    cron = new Cron(every.cron);
  } catch (err) {
    throw new Error(`${where}: ${(err as Error).message}`);
  }
  const zone = every.timezone ?? "UTC";
  if (zone !== "UTC" && zone !== "local") throw new Error(`${where}: every.timezone is "UTC" or "local", not "${zone}"`);
  if (!cron.next(Date.now(), zone)) throw new Error(`${where}: the cron "${every.cron}" never matches`);
  let input = every.input;
  if (opts.body) {
    if (!("input" in every)) throw new Error(`${where}: the job takes a body, so every needs { cron, input } with the input to start it with`);
    const r = opts.body.safeParse(input);
    if (!r.ok) throw new Error(`${where}: every.input does not match the body: ${r.issues.map((i) => `${i.path || "(body)"} ${i.message}`).join("; ")}`);
    input = r.value;
  }
  return { cron, zone, input, ctx: () => ctxFor(full) };
}

/**
 * Defines a job's five routes on a scope. `prefix` is the scope's, `path` the job's own; the
 * routes go through `define`, so they are routes like any other.
 */
export function defineJob(
  hub: JobHub,
  define: Define,
  prefix: string,
  path: string,
  opts: JobOptions<any, any, any, any>,
  run: (job: Job<any, any, any>) => unknown,
  ctxFor: (path: string) => Context<any, any, any, any, any>,
) {
  const full = prefix ? joinPath(prefix, path) : joinPath("/", path);
  if (/(^|\/):id(\/|$)/.test(full)) throw new Error(`app.job("${path}"): the path has an :id already, and the job routes add their own`);
  if (hub.host.dev && !warnedServerless && (process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.VERCEL || process.env.NETLIFY)) {
    warnedServerless = true;
    console.warn("inkan: background jobs run in the process that started them; on a serverless platform it may be frozen or gone before they finish.");
  }
  const kind = new JobKind(hub, full, opts, run);
  if (opts.every !== undefined) kind.schedule = scheduleOf(path, full, opts, ctxFor);
  hub.kinds.push(kind);

  const name = opts.name ?? nameOf(full);
  const Job = t
    .object({
      id: t.string(),
      state: t.enum(["queued", "running", "done", "failed", "canceled"] as const),
      progress: (opts.progress ?? t.any()).optional(),
      position: t.int().optional().describe("Its place in the queue while it waits, 1 for next"),
      error: t.problem().optional(),
      createdAt: t.date(),
      startedAt: t.date().optional(),
      finishedAt: t.date().optional(),
    })
    .named(`${name}Job`);
  const Problem = t.problem();
  const shared = { tags: opts.tags, deprecated: opts.deprecated, hidden: opts.hidden, security: opts.security };
  const what = opts.summary ? `“${opts.summary}”` : "the job";

  // examples that build on the first one, so `inkan check` covers every route
  const own = (opts.examples ?? []).map((ex) => ({ ...ex, keep: { id: "body.id", ...ex.keep } }));
  if (!own.length && !opts.body) own.push({ name: "start", keep: { id: "body.id" } });
  const first = own[0];
  const after = first && `POST ${full} > ${first.name ?? "example 1"}`;
  const missing: Example = { name: "missing", params: { id: "missing" }, status: 404 };
  const chained = (name: string, extra: Partial<Example> = {}): Example[] => (after ? [{ name, after, params: { id: "{id}" }, ...extra }] : []);

  const byId = joinPath(path, "/:id");
  define(
    "POST",
    path,
    { ...shared, summary: opts.summary ?? `Starts ${what}`, description: opts.description, body: opts.body, response: { 202: Job, 503: Problem }, responseHeaders: { 202: { location: t.string() } }, examples: own },
    (ctx) => kind.start(ctx),
  );
  define("GET", byId, { ...shared, summary: `How ${what} stands`, params: paramsOf(full + "/:id"), response: { 200: Job, 404: Problem }, examples: [...chained("the job"), missing] }, (ctx) =>
    kind.status(ctx),
  );
  define(
    "GET",
    joinPath(path, "/:id/events"),
    {
      ...shared,
      summary: `Follows ${what}`,
      description: "A status first, then the latest progress as it changes, then the end; the stream closes after it.",
      params: paramsOf(full + "/:id/events"),
      response: { 200: t.events({ status: Job, progress: opts.progress ?? t.any(), end: Job }), 404: Problem },
      examples: [...chained("the job"), missing],
    },
    (ctx) => kind.events(ctx),
  );
  define(
    "GET",
    joinPath(path, "/:id/result"),
    {
      ...shared,
      summary: `The result of ${what}`,
      description: "`wait` waits up to that many seconds for the job to be over. A job not done yet is a 409.",
      params: paramsOf(full + "/:id/result"),
      query: t.object({ wait: t.int().min(0).max(30).optional() }),
      timeout: 0, // `wait` keeps its own clock (30 s at most); an app-wide timeout would cut it short
      response: { 200: opts.result ?? t.any(), 404: Problem, 409: Problem },
      examples: [...chained("the result", { query: { wait: 10 } }), missing],
    },
    (ctx) => kind.result(ctx),
  );
  define(
    "DELETE",
    byId,
    {
      ...shared,
      summary: `Cancels ${what}, or forgets it once it is over`,
      params: paramsOf(full + "/:id"),
      response: { 202: Job, 204: t.empty(), 404: Problem },
      examples: [...(after ? [{ name: "forget it once done", after: `GET ${joinPath(full, "/:id/result")} > the result`, params: { id: "{id}" }, status: 204 }] : []), missing],
    },
    (ctx) => kind.cancel(ctx),
  );
}

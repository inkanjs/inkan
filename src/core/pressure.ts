// Overload protection: a timer measures the process now and then and sets one boolean; a
// request only reads that boolean. An app without `pressure` has no timer and reads nothing.

import { monitorEventLoopDelay } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";

export type PressureOptions = {
  /** Milliseconds the event loop may lag (the 99th percentile since the last sample). */
  eventLoopDelay?: number;
  /** Bytes of V8 heap in use, or a share of the heap's limit such as `"90%"`. */
  heapUsed?: number | `${number}%`;
  /** Bytes of resident memory. */
  rss?: number;
  /** Seconds the 503 asks the client to wait, as `retry-after`. Default 10. */
  retryAfter?: number;
  /** Your own measure, run with every sample: true means under pressure. */
  check?: () => boolean;
  /** Paths that answer however loaded the server is, such as a health route. Default: none. */
  exempt?: string[];
  /** Milliseconds between samples. Default 1000. */
  interval?: number;
};

/** What the last sample found. */
export type PressureSample = {
  /** Whether requests are turned away right now. */
  under: boolean;
  /** Which limit was passed: "eventLoopDelay", "heapUsed", "rss" or "check". */
  reason?: string;
  /** Milliseconds, the 99th percentile since the sample before. */
  eventLoopDelay: number;
  heapUsed: number;
  rss: number;
  at: Date;
};

/** What one sample reads. A field of its own, so tests can put in numbers of their own. */
export type Measure = () => { eventLoopDelay: number; heapUsed: number; heapLimit: number; rss: number };

export class Gauge {
  /** The one thing a request reads. */
  under = false;
  sample: PressureSample = { under: false, eventLoopDelay: 0, heapUsed: 0, rss: 0, at: new Date() };
  readonly retryAfter: string;
  readonly exempt: Set<string>;
  measure: Measure;
  private opts: PressureOptions;
  private timer: ReturnType<typeof setInterval>;
  private histogram?: ReturnType<typeof monitorEventLoopDelay>;
  /** Turns a failing `check` into one console line, not one a second. */
  private warned = false;

  constructor(opts: PressureOptions) {
    this.opts = opts;
    this.retryAfter = String(opts.retryAfter ?? 10);
    this.exempt = new Set(opts.exempt ?? []);
    if (opts.eventLoopDelay !== undefined) {
      this.histogram = monitorEventLoopDelay({ resolution: 10 });
      this.histogram.enable();
    }
    const histogram = this.histogram;
    this.measure = () => {
      const heap = getHeapStatistics();
      return {
        eventLoopDelay: histogram ? histogram.percentile(99) / 1e6 : 0,
        heapUsed: heap.used_heap_size,
        heapLimit: heap.heap_size_limit,
        rss: process.memoryUsage.rss(),
      };
    };
    this.timer = setInterval(() => this.tick(), Math.max(10, opts.interval ?? 1000));
    this.timer.unref?.();
  }

  /** One sample: measures, compares, sets `under`. */
  tick() {
    const { eventLoopDelay, heapUsed, rss, check } = this.opts;
    const m = this.measure();
    this.histogram?.reset();
    let reason: string | undefined;
    if (eventLoopDelay !== undefined && m.eventLoopDelay > eventLoopDelay) reason = "eventLoopDelay";
    else if (heapUsed !== undefined && m.heapUsed > (typeof heapUsed === "string" ? (parseFloat(heapUsed) / 100) * m.heapLimit : heapUsed)) reason = "heapUsed";
    else if (rss !== undefined && m.rss > rss) reason = "rss";
    else if (check) {
      try {
        if (check()) reason = "check";
      } catch (err) {
        if (!this.warned) console.error("inkan: pressure.check threw; it counts as no pressure", err);
        this.warned = true;
      }
    }
    this.under = reason !== undefined;
    this.sample = { under: this.under, eventLoopDelay: Math.round(m.eventLoopDelay * 10) / 10, heapUsed: m.heapUsed, rss: m.rss, at: new Date() };
    if (reason) this.sample.reason = reason;
  }

  stop() {
    clearInterval(this.timer);
    this.histogram?.disable();
    this.under = false;
  }
}

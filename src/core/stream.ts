// Answers that are not one finished body: streams, server-sent events, and the
// files that examples upload.

import { Buffer } from "node:buffer"; // explicit, for runtimes without a global Buffer

export type SseEvent = { event?: string; data: unknown; id?: string; retry?: number };
export type EventSource = (signal: AbortSignal) => AsyncIterable<SseEvent>;

/** A server-sent event stream. Return it from a handler; see `sse()`. */
export class EventStream {
  source: EventSource;
  keepAlive: number;
  constructor(source: EventSource, keepAlive: number) {
    this.source = source;
    this.keepAlive = keepAlive;
  }
}

/**
 * Answers with server-sent events. The source gets an AbortSignal that fires when
 * the client goes away; stop there. A comment line goes out every `keepAlive` ms of
 * silence, so proxies do not close an idle stream.
 *
 *   return sse(async function* (signal) {
 *     while (!signal.aborted) yield { event: "tick", data: { at: Date.now() } };
 *   });
 */
export const sse = (source: EventSource, opts: { keepAlive?: number } = {}) => new EventStream(source, opts.keepAlive ?? 15_000);

export function formatEvent(e: SseEvent): string {
  const lines: string[] = [];
  if (e.event) lines.push(`event: ${e.event}`);
  if (e.id !== undefined) lines.push(`id: ${e.id}`);
  if (e.retry !== undefined) lines.push(`retry: ${e.retry}`);
  const data = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
  for (const line of (data ?? "").split("\n")) lines.push(`data: ${line}`);
  return lines.join("\n") + "\n\n";
}

/** Reads an event stream back, the way a browser's EventSource would. Comments are skipped. */
export function parseEvents(text: string): { event: string; data: unknown; id?: string }[] {
  const out: { event: string; data: unknown; id?: string }[] = [];
  for (const block of text.split(/\n\n/)) {
    const fields = block.split("\n").filter((l) => l && !l.startsWith(":"));
    if (!fields.length) continue;
    let event = "message";
    let id: string | undefined;
    const data: string[] = [];
    for (const line of fields) {
      const i = line.indexOf(":");
      const key = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (key === "event") event = value;
      else if (key === "id") id = value;
      else if (key === "data") data.push(value);
    }
    let parsed: unknown = data.join("\n");
    try {
      parsed = JSON.parse(parsed as string);
    } catch {}
    out.push(id === undefined ? { event, data: parsed } : { event, data: parsed, id });
  }
  return out;
}

const PING = Symbol("ping");

/** The wire format of a stream, with keep-alive comments and a check per event. */
export async function* encodeEvents(
  stream: EventStream,
  signal: AbortSignal,
  check?: (e: SseEvent) => string | undefined,
): AsyncGenerator<string> {
  const it = stream.source(signal)[Symbol.asyncIterator]();
  try {
    while (!signal.aborted) {
      const next = it.next();
      let r: IteratorResult<SseEvent> | typeof PING;
      do {
        let timer: NodeJS.Timeout | undefined;
        const ping = new Promise<typeof PING>((resolve) => (timer = setTimeout(() => resolve(PING), stream.keepAlive)));
        r = await Promise.race([next, ping]);
        clearTimeout(timer);
        if (r === PING) yield ": ping\n\n";
      } while (r === PING);
      if (r.done) return;
      const broken = check?.(r.value);
      if (broken) {
        yield formatEvent({ event: "error", data: { type: "response-contract", detail: broken } });
        return;
      }
      yield formatEvent(r.value);
    }
  } finally {
    await it.return?.();
  }
}

/** Is this something to stream rather than to send as one body? */
export function isStream(v: unknown): v is AsyncIterable<Uint8Array | string> {
  if (v === null || typeof v !== "object" || Buffer.isBuffer(v) || v instanceof Uint8Array) return false;
  return typeof (v as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function";
}

// ---------- files in examples ----------

export type FileExample = { $file: string; type: string; content: string };

/** A file for an example's body. A body with one in it is sent as multipart/form-data. */
export const fileExample = (name: string, content: string, type = "application/octet-stream"): FileExample => ({ $file: name, type, content });

const isFileExample = (v: unknown): v is FileExample => typeof v === "object" && v !== null && typeof (v as FileExample).$file === "string";

export const hasFiles = (body: unknown): boolean =>
  typeof body === "object" && body !== null && Object.values(body).some((v) => isFileExample(v) || (Array.isArray(v) && v.some(isFileExample)));

export function toFormData(body: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) {
    for (const item of Array.isArray(v) ? v : [v]) {
      if (isFileExample(item)) form.append(k, new Blob([item.content], { type: item.type }), item.$file);
      else if (item !== undefined) form.append(k, typeof item === "object" ? JSON.stringify(item) : String(item));
    }
  }
  return form;
}

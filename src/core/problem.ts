// Errors as RFC 9457 problem documents: every failure has the same shape,
// a stable `type` code to switch on, and a human `detail`.

import { STATUS_CODES } from "node:http";
import type { Issue } from "../schema/schema.ts";

export type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [extra: string]: unknown;
};

// A problem is an answer, not a crash: nobody reads its stack. So it is not built by the
// Error constructor, which records one even with `stackTraceLimit` at 0 and made every
// 404 and 400 cost sixty times what the object does. Its prototype chain still runs
// through Error.prototype, so `instanceof Error` holds and loggers print it as an error.
export class HttpProblem implements Error {
  name = "HttpProblem";
  message: string;
  status: number;
  type: string;
  title: string;
  detail?: string;
  extra: Record<string, unknown>;
  headers: Record<string, string>;

  constructor(
    status: number,
    type: string,
    detail?: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    this.message = detail ?? type;
    this.status = status;
    this.type = type;
    this.title = STATUS_CODES[status] ?? "Error";
    this.detail = detail;
    this.extra = extra;
    this.headers = headers;
  }

  /** The one line a stack would start with; there are no frames behind it. */
  get stack(): string {
    return `${this.name}: ${this.message}`;
  }

  toJSON(): ProblemBody {
    const body: ProblemBody = { type: this.type, title: this.title, status: this.status };
    if (this.detail) body.detail = this.detail;
    for (const key in this.extra) body[key] = this.extra[key];
    return body;
  }
}

Object.setPrototypeOf(HttpProblem.prototype, Error.prototype);

/** What `problem()` takes besides the status and the type. */
export type ProblemOptions = {
  /** For people: what went wrong, this time. */
  detail?: string;
  /** More members of the problem document: `{ errors: [...] }`, `{ balance: 30 }`. */
  extra?: Record<string, unknown>;
  /** Headers of the answer: `{ "retry-after": "10" }`. */
  headers?: Record<string, string>;
};

/**
 * Stops the handler with an error response: an RFC 9457 problem document.
 *
 *   throw problem(404, "user-not-found", `No user with id ${id}`)
 *   throw problem(429, "slow-down", { detail: "Ten a minute", headers: { "retry-after": "60" } })
 */
export function problem(status: number, type: string, detail?: string | ProblemOptions, extra?: Record<string, unknown>): HttpProblem {
  if (typeof detail !== "object") return new HttpProblem(status, type, detail, extra);
  return new HttpProblem(status, type, detail.detail, detail.extra ?? extra, detail.headers);
}

/** @internal */
export const validationProblem = (where: string, issues: Issue[]) =>
  new HttpProblem(400, "validation", `The ${where} does not match the contract`, {
    errors: issues.map((i) => ({ in: where, path: i.path, message: i.message })),
  });

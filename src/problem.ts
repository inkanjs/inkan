// Errors as RFC 9457 problem documents: every failure has the same shape,
// a stable `type` code to switch on, and a human `detail`.

import { STATUS_CODES } from "node:http";
import type { Issue } from "./schema.ts";

export type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [extra: string]: unknown;
};

export class HttpProblem extends Error {
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
    // A problem is an answer, not a crash: nobody reads its stack, and capturing one made
    // every 404 and 400 several times slower than a 200. So none is captured.
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    super(detail ?? type);
    Error.stackTraceLimit = limit;
    this.name = "HttpProblem";
    this.status = status;
    this.type = type;
    this.title = STATUS_CODES[status] ?? "Error";
    this.detail = detail;
    this.extra = extra;
    this.headers = headers;
  }

  toJSON(): ProblemBody {
    const body: ProblemBody = { type: this.type, title: this.title, status: this.status };
    if (this.detail) body.detail = this.detail;
    for (const key in this.extra) body[key] = this.extra[key];
    return body;
  }
}

/**
 * Stops the handler with an error response.
 *
 *   throw problem(404, "user-not-found", `No user with id ${id}`)
 */
export function problem(status: number, type: string, detail?: string, extra?: Record<string, unknown>) {
  return new HttpProblem(status, type, detail, extra);
}

export const validationProblem = (where: string, issues: Issue[]) =>
  new HttpProblem(400, "validation", `The ${where} does not match the contract`, {
    errors: issues.map((i) => ({ in: where, path: i.path, message: i.message })),
  });

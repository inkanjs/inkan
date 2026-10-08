// Request ids: unique without asking anyone, and cheap enough to give every request one.

import cluster from "node:cluster";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * Hands out request ids: a random prefix made once per process, the cluster worker's id when
 * there is one, and a counter in base 36, e.g. `0k3f9a2-1c8` or `0k3f9a2w3-1c8`. Not a UUID and
 * not meant to be unguessable: it has to be unique, and it is, per process and per worker.
 * One step of a counter costs far less than a random UUID.
 */
export function idSource(worker: number | undefined = cluster.isWorker ? cluster.worker?.id : undefined, prefix = randomPrefix()): () => string {
  const head = worker ? `${prefix}w${worker.toString(36)}-` : `${prefix}-`;
  let n = 0;
  return () => head + (++n).toString(36);
}

/** Seven base-36 characters from 32 random bits: a process that restarts starts somewhere else. */
const randomPrefix = () => randomBytes(4).readUInt32BE(0).toString(36).padStart(7, "0");

/** The one source of this process, for every app in it. */
export const nextId: () => string = randomUUID; // experiment: the id as before

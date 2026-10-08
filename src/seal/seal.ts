// Writing a seal file from an app, and putting a seal to work in one.

import type { RouteRecord } from "../core/route.ts";
import type { Schema } from "../schema/schema.ts";
import { compile, PRELUDE, SEAL_FORMAT, Unsealable, type Seal } from "./compile.ts";

/** Every schema a route's contract holds, with a label that says where it sits. */
function contractsOf(routes: RouteRecord[]): { label: string; schema: Schema<any> }[] {
  const out: { label: string; schema: Schema<any> }[] = [];
  for (const r of routes) {
    const at = `${r.method} ${r.path}`;
    for (const part of ["params", "query", "headers", "body"] as const) {
      const schema = r.spec[part] as Schema<any> | undefined;
      if (schema) out.push({ label: `${at} · ${part}`, schema });
    }
    for (const [status, schema] of Object.entries(r.spec.response ?? {})) out.push({ label: `${at} · response ${status}`, schema });
  }
  return out;
}

export type SealReport = {
  /** The seal file, a JavaScript module. */
  code: string;
  /** Contracts in the file; equal contracts share one entry. */
  sealed: number;
  entries: number;
  /** Contracts the seal cannot write yet, and why. They run as they always did. */
  unsealable: { label: string; reason: string }[];
};

/** The seal file for these routes. `from` only goes into the header, to say how to make it again. */
export function writeSeal(routes: RouteRecord[], from: string): SealReport {
  const entries = new Map<string, { source: string; labels: string[] }>();
  const unsealable: SealReport["unsealable"] = [];
  let sealed = 0;
  for (const { label, schema } of contractsOf(routes)) {
    let compiled: { source: string; hash: string };
    try {
      compiled = compile(schema);
    } catch (err) {
      if (!(err instanceof Unsealable)) throw err;
      unsealable.push({ label, reason: err.message });
      continue;
    }
    sealed++;
    const entry = entries.get(compiled.hash);
    if (entry) entry.labels.push(label);
    else entries.set(compiled.hash, { source: compiled.source, labels: [label] });
  }
  const body = [...entries].map(([hash, e]) => `${e.labels.map((l) => `    // ${l}`).join("\n")}\n    ${JSON.stringify(hash)}: ${e.source.replace(/\n/g, "\n    ")},`);
  const code = `// The seal of ${from}: its contracts, stamped into plain code by \`inkan seal\`.
// Do not edit it. When a contract changes, run \`npx inkan seal ${from}\` again; until then
// that contract runs unsealed, as it would without this file, and inkan says so at start.
// Every entry checks and writes one contract, and is used only while its hash matches.
// No eval, nothing imported, nothing fetched: what you read here is what runs.

${PRELUDE}

export default {
  inkan: ${SEAL_FORMAT},
  entries: {
${body.join("\n\n")}
  },
};
`;
  return { code, sealed, entries: entries.size, unsealable };
}

export type SealState = { sealed: number; stale: string[]; unsealable: number; wrongFormat?: boolean };

/**
 * Puts the seal's code to work for every contract it holds a matching entry for. A contract
 * whose code hashes to something the seal does not have changed since the seal was made:
 * it keeps running unsealed, and is reported.
 */
export function applySeal(seal: Seal, routes: RouteRecord[]): SealState {
  const state: SealState = { sealed: 0, stale: [], unsealable: 0 };
  if (seal?.inkan !== SEAL_FORMAT || typeof seal.entries !== "object") return { ...state, wrongFormat: true };
  const seen = new Set<Schema<any>>();
  for (const { label, schema } of contractsOf(routes)) {
    if (seen.has(schema) || schema._sealedBy === seal) {
      if (schema._sealedBy === seal) state.sealed++;
      continue;
    }
    seen.add(schema);
    let hash: string;
    try {
      hash = compile(schema).hash;
    } catch (err) {
      if (!(err instanceof Unsealable)) throw err;
      state.unsealable++;
      continue;
    }
    const entry = Object.hasOwn(seal.entries, hash) ? seal.entries[hash] : undefined;
    if (!entry) {
      state.stale.push(label);
      continue;
    }
    schema._seal(seal, entry.parse);
    state.sealed++;
  }
  return state;
}

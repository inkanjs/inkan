// Version ranges, as npm writes them, for `plugin(fn, { inkan: ">=0.7.0 <0.8.0" })`.
//
// Enough of node-semver to read a peer range: exact versions, <, <=, >, >=, =, ^, ~,
// x-ranges (0.7.x, 0.7, *), hyphen ranges (1.2.3 - 1.4), spaces for AND and || for OR.
// A prerelease satisfies a range only when one of its comparators names a prerelease of
// the same major.minor.patch, as npm decides it: 1.0.0-rc.1 is not >=0.9.0.

/** A version taken apart: major, minor, patch, and the prerelease identifiers. */
export type Version = { major: number; minor: number; patch: number; pre: (string | number)[] };

type Op = "<" | "<=" | ">" | ">=" | "=";
type Comparator = { op: Op; v: Version };

const NUM = "0|[1-9]\\d*";
const PRE = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
const VERSION = new RegExp(`^v?(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE}))?(?:\\+${PRE})?$`);
const PART = `${NUM}|[xX*]`;
const PARTIAL = new RegExp(`^v?(${PART})(?:\\.(${PART})(?:\\.(${PART})(?:-(${PRE}))?(?:\\+${PRE})?)?)?$`);
const COMPARATOR = /^(<=|>=|<|>|=|\^|~>?)?(.*)$/;

const preOf = (s: string | undefined): (string | number)[] => (s ? s.split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : []);

/** Reads `1.2.3`, `v1.2.3-rc.1+build`; undefined for anything else. */
export function parseVersion(text: string): Version | undefined {
  const m = VERSION.exec(text.trim());
  if (!m) return undefined;
  if (m[4]?.split(".").some((id) => /^0\d+$/.test(id))) return undefined; // 1.0.0-01 is not a version
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: preOf(m[4]) };
}

/** -1, 0 or 1; build metadata does not count, a prerelease comes before its release. */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1; // numeric identifiers come before alphanumeric ones
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

const v = (major: number, minor: number, patch: number, pre: (string | number)[] = []): Version => ({ major, minor, patch, pre });
/** The lowest version of a release line: `<2.0.0-0` keeps out 2.0.0's prereleases as well. */
const floor = (major: number, minor: number, patch: number) => v(major, minor, patch, [0]);
const ANY: Comparator[] = [];
const NONE: Comparator[] = [{ op: "<", v: floor(0, 0, 0) }];

/** One comparator, `^1.2`, `>=0.7.0`, `0.7.x`, as the plain comparators it stands for. */
function comparator(token: string, range: string): Comparator[] {
  const [, op = "", rest] = COMPARATOR.exec(token)!;
  const m = PARTIAL.exec(rest);
  if (!m) throw invalid(range);
  const wild = (s: string | undefined) => s === undefined || s === "x" || s === "X" || s === "*";
  const [M, mi, p] = [m[1], m[2], m[3]].map((s) => (wild(s) ? undefined : Number(s)));
  // a wildcard ends the version: 1.x.3 is not a range
  if ((M === undefined && (mi !== undefined || p !== undefined)) || (mi === undefined && p !== undefined)) throw invalid(range);
  const pre = preOf(m[4]);
  if (pre.length && p === undefined) throw invalid(range);
  const full = p !== undefined;
  const lo = v(M ?? 0, mi ?? 0, p ?? 0, pre);

  switch (op) {
    case "":
    case "=":
      if (full) return [{ op: "=", v: lo }];
      if (M === undefined) return ANY;
      return [{ op: ">=", v: lo }, { op: "<", v: mi === undefined ? floor(M + 1, 0, 0) : floor(M, mi + 1, 0) }];
    case "^": {
      if (M === undefined) return ANY;
      let hi: Version;
      if (M > 0 || mi === undefined) hi = floor(M + 1, 0, 0);
      else if (mi > 0 || p === undefined) hi = floor(0, mi + 1, 0);
      else hi = floor(0, 0, p + 1);
      return [{ op: ">=", v: lo }, { op: "<", v: hi }];
    }
    case "~":
    case "~>":
      if (M === undefined) return ANY;
      return [{ op: ">=", v: lo }, { op: "<", v: mi === undefined ? floor(M + 1, 0, 0) : floor(M, mi + 1, 0) }];
    case ">":
      if (M === undefined) return NONE;
      if (full) return [{ op: ">", v: lo }];
      return [{ op: ">=", v: mi === undefined ? v(M + 1, 0, 0) : v(M, mi + 1, 0) }];
    case ">=":
      return M === undefined ? ANY : [{ op: ">=", v: lo }];
    case "<":
      if (M === undefined) return NONE;
      return [{ op: "<", v: full ? lo : floor(M, mi ?? 0, 0) }];
    case "<=":
      if (M === undefined) return ANY;
      if (full) return [{ op: "<=", v: lo }];
      return [{ op: "<", v: mi === undefined ? floor(M + 1, 0, 0) : floor(M, mi + 1, 0) }];
  }
  throw invalid(range);
}

const invalid = (range: string) => new TypeError(`"${range}" is not a version range`);

/** `1.2 - 2.3.4`: from the first, filled with zeros, up to the second, as far as it is given. */
function hyphen(from: string, to: string, range: string): Comparator[] {
  const lo = comparator(from, range);
  const hi = comparator(to, range);
  const start = lo.length === 1 && lo[0].op === "=" ? [{ op: ">=" as Op, v: lo[0].v }] : lo.filter((c) => c.op === ">=");
  const end = hi.length === 1 && hi[0].op === "=" ? [{ op: "<=" as Op, v: hi[0].v }] : hi.filter((c) => c.op === "<");
  return [...start, ...end];
}

/** A range as sets of comparators: a version that passes every comparator of one set is in it. */
export function parseRange(range: string): Comparator[][] {
  if (typeof range !== "string") throw invalid(String(range));
  return range.split("||").map((part) => {
    // npm lets the operator stand apart from its version: ">= 1.2.3"
    const tokens = part.trim().replace(/(<=|>=|<|>|=|\^|~>?)\s+/g, "$1").split(/\s+/).filter(Boolean);
    if (!tokens.length) return ANY; // "" is "*", as for npm
    if (tokens.length === 3 && tokens[1] === "-") {
      if (/^[<>=^~]/.test(tokens[0]) || /^[<>=^~]/.test(tokens[2])) throw invalid(range);
      return hyphen(tokens[0], tokens[2], range);
    }
    if (tokens.includes("-")) throw invalid(range);
    return tokens.flatMap((t) => comparator(t, range));
  });
}

function passes(c: Comparator, version: Version): boolean {
  const d = compareVersions(version, c.v);
  switch (c.op) {
    case "<": return d < 0;
    case "<=": return d <= 0;
    case ">": return d > 0;
    case ">=": return d >= 0;
    case "=": return d === 0;
  }
}

function inSet(set: Comparator[], version: Version): boolean {
  for (const c of set) if (!passes(c, version)) return false;
  if (!version.pre.length) return true;
  // a prerelease only where the range asks for one of the same release
  return set.some((c) => c.v.pre.length > 0 && c.v.major === version.major && c.v.minor === version.minor && c.v.patch === version.patch);
}

/**
 * Whether `version` is in `range`, as npm reads ranges. Throws a TypeError for a range it
 * cannot read; a version that is not one is in no range.
 *
 *   satisfies("0.7.2", ">=0.7.0 <0.8.0")   // true
 *   satisfies("0.8.0-rc.1", "^0.7.0")      // false: a prerelease needs a range that names one
 */
export function satisfies(version: string, range: string): boolean {
  const sets = parseRange(range);
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return sets.some((set) => inSet(set, parsed));
}

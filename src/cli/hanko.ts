// `inkan hanko [query]`: the plugins from inkan.dev/hanko in the terminal, to search and install.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { paint } from "../core/color.ts";
import { detectManager, type Manager } from "./app.ts";
import { banner, Cancelled, gradient, search, select, type Found, type Io } from "./prompt.ts";

export const HANKO_URL = process.env.INKAN_HANKO_URL ?? "https://inkan-dev.vercel.app/hanko.json";
// the official packages carry "inkan", community ones "inkan-plugin" (which the search also matches)
const NPM_SEARCH = "https://registry.npmjs.org/-/v1/search?text=keywords:inkan&size=250";
const NOT_PLUGINS = new Set(["@inkanjs/inkan", "create-inkan"]);

export type Kind = { kind: string; label: string; note: string };
export type Plugin = {
  name: string;
  description: string;
  kind: string;
  href: string;
  npm?: string;
  repo?: string;
  tags?: string[];
  code?: string;
  since?: string;
  version?: string;
  published?: string;
  weekly?: number;
  deps?: number;
};
export type Catalog = { kinds: Kind[]; plugins: Plugin[]; source: "inkan.dev" | "npm" };

type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

async function get(fetcher: Fetch, url: string): Promise<unknown> {
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(6000), headers: { accept: "application/json", "user-agent": "inkan-cli" } });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

type NpmSearch = { objects?: { package: { name: string; description?: string; keywords?: string[]; version?: string; links?: { npm?: string } } }[] };

/** inkan.dev's list; npm's keyword search alone when the site does not answer. */
export async function loadCatalog(fetcher: Fetch = fetch as Fetch, url = HANKO_URL): Promise<Catalog | undefined> {
  const site = (await get(fetcher, url)) as Partial<Catalog> | undefined;
  if (site && Array.isArray(site.plugins) && Array.isArray(site.kinds)) return { kinds: site.kinds, plugins: site.plugins, source: "inkan.dev" };
  const npm = (await get(fetcher, NPM_SEARCH)) as NpmSearch | undefined;
  if (!npm?.objects) return undefined;
  const plugins = npm.objects
    .map(({ package: p }) => p)
    .filter((p) => !NOT_PLUGINS.has(p.name) && (p.name.startsWith("@inkanjs/") || p.keywords?.some((k) => k.toLowerCase() === "inkan-plugin")))
    .map((p): Plugin => ({
      name: p.name,
      description: p.description?.trim() || "No description on npm yet.",
      kind: p.name.startsWith("@inkanjs/") ? "official" : "community",
      href: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`,
      npm: p.name,
      tags: (p.keywords ?? []).filter((k) => !/^inkan(-plugin)?$/i.test(k)).slice(0, 6),
      version: p.version,
    }));
  const kinds = [...new Set(plugins.map((p) => p.kind))].map((kind) => ({ kind, label: kind, note: "" }));
  return { kinds, plugins, source: "npm" };
}

/** Name first, then tags, then the description; every word of the query has to be somewhere. */
export function find(plugins: Plugin[], query: string, kind?: string): Plugin[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: { p: Plugin; score: number }[] = [];
  for (const p of plugins) {
    if (kind && p.kind !== kind) continue;
    const name = p.name.toLowerCase();
    const tags = (p.tags ?? []).join(" ").toLowerCase();
    const text = p.description.toLowerCase();
    let score = 0;
    const all = words.every((w) => {
      const hit = name === w ? 100 : name.includes(w) ? 40 : tags.includes(w) ? 15 : text.includes(w) ? 5 : 0;
      score += hit;
      return hit > 0;
    });
    if (all) scored.push({ p, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((x) => x.p);
}

const installArgs = (pm: Manager, pkg: string) => (pm === "npm" ? ["install", pkg] : ["add", pkg]);
export const installCommand = (pm: Manager, pkg: string) => [pm, ...installArgs(pm, pkg)].join(" ");

const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/** The card for one plugin: what it is, where it lives, how it gets in. */
export function card(p: Plugin, kinds: Kind[], color: boolean, pm: Manager = "npm"): string {
  const c = paint(color);
  const label = kinds.find((k) => k.kind === p.kind)?.label ?? p.kind;
  const facts = [
    p.version && `v${p.version}`,
    p.weekly !== undefined && `${compact(p.weekly)}/week`,
    p.deps !== undefined && `${p.deps} deps`,
    p.published,
    p.since && `needs inkan ${p.since}`,
  ].filter(Boolean);
  const lines = [
    `  ${gradient(p.name, color)}  ${c.dim(label)}${facts.length ? c.dim("  ·  " + facts.join(" · ")) : ""}`,
    `  ${p.description}`,
    ...(p.tags?.length ? [`  ${c.dim(p.tags.map((t) => "#" + t.replace(/\s+/g, "-")).join(" "))}`] : []),
    "",
    ...(p.code ? [`  ${c.dim("│")} ${p.code}`] : []),
    ...(p.npm ? [`  ${c.dim("│")} ${installCommand(pm, p.npm)}`] : []),
    `  ${c.dim("│")} ${c.link(p.href)}`,
    ...(p.repo && p.repo !== p.href ? [`  ${c.dim("│")} ${c.link(p.repo)}`] : []),
  ];
  return `\n${lines.join("\n")}\n`;
}

export const HANKO_HELP = (c: ReturnType<typeof paint>) => `
  ${c.seal("印")} ${c.bold("inkan hanko")} ${c.dim("[query] [options]")}   ${c.dim("plugins, middleware and stores from inkan.dev/hanko")}

  ${c.bold("--kind")} ${c.dim("<k>")}    built-in | middleware | store | integration | recipe | community
  ${c.bold("--json")}        ${c.dim("the matches as JSON")}

  ${c.dim("In a terminal it asks: a kind, then a search as you type, then what to do with it.")}
`;

type Ctx = { color: boolean; fail: (msg: string) => never; fetch?: Fetch; io?: Io; tty?: boolean; cwd?: string };

/** `inkan hanko …` with `args` after "hanko"; resolves with the exit code. */
export async function runHanko(args: string[], ctx: Ctx): Promise<number> {
  const c = paint(ctx.color);
  let kind: string | undefined;
  let json = false;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") {
      console.log(HANKO_HELP(c));
      return 0;
    } else if (a === "--json") json = true;
    else if (a === "--kind") kind = args[++i];
    else if (a.startsWith("--kind=")) kind = a.slice("--kind=".length);
    else if (a.startsWith("-")) ctx.fail(`There is no option ${a}. inkan hanko --help lists them.`);
    else words.push(a);
  }
  const query = words.join(" ");

  const catalog = await loadCatalog(ctx.fetch);
  if (!catalog) return ctx.fail("Neither inkan.dev nor npm answered. Offline? The list is at https://inkan-dev.vercel.app/hanko");
  const { kinds, plugins } = catalog;
  if (kind && !kinds.some((k) => k.kind === kind)) ctx.fail(`--kind takes one of ${kinds.map((k) => k.kind).join(", ")}, not "${kind}".`);
  const pm = detectManager();
  const tty = ctx.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (json || !tty) {
    const hits = find(plugins, query, kind);
    if (json) {
      console.log(JSON.stringify(hits, null, 2));
      return 0;
    }
    if (!hits.length) {
      console.log(`\n  ${c.dim(`Nothing for "${query}". Everything: inkan hanko --json`)}\n`);
      return 1;
    }
    for (const k of kinds) {
      const group = hits.filter((p) => p.kind === k.kind);
      if (!group.length) continue;
      console.log(`\n  ${c.bold(k.label)} ${c.dim(`(${group.length})`)}`);
      const pad = Math.max(...group.map((p) => p.name.length)) + 2;
      for (const p of group) console.log(`  ${c.dim("│")} ${p.name.padEnd(pad)}${c.dim(p.description)}`);
    }
    if (catalog.source === "npm") console.log(`\n  ${c.dim("inkan.dev did not answer: this is npm's list alone, without built-ins and recipes.")}`);
    console.log("");
    return 0;
  }

  const io = ctx.io ?? { input: process.stdin, output: process.stdout, color: ctx.color };
  const labelOf = (p: Plugin) => kinds.find((k) => k.kind === p.kind)?.label ?? p.kind;
  console.log(banner(ctx.color, "inkan hanko", `${plugins.length} things to stamp onto an app`));
  try {
    if (!kind && !query) {
      kind = await select(
        io,
        "what are you looking for?",
        [
          { value: "", label: "everything", hint: String(plugins.length) },
          ...kinds.map((k) => ({ value: k.kind, label: k.label, hint: `${plugins.filter((p) => p.kind === k.kind).length}  ${k.note}` })),
        ],
        "",
      );
    }
    for (;;) {
      const picked = await search<Plugin>(
        io,
        "search",
        (q) => find(plugins, q, kind || undefined).map((p): Found<Plugin> => ({ value: p, label: p.name, badge: kind ? undefined : labelOf(p), hint: p.description })),
        { query },
      );
      console.log(card(picked, kinds, ctx.color, pm));
      const inProject = existsSync(join(ctx.cwd ?? process.cwd(), "package.json"));
      const action = await select(io, "and now?", [
        ...(picked.npm && inProject ? [{ value: "install", label: "install", hint: installCommand(pm, picked.npm) }] : []),
        { value: "again", label: "search again" },
        { value: "done", label: "done" },
      ]);
      if (action === "done") return 0;
      if (action === "install") {
        // npm and the others are .cmd files on Windows, which only a shell starts
        const r = spawnSync(pm, installArgs(pm, picked.npm!), { cwd: ctx.cwd, stdio: "inherit", shell: process.platform === "win32" });
        if (r.status !== 0) {
          console.log(`\n  ${c.warn(`${pm} did not finish.`)}\n`);
          return 1;
        }
        console.log(`\n  ${c.ok("✔")} ${picked.npm} ${c.dim("is in.")} ${c.dim(picked.href)}\n`);
        return 0;
      }
    }
  } catch (err) {
    if (err instanceof Cancelled) return 130;
    throw err;
  }
}

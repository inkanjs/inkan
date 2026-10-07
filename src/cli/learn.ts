// `inkan learn`: an interactive tutorial in the terminal. It sets up a practice app, explains
// one idea at a time, and checks every quest after every save of the file.
//
// The practice folder links to the installed inkan instead of installing it, so it works at
// once and offline. The app runs on a port while you learn, for the docs page and the
// inspector; the quests themselves check it through inject.

import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { App } from "../core/app.ts";
import { paint, useColor } from "../core/color.ts";
import { writeSeal } from "../seal/seal.ts";
import { QUESTS, type QuestContext } from "./quests.ts";

export const STARTER = `// 印 inkan learn: your practice app. inkan reads this file again every time you save it
// and checks the quest you are on. Change whatever you like; nothing here is precious.
import { inkan, plugin, problem, routes, t } from "@vxnsin/inkan";

const teas = [
  { id: 1, name: "Sencha", grams: 50 },
  { id: 2, name: "Gyokuro", grams: 30 },
];

export const app = inkan({ title: "Tea Shop" });

app.get("/teas", () => teas);

// your routes go here
`;

const PROGRESS = ".inkan-learn.json";
type Progress = { quest: number };

export class LearnError extends Error {}

/** The package this command runs from: its root folder and its name. */
function ownPackage() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  return { root, name: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name as string };
}

/**
 * Creates the practice folder, or finds one made before. inkan is linked into its
 * node_modules rather than installed, so it runs at once, offline, on this very version.
 */
export function setupLearn(dir: string, opts: { force?: boolean } = {}): { created: boolean } {
  const to = resolve(dir);
  if (existsSync(join(to, PROGRESS))) return { created: false };
  if (existsSync(to) && readdirSync(to).length && !opts.force) {
    throw new LearnError(`${relative(process.cwd(), to) || "."} is not empty. Pick another folder, or add --force to use it anyway.`);
  }
  const pkg = ownPackage();
  mkdirSync(join(to, "src"), { recursive: true });
  writeFileSync(join(to, "src", "app.ts"), STARTER);
  writeFileSync(
    join(to, "package.json"),
    JSON.stringify({ name: "inkan-learn", private: true, type: "module", scripts: { learn: "inkan learn ." } }, null, 2) + "\n",
  );
  writeFileSync(join(to, ".gitignore"), "node_modules/\n");
  const link = join(to, "node_modules", ...pkg.name.split("/"));
  mkdirSync(dirname(link), { recursive: true });
  if (!existsSync(link)) symlinkSync(pkg.root, link, "junction"); // a junction needs no rights on Windows
  writeFileSync(join(to, PROGRESS), JSON.stringify({ quest: 0 } satisfies Progress) + "\n");
  return { created: true };
}

/** Runs the tutorial in `dir` until every quest is done or you quit. */
export async function learn(dir: string, opts: { port?: number } = {}): Promise<void> {
  const c = paint(useColor());
  const to = resolve(dir);
  const file = join(to, "src", "app.ts");
  const progressFile = join(to, PROGRESS);
  const progress: Progress = JSON.parse(readFileSync(progressFile, "utf8"));
  const save = () => writeFileSync(progressFile, JSON.stringify(progress) + "\n");
  const port = opts.port ?? 3333;
  const url = `http://localhost:${port}`;
  const seen = { fromDocs: false };
  let app: App | undefined;
  let hint = 0;
  let loads = 0;
  let checking = Promise.resolve();
  process.env.INKAN_NO_LISTEN = "1"; // an app.listen() in the practice file stays quiet: learn serves it

  // the practice app on a port, whatever version of it was loaded last
  const server: Server = createServer((req, res) => (app ? app.listener(req, res) : res.writeHead(503).end()));
  await new Promise<void>((ok, fail) => server.once("error", fail).listen(port, ok)).catch(() => {
    throw new LearnError(`Port ${port} is taken. Start with --port <another one>.`);
  });

  const out = (s = "") => console.log(s);
  const indent = (s: string) => s.split("\n").map((l) => "  " + l).join("\n");
  const show = () => {
    const q = QUESTS[progress.quest];
    out(`\n  ${c.seal("印")} ${c.bold("inkan learn")} ${c.dim(`· quest ${progress.quest + 1} of ${QUESTS.length} ·`)} ${c.bold(q.title)}\n`);
    out(c.dim(indent(q.teach)) + "\n");
    out(indent(q.task) + "\n");
    out(c.dim(`  edit ${relative(process.cwd(), file)} and save · your app runs on ${url}`));
    out(c.dim(`  h hint · r check again · s skip · o save openapi.json · w write the seal · q quit\n`));
  };

  async function load(): Promise<App | undefined> {
    try {
      const mod = await import(`${pathToFileURL(file).href}?v=${++loads}`);
      const fresh = (mod.app ?? mod.default) as App | undefined;
      if (!fresh || typeof fresh.inject !== "function") {
        out(`  ${c.warn("!")} src/app.ts has to export the app: export const app = inkan(…)`);
        return;
      }
      await fresh.ready();
      fresh.options.log = false; // the quests send many requests; their log lines would bury the text
      fresh.onResponse((ctx) => {
        const ref = (ctx.headers as Record<string, string | undefined>).referer ?? "";
        if (ref.includes("/docs") && !seen.fromDocs) {
          seen.fromDocs = true;
          void run();
        }
      });
      return fresh;
    } catch (err) {
      out(`  ${c.warn("!")} src/app.ts does not load: ${(err as Error).message.split("\n")[0]}`);
    }
  }

  async function check() {
    if (!app || progress.quest >= QUESTS.length) return;
    const q = QUESTS[progress.quest];
    const ctx: QuestContext = { app, dir: to, seen, url };
    let result: true | string;
    try {
      result = await q.check(ctx);
    } catch (err) {
      result = `the check broke on something: ${(err as Error).message}`;
    }
    if (result !== true) return out(`  ${c.warn("✗")} ${result}`);
    out(`  ${c.ok("✓")} ${c.bold(`quest ${progress.quest + 1} done!`)} ${c.dim(q.title)}`);
    advance();
  }

  function advance() {
    progress.quest++;
    hint = 0;
    save();
    if (progress.quest >= QUESTS.length) {
      out(`\n  ${c.seal("印")} ${c.bold("Every quest done.")} You know contracts, problems, groups, security, hooks,`);
      out(`  the docs page, inkan diff, the seal and plugins. Start a real one: ${c.link("npx @vxnsin/inkan examples")}\n`);
      return quit(0);
    }
    show();
    void run(); // the change that solved one quest may solve the next too
  }

  // one check at a time, in the order they were asked for
  function run() {
    checking = checking.then(check);
    return checking;
  }

  function quit(code: number) {
    server.closeAllConnections();
    server.close();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(code);
  }

  show();
  app = await load();
  await run();

  let pending: ReturnType<typeof setTimeout> | undefined;
  // the real, long path: Windows short names (LUIS~1) make libuv's watcher fail an assertion
  watch(realpathSync.native(join(to, "src")), { recursive: true }, (_event, name) => {
    if (name && String(name).startsWith("inkan.seal")) return; // written by w; the app picks it up on its next save
    clearTimeout(pending);
    pending = setTimeout(async () => {
      const fresh = await load();
      if (!fresh) return;
      app = fresh;
      void run();
    }, 120);
  });

  if (!process.stdin.isTTY) return; // without a terminal: watch and check, no keys
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (key: string) => {
    const q = QUESTS[progress.quest];
    if (key === "q" || key === "\u0003") return quit(0);
    if (key === "h") {
      const h = q.hints[Math.min(hint, q.hints.length - 1)].replaceAll("{url}", url);
      hint++;
      return out(`\n  ${c.dim("hint:")}\n${indent(h)}\n`);
    }
    if (key === "s") {
      out(`  ${c.dim("skipped")}`);
      return advance();
    }
    if (key === "r") return void run();
    if (key === "o" && app) {
      writeFileSync(join(to, "openapi.json"), JSON.stringify(app.openapi(), null, 2) + "\n");
      out(`  ${c.ok("wrote")} openapi.json`);
      return void run();
    }
    if (key === "w" && app) {
      const report = writeSeal(app.routes(), "src/app.ts");
      writeFileSync(join(to, "src", "inkan.seal.js"), report.code);
      writeFileSync(join(to, "src", "inkan.seal.d.ts"), `declare const seal: import("${ownPackage().name}").Seal;\nexport default seal;\n`);
      return out(`  ${c.ok("wrote")} src/inkan.seal.js ${c.dim(`(${report.sealed} contracts)`)}`);
    }
  });
}

// The public API as its types say it: the declarations of the package's entries and of every
// file they reach, after `stripInternal`. Committed as api/inkan.d.ts.txt, so a change to the
// API shows in review; test/api.test.ts fails when the file is out of date.
//
//   node scripts/api.mjs           prints the surface
//   node scripts/api.mjs --update  writes api/inkan.d.ts.txt (npm run api:update)

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ENTRIES = ["index.d.ts", "client.d.ts", "testing.d.ts"];
export const SNAPSHOT = join(root, "api", "inkan.d.ts.txt");

/** The surface as one text: every reached declaration file, by its path, in a fixed order. */
export function surface() {
  const out = mkdtempSync(join(tmpdir(), "inkan-api-"));
  try {
    const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
    execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json"), "--outDir", out, "--emitDeclarationOnly"], { stdio: "pipe" });
    const seen = new Set();
    const todo = ENTRIES.map((e) => join(out, e));
    while (todo.length) {
      const file = todo.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      // what a comment mentions is not imported
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const m of code.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) {
        todo.push(resolve(dirname(file), m[1].replace(/\.ts$/, ".d.ts").replace(/\.js$/, ".d.ts")));
      }
    }
    return [...seen]
      .map((f) => relative(out, f).replaceAll("\\", "/"))
      .sort()
      .map((f) => `// ---- ${f}\n${readFileSync(join(out, f), "utf8").replaceAll("\r\n", "\n").trimEnd()}\n`)
      .join("\n");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = surface();
  if (process.argv.includes("--update")) {
    writeFileSync(SNAPSHOT, text);
    console.log(`wrote ${relative(root, SNAPSHOT)}`);
  } else process.stdout.write(text);
}

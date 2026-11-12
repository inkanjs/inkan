#!/usr/bin/env node
// npm create inkan [folder] -- [options]: hands everything to `inkan create app` of the
// @inkanjs/inkan this package depends on, at its own version, so the templates and the
// CLI that writes them always match. The work is all there; this only finds it.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const CORE = "@inkanjs/inkan";

const require = createRequire(import.meta.url);
const manifest = require.resolve(`${CORE}/package.json`);
const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
const cli = join(dirname(manifest), typeof bin === "string" ? bin : bin.inkan);

const r = spawnSync(process.execPath, [cli, "create", "app", ...process.argv.slice(2)], { stdio: "inherit" });
if (r.error) {
  console.error(`create-inkan: could not start ${CORE}: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);

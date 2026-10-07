import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inkan, plugin, problem, routes, t, type App, type Seal } from "../src/index.ts";
import { QUESTS } from "../src/cli/quests.ts";
import { LearnError, setupLearn, STARTER } from "../src/cli/learn.ts";
import { writeSeal } from "../src/seal/seal.ts";

/**
 * The practice app as it looks once quest `done` is solved, built the way the hints say:
 * every quest's solution sits on top of the ones before it.
 */
function solved(done: number, seal?: Seal): App {
  const teas = [
    { id: 1, name: "Sencha", grams: 50 },
    { id: 2, name: "Gyokuro", grams: 30 },
  ];
  const app = inkan({ title: "Tea Shop", log: false, seal: done >= 10 ? seal : undefined });
  app.get("/teas", () => teas);
  if (done >= 0) app.get("/hello", () => ({ hello: "world" }));
  if (done >= 1)
    app.get("/teas/:id", { params: t.object({ id: t.int() }) }, ({ params }) => {
      const tea = teas.find((x) => x.id === params.id);
      if (done >= 4 && !tea) throw problem(404, "tea-not-found", `There is no tea ${params.id}`);
      return tea;
    });
  if (done >= 2) {
    const Tea = t.object({ id: t.int(), name: t.string(), grams: t.int() });
    app.post(
      "/teas",
      {
        body: t.object({ name: t.string().min(1), grams: t.int().min(done >= 9 ? 10 : 1) }),
        response: { 201: Tea },
        examples: done >= 3 ? [{ name: "a new tea", body: { name: "Bancha", grams: 40 } }] : undefined,
      },
      ({ body }) => {
        const tea = { id: teas.length + 1, ...body };
        teas.push(tea);
        return tea;
      },
    );
  }
  if (done >= 5) {
    const admin = (done >= 6 ? routes().security("bearer") : routes()).get("/stats", () => ({ teas: teas.length }));
    app.mount("/admin", admin);
  }
  if (done >= 7) app.onSend((_ctx, answer) => void (answer.headers["x-tea"] = "yes"));
  if (done >= 11) app.register(plugin((p) => void p.get("/ping", () => ({ pong: true }))), { prefix: "/v2" });
  return app;
}

const dir = mkdtempSync(join(tmpdir(), "inkan-learn-"));

test("every quest has a solution, and its check tells the solution from the step before", async () => {
  // quest 10 compares with the document saved before the change it asks for
  writeFileSync(join(dir, "openapi.json"), JSON.stringify(solved(8).openapi()));
  // quest 11 runs on a seal written from the app it seals
  const sealFile = join(dir, "inkan.seal.js");
  writeFileSync(sealFile, writeSeal(solved(10).routes(), "src/app.ts").code);
  const seal: Seal = (await import(pathToFileURL(sealFile).href)).default;

  for (let i = 0; i < QUESTS.length; i++) {
    const quest = QUESTS[i];
    const ctx = (app: App, fromDocs: boolean) => ({ app, dir, seen: { fromDocs }, url: "http://localhost:3333" });
    const before = solved(i - 1, seal);
    const after = solved(i, seal);
    await before.ready();
    await after.ready();
    const no = await quest.check(ctx(before, false));
    assert.equal(typeof no, "string", `quest ${i + 1} (${quest.title}) passes before it is solved`);
    const yes = await quest.check(ctx(after, i >= 8));
    assert.equal(yes, true, `quest ${i + 1} (${quest.title}) does not pass its solution: ${yes}`);
    assert.ok(quest.hints.length >= 2, `quest ${i + 1} has a nudge and an answer`);
  }
});

test("setupLearn makes a practice folder with inkan linked in, and finds it again", () => {
  const where = join(mkdtempSync(join(tmpdir(), "inkan-learn-setup-")), "practice");
  assert.deepEqual(setupLearn(where), { created: true });
  assert.equal(readFileSync(join(where, "src", "app.ts"), "utf8"), STARTER);
  const link = join(where, "node_modules", "@vxnsin", "inkan");
  assert.ok(lstatSync(link).isSymbolicLink() || existsSync(join(link, "package.json")), "inkan is linked, not installed");
  assert.ok(existsSync(join(link, "package.json")));
  assert.deepEqual(JSON.parse(readFileSync(join(where, ".inkan-learn.json"), "utf8")), { quest: 0 });
  assert.deepEqual(setupLearn(where), { created: false }, "a second run continues where it stopped");
});

test("setupLearn leaves a folder alone that is not empty and not a practice folder", () => {
  const taken = mkdtempSync(join(tmpdir(), "inkan-learn-taken-"));
  writeFileSync(join(taken, "notes.txt"), "mine");
  assert.throws(() => setupLearn(taken), LearnError);
  assert.deepEqual(setupLearn(taken, { force: true }), { created: true });
});

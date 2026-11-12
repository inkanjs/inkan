import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { banner, Cancelled, clip, confirm, gradient, select, text, type Io } from "../src/cli/prompt.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const ENTER = "\r";

function terminal(color = false) {
  const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(on: boolean) { input.isRaw = on; } });
  let written = "";
  const io: Io = { input, output: { write: (s: string) => (written += s), columns: 100 }, color };
  // one key per tick, as a person types
  const type = async (...keys: string[]) => {
    for (const k of keys) {
      await new Promise((r) => setImmediate(r));
      input.write(k);
    }
  };
  return { io, input, type, out: () => written };
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

test("select: arrow keys move, enter picks, the answer stays on one line", async () => {
  const t = terminal();
  const answer = select(t.io, "where does the data live?", [{ value: "memory", hint: "in this process" }, { value: "postgres" }, { value: "redis" }], "memory");
  await t.type(DOWN, DOWN, UP, ENTER);
  assert.equal(await answer, "postgres");
  assert.match(plain(t.out()), /❯ memory\s+in this process/);
  assert.match(plain(t.out()), /✔ where does the data live\? · postgres\n$/);
  assert.equal(t.input.isRaw, false, "raw mode is given back");
});

test("select: wraps around, a digit jumps, the initial value is where it starts", async () => {
  const t = terminal();
  const answer = select(t.io, "pick", [{ value: "a" }, { value: "b" }, { value: "c" }], "b");
  await t.type(DOWN, DOWN, ENTER);
  assert.equal(await answer, "a");
  const u = terminal();
  const jumped = select(u.io, "pick", [{ value: "a" }, { value: "b" }, { value: "c" }]);
  await u.type("3", ENTER);
  assert.equal(await jumped, "c");
});

test("select: a long hint is cut with …, and no drawn line reaches the last column", async () => {
  const t = terminal();
  t.io.output.columns = 40;
  const long = "One Store for jobs, rate limits, logins and sessions, shared by every process.";
  const answer = select(t.io, "what are you looking for?", [{ value: "stores", hint: long }, { value: "memory" }]);
  await t.type(DOWN, UP, DOWN, ENTER);
  await answer;
  const lines = plain(t.out()).split(/\n|\r|\x1b\[J/);
  assert.match(plain(t.out()), /stores +One Store for jobs, r…/);
  for (const line of lines) assert.ok([...line].length <= 38, `"${line}" is ${[...line].length} wide`);
});

test("clip: counts columns, not characters, and keeps colour codes", () => {
  assert.equal(clip("abcdef", 4), "abcd");
  assert.equal(clip("印印印", 4), "印印");
  assert.equal(clip("\x1b[31mabcdef\x1b[0m", 3), "\x1b[31mabc\x1b[0m");
  assert.equal(clip("short", 10), "short");
});

test("confirm: the default, arrows to switch, y and n answer at once", async () => {
  const t = terminal();
  const a = confirm(t.io, "auth?");
  await t.type(ENTER);
  assert.equal(await a, false);
  const u = terminal();
  const b = confirm(u.io, "auth?");
  await u.type(RIGHT, ENTER);
  assert.equal(await b, true);
  const v = terminal();
  const c = confirm(v.io, "auth?", true);
  await v.type("n");
  assert.equal(await c, false);
});

test("text: typing, backspace, the placeholder for nothing, validation keeps asking", async () => {
  const t = terminal();
  const a = text(t.io, "folder", { placeholder: "inkan-app" });
  await t.type("s", "h", "o", "x", "\x7f", "p", ENTER);
  assert.equal(await a, "shop");
  const u = terminal();
  const b = text(u.io, "folder", { placeholder: "inkan-app" });
  await u.type(ENTER);
  assert.equal(await b, "inkan-app");
  const v = terminal();
  const c = text(v.io, "folder", { validate: (f) => (f === "taken" ? "taken is not empty" : undefined) });
  await v.type(..."taken", ENTER, "\x15", ..."free", ENTER);
  assert.equal(await c, "free");
  assert.match(plain(v.out()), /taken is not empty/);
});

test("ctrl-c and escape cancel, and give the terminal back", async () => {
  const t = terminal();
  const a = select(t.io, "pick", [{ value: "a" }]);
  await t.type("\x03");
  await assert.rejects(a, Cancelled);
  assert.equal(t.input.isRaw, false);
  assert.match(t.out(), /\x1b\[\?25h$/, "the cursor comes back");
  const u = terminal();
  const b = text(u.io, "folder");
  await u.type("\x1b", "\x1b");
  await assert.rejects(b, Cancelled);
});

test("gradient and banner: colour per character with colour, the text alone without", () => {
  assert.equal(gradient("inkan", false), "inkan");
  const on = gradient("inkan", true, undefined, true);
  assert.equal(plain(on), "inkan");
  assert.equal((on.match(/\x1b\[38;2;/g) ?? []).length, 5);
  assert.match(on, /^\x1b\[38;2;229;72;77mi/, "starts at the seal's red");
  assert.match(gradient("ab", true, undefined, false), /\x1b\[38;5;\d+m/, "256 colours without truecolor");
  assert.equal(banner(false, "create inkan", "v1"), "\n  [印] create inkan  v1\n");
});

// The questions `inkan create app` and `inkan examples` ask: arrow keys, no dependencies.

import { emitKeypressEvents } from "node:readline";

type Rgb = readonly [number, number, number];

/** The seal's red into amber: the inkan gradient. */
export const INK: readonly Rgb[] = [
  [229, 72, 77],
  [247, 107, 21],
  [255, 178, 36],
];

export const truecolor = (env = process.env) =>
  env.COLORTERM === "truecolor" ||
  env.COLORTERM === "24bit" ||
  Boolean(env.WT_SESSION) ||
  ["iTerm.app", "vscode", "WezTerm", "ghostty", "Hyper"].includes(env.TERM_PROGRAM ?? "");

const cube = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
const fg = ([r, g, b]: Rgb, full: boolean) =>
  full ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${16 + 36 * cube(r) + 6 * cube(g) + cube(b)}m`;

function at(stops: readonly Rgb[], t: number): Rgb {
  const span = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(span));
  const f = span - i;
  const [a, b] = [stops[i]!, stops[i + 1]!];
  return [0, 1, 2].map((k) => Math.round(a[k]! + (b[k]! - a[k]!) * f)) as unknown as Rgb;
}

/** `text` coloured along `stops`, one colour per character. Plain without colour. */
export function gradient(text: string, on: boolean, stops: readonly Rgb[] = INK, full = truecolor()): string {
  if (!on) return text;
  const chars = [...text];
  const n = Math.max(1, chars.length - 1);
  return chars.map((ch, i) => (ch === " " ? ch : fg(at(stops, i / n), full) + ch)).join("") + "\x1b[0m";
}

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

type Key = { name?: string; ctrl?: boolean };
export type Input = NodeJS.ReadableStream & { setRawMode?: (on: boolean) => unknown; isRaw?: boolean };
export type Output = { write(s: string): unknown; columns?: number };
export type Io = { input: Input; output: Output; color: boolean };

const styles = (on: boolean) => {
  const c = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { bold: c("1"), dim: c("2"), ok: c("32"), seal: c("31"), cyan: c("36"), active: (s: string) => gradient(s, on) };
};

/** Draws `frame()` in place after every key until `onKey` settles, then leaves `done()` behind. */
function ask<T>(io: Io, frame: () => string[], onKey: (key: Key, ch: string | undefined) => { value: T } | void, done: (value: T) => string): Promise<T> {
  const { input, output } = io;
  return new Promise<T>((resolve, reject) => {
    let drawn = 0;
    const draw = (lines: string[]) => {
      output.write(`\r${drawn > 1 ? `\x1b[${drawn - 1}A` : ""}\x1b[J${lines.join("\n")}`);
      drawn = lines.length;
    };
    const wasRaw = input.isRaw ?? false;
    const finish = (err: Error | undefined, value?: T) => {
      input.removeListener("keypress", listener);
      input.setRawMode?.(wasRaw);
      input.pause();
      draw(err ? [""] : [done(value as T), ""]);
      output.write("\x1b[?25h");
      if (err) reject(err);
      else resolve(value as T);
    };
    const listener = (ch: string | undefined, key: Key = {}) => {
      if ((key.ctrl && (key.name === "c" || key.name === "d")) || key.name === "escape") return finish(new Cancelled());
      const result = onKey(key, ch);
      if (result) return finish(undefined, result.value);
      draw(frame());
    };
    emitKeypressEvents(input);
    input.setRawMode?.(true);
    input.on("keypress", listener);
    input.resume();
    output.write("\x1b[?25l");
    draw(frame());
  });
}

const isEnter = (key: Key) => key.name === "return" || key.name === "enter";

export type Choice<T extends string> = { value: T; label?: string; hint?: string };

export function select<T extends string>(io: Io, message: string, choices: readonly Choice<T>[], initial?: T): Promise<T> {
  const s = styles(io.color);
  let i = Math.max(0, choices.findIndex((c) => c.value === initial));
  const pad = Math.max(...choices.map((c) => (c.label ?? c.value).length)) + 2;
  // hints go when the terminal is too narrow for them
  const room = (io.output.columns ?? 80) - pad - 8;
  return ask(
    io,
    () => [
      `  ${s.seal("◆")} ${s.bold(message)}  ${s.dim("↑↓ enter")}`,
      ...choices.map((c, k) => {
        const label = (c.label ?? c.value).padEnd(pad);
        const hint = c.hint && c.hint.length <= room ? s.dim(c.hint) : "";
        return k === i ? `  ${s.dim("│")} ${s.active("❯ " + label)}${hint}` : `  ${s.dim("│")}   ${label}${hint}`;
      }),
      `  ${s.dim("└")}`,
    ],
    (key, ch) => {
      if (key.name === "up" || key.name === "k") i = (i - 1 + choices.length) % choices.length;
      else if (key.name === "down" || key.name === "j" || key.name === "tab") i = (i + 1) % choices.length;
      else if (key.name === "home") i = 0;
      else if (key.name === "end") i = choices.length - 1;
      else if (ch && /^[1-9]$/.test(ch) && Number(ch) <= choices.length) i = Number(ch) - 1;
      else if (isEnter(key)) return { value: choices[i]!.value };
    },
    (v) => `  ${s.ok("✔")} ${message} ${s.dim("·")} ${s.cyan(choices.find((c) => c.value === v)?.label ?? v)}`,
  );
}

export function confirm(io: Io, message: string, initial = false): Promise<boolean> {
  const s = styles(io.color);
  let yes = initial;
  const option = (label: string, on: boolean) => (on ? s.active(`● ${label}`) : s.dim(`○ ${label}`));
  return ask(
    io,
    () => [`  ${s.seal("◆")} ${s.bold(message)}  ${option("yes", yes)} ${s.dim("/")} ${option("no", !yes)}`],
    (key, ch) => {
      if (["left", "right", "h", "l", "tab", "space"].includes(key.name ?? "")) yes = !yes;
      else if (ch === "y" || ch === "Y") return { value: true };
      else if (ch === "n" || ch === "N") return { value: false };
      else if (isEnter(key)) return { value: yes };
    },
    (v) => `  ${s.ok("✔")} ${message} ${s.dim("·")} ${s.cyan(v ? "yes" : "no")}`,
  );
}

export function text(io: Io, message: string, opts: { placeholder?: string; validate?: (value: string) => string | undefined } = {}): Promise<string> {
  const s = styles(io.color);
  let value = "";
  let problem: string | undefined;
  return ask(
    io,
    () => {
      const shown = value ? value + s.active("▏") : s.active("▏") + s.dim(opts.placeholder ?? "");
      return [`  ${s.seal("◆")} ${s.bold(message)}  ${shown}`, ...(problem ? [`  ${s.dim("└")} ${s.seal(problem)}`] : [])];
    },
    (key, ch) => {
      problem = undefined;
      if (isEnter(key)) {
        const answer = value.trim() || opts.placeholder || "";
        problem = opts.validate?.(answer);
        if (!problem) return { value: answer };
      } else if (key.name === "backspace") value = [...value].slice(0, -1).join("");
      else if (key.ctrl && key.name === "u") value = "";
      else if (ch && !key.ctrl && ch >= " " && ch !== "\x7f") value += ch;
    },
    (v) => `  ${s.ok("✔")} ${message} ${s.dim("·")} ${s.cyan(v)}`,
  );
}

/** The opening line: the seal, a name in the gradient, a quiet subtitle. */
export function banner(on: boolean, title: string, subtitle?: string): string {
  const seal = on ? "\x1b[41;97;1m 印 \x1b[0m" : "[印]";
  const sub = subtitle ? `  ${on ? `\x1b[2m${subtitle}\x1b[0m` : subtitle}` : "";
  return `\n  ${seal} ${gradient(title, on)}${sub}\n`;
}

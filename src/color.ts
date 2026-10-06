// GitHub Actions logs render ANSI colours, though stdout is not a TTY there.
export const useColor = (stream: { isTTY?: boolean } = process.stdout) =>
  !process.env.NO_COLOR &&
  (Boolean(process.env.FORCE_COLOR) || Boolean(process.env.GITHUB_ACTIONS) || Boolean(stream.isTTY));

export type Paint = ReturnType<typeof paint>;

export function paint(on: boolean) {
  const c = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    seal: c("31"),
    ok: c("32"),
    warn: c("33"),
    link: c("94"),
    bold: c("1"),
    dim: c("2"),
    method(m: string, text = m) {
      const code = { GET: "32", POST: "94", PUT: "33", PATCH: "35", DELETE: "31" }[m];
      return code ? c("1;" + code)(text) : c("1")(text);
    },
    status(s: number) {
      return c(s >= 500 ? "31" : s >= 400 ? "33" : s >= 300 ? "36" : "32")(String(s));
    },
  };
}

// Reading server-sent events back. No Node imports, so the typed client can use it in a browser too.

/** Reads an event stream back, the way a browser's EventSource would. Comments are skipped. */
export function parseEvents(text: string): { event: string; data: unknown; id?: string }[] {
  const out: { event: string; data: unknown; id?: string }[] = [];
  for (const block of text.split(/\n\n/)) {
    const fields = block.split("\n").filter((l) => l && !l.startsWith(":"));
    if (!fields.length) continue;
    let event = "message";
    let id: string | undefined;
    const data: string[] = [];
    for (const line of fields) {
      const i = line.indexOf(":");
      const key = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (key === "event") event = value;
      else if (key === "id") id = value;
      else if (key === "data") data.push(value);
    }
    let parsed: unknown = data.join("\n");
    try {
      parsed = JSON.parse(parsed as string);
    } catch {}
    out.push(id === undefined ? { event, data: parsed } : { event, data: parsed, id });
  }
  return out;
}

// Five-field cron expressions, read once and asked for the next time they match.
//
//   ┌ minute 0-59   ┌ hour 0-23   ┌ day of month 1-31   ┌ month 1-12 or jan-dec   ┌ day of week 0-7 or sun-sat (0 and 7: Sunday)
//   0               3             *                     *                         *
//
// Each field takes `*`, a value, a range `1-5`, a step `*/15`, `10-50/20` or `5/15` (from 5 to
// the end), and lists of these: `1,15,30-31`. As in Vixie cron, when both the day of month
// and the day of week are restricted (neither starts with `*`) a day matches either one:
// `0 0 1 * mon` is the first of the month and every Monday. `@yearly`, `@monthly`,
// `@weekly`, `@daily`, `@midnight` and `@hourly` stand for what they say.

export type CronZone = "UTC" | "local";

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

type Field = { name: string; min: number; max: number; names?: string[]; offset?: number };
const FIELDS: Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, offset: 1 },
  { name: "day of week", min: 0, max: 7, names: DAYS, offset: 0 },
];

/** The date parts a cron reads, in UTC or in the process's own time zone. */
const PARTS = {
  UTC: {
    year: (d: Date) => d.getUTCFullYear(),
    month: (d: Date) => d.getUTCMonth(),
    date: (d: Date) => d.getUTCDate(),
    day: (d: Date) => d.getUTCDay(),
    hour: (d: Date) => d.getUTCHours(),
    minute: (d: Date) => d.getUTCMinutes(),
    startOfMonth: (y: number, m: number) => Date.UTC(y, m, 1),
    startOfDay: (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    startOfHour: (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()),
  },
  local: {
    year: (d: Date) => d.getFullYear(),
    month: (d: Date) => d.getMonth(),
    date: (d: Date) => d.getDate(),
    day: (d: Date) => d.getDay(),
    hour: (d: Date) => d.getHours(),
    minute: (d: Date) => d.getMinutes(),
    startOfMonth: (y: number, m: number) => new Date(y, m, 1).getTime(),
    startOfDay: (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
    startOfHour: (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime(),
  },
};

const MINUTE = 60_000;
const HOUR = 3_600_000;
/** How far ahead to look before calling an expression one that never matches (`0 0 30 2 *`). */
const YEARS = 30;

export class Cron {
  readonly source: string;
  private minute: boolean[];
  private hour: boolean[];
  private dom: boolean[];
  private month: boolean[];
  private dow: boolean[];
  /** Both day fields restricted: a day matches either. Otherwise both. */
  private either: boolean;

  constructor(expression: string) {
    this.source = expression;
    const text = MACROS[expression.trim().toLowerCase()] ?? expression;
    const parts = text.trim().split(/\s+/);
    if (parts.length !== 5) throw new Error(`cron "${expression}": five fields (minute hour day-of-month month day-of-week), not ${parts.length}`);
    [this.minute, this.hour, this.dom, this.month, this.dow] = parts.map((p, i) => field(expression, p, FIELDS[i]!));
    if (this.dow[7]) this.dow[0] = true; // 7 is Sunday too
    this.either = !parts[2]!.startsWith("*") && !parts[4]!.startsWith("*");
  }

  /** Whether a day (by its date and weekday) is one the expression runs on. */
  private day(date: number, weekday: number): boolean {
    return this.either ? this.dom[date]! || this.dow[weekday]! : this.dom[date]! && this.dow[weekday]!;
  }

  /** The first minute strictly after `after` that matches, or undefined when none does in the next 30 years. */
  next(after: Date | number, zone: CronZone = "UTC"): Date | undefined {
    const z = PARTS[zone];
    let t = Math.floor(new Date(after).getTime() / MINUTE) * MINUTE + MINUTE;
    const end = new Date(t).getUTCFullYear() + YEARS;
    for (;;) {
      const d = new Date(t);
      const year = z.year(d);
      if (year > end) return undefined;
      const month = z.month(d);
      let to: number;
      if (!this.month[month + 1]) to = z.startOfMonth(year, month + 1);
      else if (!this.day(z.date(d), z.day(d))) to = z.startOfDay(new Date(z.startOfDay(d) + 36 * HOUR)); // the next day, whatever its length
      else if (!this.hour[z.hour(d)]) to = z.startOfHour(d) + HOUR;
      else {
        const m = this.minute.indexOf(true, z.minute(d));
        if (m === z.minute(d)) return d;
        to = m === -1 ? z.startOfHour(d) + HOUR : t + (m - z.minute(d)) * MINUTE;
      }
      t = to > t ? to : t + MINUTE; // always forward, whatever a clock change does
    }
  }
}

/** One field as a table of the values it allows. */
function field(expression: string, text: string, f: Field): boolean[] {
  const allowed = new Array<boolean>(f.max + 1).fill(false);
  const bad = (why: string): never => {
    throw new Error(`cron "${expression}": the ${f.name} "${text}" ${why}`);
  };
  const value = (s: string): number => {
    const named = f.names?.indexOf(s.toLowerCase()) ?? -1;
    const n = named >= 0 ? named + f.offset! : /^\d+$/.test(s) ? Number(s) : bad(`has "${s}", which is not a number${f.names ? " or a name" : ""}`);
    if (n < f.min || n > f.max) bad(`has ${n}, outside ${f.min}-${f.max}`);
    return n;
  };
  for (const part of text.split(",")) {
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined || range === "" || stepText === "") bad("is not a value, a range or a step");
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) && Number(stepText) > 0 ? Number(stepText) : bad(`has the step "${stepText}"`);
    let from: number;
    let to: number;
    if (range === "*") [from, to] = [f.min, f.max];
    else if (range!.includes("-")) {
      const [a, b, more] = range!.split("-");
      if (more !== undefined) bad("is not a value, a range or a step");
      [from, to] = [value(a!), value(b!)];
      if (from > to) bad(`runs backwards, ${from} to ${to}`);
    } else [from, to] = [value(range!), stepText === undefined ? value(range!) : f.max];
    for (let i = from; i <= to; i += step) allowed[i] = true;
  }
  return allowed;
}

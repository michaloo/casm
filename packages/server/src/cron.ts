// Minimal 5-field cron (minute hour day-of-month month day-of-week) in the
// server's local time. Supports *, lists, ranges, steps and 0/7 for Sunday.
// Like Vixie cron, when both day fields are restricted either may match.

type Field = { values: Set<number>; any: boolean };
export type Cron = { minute: Field; hour: Field; dom: Field; month: Field; dow: Field };

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function field(src: string, [lo, hi]: [number, number]): Field {
  const values = new Set<number>();
  for (const part of src.split(",")) {
    const [range, stepSrc] = part.split("/");
    const step = stepSrc === undefined ? 1 : Number(stepSrc);
    let a: number;
    let b: number;
    if (range === "*") [a, b] = [lo, hi];
    else if (range.includes("-")) [a, b] = range.split("-").map(Number) as [number, number];
    else [a, b] = [Number(range), stepSrc === undefined ? Number(range) : hi];
    if (![a, b, step].every(Number.isInteger) || a < lo || b > hi || a > b || step < 1)
      throw new Error(`invalid cron field "${src}" (allowed ${lo}-${hi})`);
    for (let v = a; v <= b; v += step) values.add(v);
  }
  return { values, any: src === "*" };
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs 5 fields (minute hour day month weekday), got "${expr}"`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => field(p, RANGES[i]));
  if (dow.values.has(7)) dow.values.add(0);
  return { minute, hour, dom, month, dow };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.dom.values.has(d.getDate());
  const dow = c.dow.values.has(d.getDay());
  if (c.dom.any || c.dow.any) return (c.dom.any || dom) && (c.dow.any || dow);
  return dom || dow;
}

// The first matching minute strictly after `after`.
export function nextCron(c: Cron, after: Date): Date {
  const t = new Date(after);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = after.getTime() + 366 * 864e5 * 4;
  while (t.getTime() <= limit) {
    if (!c.month.values.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
    } else if (!dayMatches(c, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
    } else if (!c.hour.values.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
    } else if (!c.minute.values.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
    } else return t;
  }
  throw new Error("cron expression never matches");
}

/**
 * #115: Cron schedule evaluation — pure functions, no I/O.
 *
 * Supports two schedule forms:
 *  - **5-field cron** `"minute hour dom month dow"` — each field is `*`, an
 *    integer, `*` + `/step`, an `a-b` range, or a comma list of those. Standard
 *    Unix semantics: dom/dow are OR'd when both are restricted (a task fires when
 *    either matches), matching cron's historical behavior.
 *  - **one-shot ISO datetime** `"2026-06-09T09:00:00Z"` — fires once at that
 *    instant, then never again.
 *
 * Kept dependency-free (a tiny evaluator beats pulling a cron library for this).
 *
 * TIMEZONE: cron fields are matched against the gateway process's LOCAL time
 * (`Date#getHours()` etc.), so `"0 9 * * *"` means 9am in the server's timezone.
 * One-shot ISO datetimes are absolute instants (honor any offset/`Z` in the
 * string). Set `TZ=...` on the process to control cron-field interpretation.
 */

/** A parsed 5-field cron expression: each field is the set of allowed values. */
export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** True when dom/dow were both restricted (affects OR semantics). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const FIELD_RANGES: Array<[keyof Omit<ParsedCron, 'domRestricted' | 'dowRestricted'>, number, number]> = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['dom', 1, 31],
  ['month', 1, 12],
  ['dow', 0, 6], // 0 = Sunday
];

/** Expand one cron field into a set of allowed integers, or null if invalid. */
function parseField(raw: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const seg = part.trim();
    if (seg === '') return null;
    // step: "*/n" or "a-b/n" or "a/n"
    let stepStr: string | undefined;
    let rangeStr = seg;
    const slash = seg.indexOf('/');
    if (slash !== -1) {
      rangeStr = seg.slice(0, slash);
      stepStr = seg.slice(slash + 1);
    }
    let step = 1;
    if (stepStr !== undefined) {
      if (!/^\d+$/.test(stepStr)) return null;
      step = Number(stepStr);
      if (step < 1) return null;
    }
    let lo: number;
    let hi: number;
    if (rangeStr === '*') {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(rangeStr)) {
      lo = hi = Number(rangeStr);
      // A bare number with a step (e.g. "5/10") means "from 5 to max, step".
      if (stepStr !== undefined) hi = max;
    } else {
      const m = /^(\d+)-(\d+)$/.exec(rangeStr);
      if (!m) return null;
      lo = Number(m[1]);
      hi = Number(m[2]);
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

/** Parse a 5-field cron expression. Returns null when invalid. */
export function parseCronExpression(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const [, min, max] = FIELD_RANGES[i];
    const set = parseField(fields[i], min, max);
    if (!set) return null;
    sets.push(set);
  }
  return {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow: sets[4],
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

/** True when `date` (local time) matches the parsed cron. */
export function matchesCron(p: ParsedCron, date: Date): boolean {
  if (!p.minute.has(date.getMinutes())) return false;
  if (!p.hour.has(date.getHours())) return false;
  if (!p.month.has(date.getMonth() + 1)) return false;
  const domOk = p.dom.has(date.getDate());
  const dowOk = p.dow.has(date.getDay());
  // Standard cron OR semantics: if BOTH dom and dow are restricted, match when
  // EITHER matches; otherwise both (the unrestricted one is always true) must.
  if (p.domRestricted && p.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/** Heuristic: is this schedule a one-shot ISO datetime (vs a cron expr)? */
export function isOneShotSchedule(schedule: string): boolean {
  // Cron exprs are space-separated fields; ISO datetimes contain 'T' and no spaces.
  return schedule.includes('T') && !/\s/.test(schedule.trim());
}

/**
 * Compute the next fire time (Unix ms) strictly after `fromMs`, or null when
 * there is none (a past/invalid one-shot, or an impossible cron).
 *
 * - one-shot ISO: its instant if still in the future, else null.
 * - cron: scan minute-by-minute from the next whole minute, up to ~366 days.
 */
export function computeNextRun(schedule: string, recurring: boolean, fromMs: number): number | null {
  if (isOneShotSchedule(schedule)) {
    const t = new Date(schedule).getTime();
    if (Number.isNaN(t)) return null;
    return t > fromMs ? t : null;
  }
  const parsed = parseCronExpression(schedule);
  if (!parsed) return null;
  void recurring; // cron exprs are inherently recurring; flag kept for symmetry
  // Start at the next whole minute boundary after fromMs.
  const start = new Date(fromMs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const MAX_MINUTES = 366 * 24 * 60;
  const cursor = new Date(start);
  for (let i = 0; i < MAX_MINUTES; i++) {
    if (matchesCron(parsed, cursor)) return cursor.getTime();
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null; // impossible schedule (e.g. Feb 31)
}

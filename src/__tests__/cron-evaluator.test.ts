/**
 * #115: cron-evaluator tests — cron field parsing, matching, next-run, one-shot.
 */
import { describe, it, expect } from 'vitest';
import {
  parseCronExpression, matchesCron, computeNextRun, isOneShotSchedule, parseOneShot,
} from '../cron-evaluator.js';

describe('parseCronExpression', () => {
  it('rejects non-5-field / empty / malformed', () => {
    expect(parseCronExpression('not cron')).toBeNull();
    expect(parseCronExpression('')).toBeNull();
    expect(parseCronExpression('* * * *')).toBeNull();       // 4 fields
    expect(parseCronExpression('* * * * * *')).toBeNull();   // 6 fields
    expect(parseCronExpression('60 * * * *')).toBeNull();    // minute out of range
    expect(parseCronExpression('* 24 * * *')).toBeNull();    // hour out of range
    expect(parseCronExpression('* * 0 * *')).toBeNull();     // dom min is 1
    expect(parseCronExpression('* * * 13 *')).toBeNull();    // month out of range
    expect(parseCronExpression('* * * * 7')).toBeNull();     // dow max is 6
    expect(parseCronExpression('5-3 * * * *')).toBeNull();   // inverted range
  });

  it('parses *, number, range, list, step', () => {
    expect(parseCronExpression('* * * * *')).not.toBeNull();
    expect(parseCronExpression('0 9 * * 1-5')).not.toBeNull();
    expect(parseCronExpression('*/15 * * * *')).not.toBeNull();
    expect(parseCronExpression('0,30 * * * *')).not.toBeNull();
  });
});

describe('matchesCron', () => {
  it('"* * * * *" matches any date', () => {
    const p = parseCronExpression('* * * * *')!;
    expect(matchesCron(p, new Date('2026-06-09T13:47:00'))).toBe(true);
  });

  it('"0 9 * * 1" (Mon 9:00) matches only that slot', () => {
    const p = parseCronExpression('0 9 * * 1')!;
    // 2026-06-08 is a Monday.
    expect(matchesCron(p, new Date('2026-06-08T09:00:00'))).toBe(true);
    expect(matchesCron(p, new Date('2026-06-08T10:00:00'))).toBe(false); // wrong hour
    expect(matchesCron(p, new Date('2026-06-09T09:00:00'))).toBe(false); // Tuesday
  });

  it('"*/15 * * * *" matches :00/:15/:30/:45 only', () => {
    const p = parseCronExpression('*/15 * * * *')!;
    for (const m of [0, 15, 30, 45]) {
      expect(matchesCron(p, new Date(2026, 5, 9, 10, m))).toBe(true);
    }
    expect(matchesCron(p, new Date(2026, 5, 9, 10, 7))).toBe(false);
  });

  it('dom/dow OR semantics when both restricted', () => {
    // "0 0 1 * 1" → midnight on the 1st OR any Monday.
    const p = parseCronExpression('0 0 1 * 1')!;
    expect(matchesCron(p, new Date(2026, 5, 1, 0, 0))).toBe(true);  // the 1st (Mon too)
    expect(matchesCron(p, new Date(2026, 5, 8, 0, 0))).toBe(true);  // a Monday, not 1st
    expect(matchesCron(p, new Date(2026, 5, 9, 0, 0))).toBe(false); // Tue, not 1st
  });
});

describe('isOneShotSchedule', () => {
  it('distinguishes ISO datetime from cron expr', () => {
    expect(isOneShotSchedule('2026-06-09T09:00:00Z')).toBe(true);
    expect(isOneShotSchedule('0 9 * * *')).toBe(false);
    expect(isOneShotSchedule('* * * * *')).toBe(false);
  });
});

describe('computeNextRun', () => {
  const NOW = new Date('2026-06-09T10:00:30').getTime();

  it('cron: returns a future whole-minute time', () => {
    const next = computeNextRun('*/15 * * * *', true, NOW);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(NOW);
    const d = new Date(next!);
    expect(d.getSeconds()).toBe(0);
    expect([0, 15, 30, 45]).toContain(d.getMinutes());
  });

  it('one-shot in the future returns its instant', () => {
    const future = '2999-01-01T00:00:00Z';
    expect(computeNextRun(future, false, NOW)).toBe(new Date(future).getTime());
  });

  it('one-shot in the past returns null', () => {
    expect(computeNextRun('2000-01-01T00:00:00Z', false, NOW)).toBeNull();
  });

  it('invalid cron returns null', () => {
    expect(computeNextRun('bogus expr here now', true, NOW)).toBeNull();
  });

  it('impossible schedule (Feb 31) returns null', () => {
    expect(computeNextRun('0 0 31 2 *', true, NOW)).toBeNull();
  });
});

describe('parseOneShot (#6 strict ISO)', () => {
  it('accepts canonical ISO datetimes', () => {
    expect(parseOneShot('2999-01-01T00:00:00Z')).toBe(new Date('2999-01-01T00:00:00Z').getTime());
    expect(parseOneShot('2999-06-09T09:30Z')).toBe(new Date('2999-06-09T09:30Z').getTime());
    expect(parseOneShot('2999-06-09T09:30:00')).not.toBeNull(); // no zone = local
    expect(parseOneShot('2999-06-09T09:30:00+08:00')).not.toBeNull();
  });

  it('rejects lenient rollover dates (month 13, day 32) instead of shifting them', () => {
    expect(parseOneShot('2026-13-13T00:00:00Z')).toBeNull(); // month 13
    expect(parseOneShot('2026-02-31T00:00:00Z')).toBeNull(); // Feb 31 rolls to Mar
    expect(parseOneShot('2026-06-32T00:00:00Z')).toBeNull(); // day 32
  });

  it('rejects non-ISO / garbage that the loose heuristic would pass', () => {
    expect(parseOneShot('T')).toBeNull();
    expect(parseOneShot('0T0')).toBeNull();
    expect(parseOneShot('badT123')).toBeNull();
    expect(parseOneShot('not a date')).toBeNull();
  });

  it('computeNextRun uses strict parsing — a rollover one-shot is rejected', () => {
    expect(computeNextRun('2026-13-13T00:00:00Z', false, Date.now())).toBeNull();
  });
});

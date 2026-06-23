import { describe, it, expect } from 'vitest';
import { shouldRunIdle } from '../index.js';

describe('shouldRunIdle', () => {
  it('is true for an empty bot list (zero-bot idle)', () => {
    expect(shouldRunIdle([])).toBe(true);
  });

  it('is false when at least one bot is configured', () => {
    expect(shouldRunIdle([{ botId: 'default' }])).toBe(false);
    expect(shouldRunIdle([{ botId: 'a' }, { botId: 'b' }])).toBe(false);
  });
});

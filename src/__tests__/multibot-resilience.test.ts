import { describe, it, expect } from 'vitest';
import { partitionStartResults, type BotStack } from '../index.js';

// A minimal BotStack-shaped stub; partitionStartResults only ever moves the
// fulfilled value through, it never calls into it. Cast through unknown to keep
// the test free of `any` (the repo lints with --max-warnings 0).
function fakeStack(id: string): BotStack {
  return {
    botId: id,
    connect: async () => {},
    shutdown: async () => {},
  } as unknown as BotStack;
}

describe('partitionStartResults', () => {
  const configs = [{ botId: 'a' }, { botId: 'b' }, { botId: 'c' }];

  it('all fulfilled → every stack, no failures', () => {
    const results: PromiseSettledResult<BotStack>[] = [
      { status: 'fulfilled', value: fakeStack('a') },
      { status: 'fulfilled', value: fakeStack('b') },
      { status: 'fulfilled', value: fakeStack('c') },
    ];
    const { stacks, failures } = partitionStartResults(results, configs);
    expect(stacks.map((s) => s.botId)).toEqual(['a', 'b', 'c']);
    expect(failures).toEqual([]);
  });

  it('partial failure → keeps successful stacks, records failures (does not throw)', () => {
    const err = new Error('401 bad token');
    const results: PromiseSettledResult<BotStack>[] = [
      { status: 'fulfilled', value: fakeStack('a') },
      { status: 'rejected', reason: err },
      { status: 'fulfilled', value: fakeStack('c') },
    ];
    const { stacks, failures } = partitionStartResults(results, configs);
    expect(stacks.map((s) => s.botId)).toEqual(['a', 'c']);
    expect(failures).toEqual([{ id: 'b', reason: err }]);
  });

  it('all failed → no stacks, every failure recorded (caller decides fatal)', () => {
    const results: PromiseSettledResult<BotStack>[] = [
      { status: 'rejected', reason: new Error('e1') },
      { status: 'rejected', reason: new Error('e2') },
      { status: 'rejected', reason: new Error('e3') },
    ];
    const { stacks, failures } = partitionStartResults(results, configs);
    expect(stacks).toEqual([]);
    expect(failures.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to a positional id when botId is missing', () => {
    const results: PromiseSettledResult<BotStack>[] = [
      { status: 'rejected', reason: new Error('e') },
    ];
    const { failures } = partitionStartResults(results, [{}]);
    expect(failures[0].id).toBe('#0');
  });
});

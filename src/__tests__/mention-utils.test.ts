/**
 * Tests for mention-utils — @[uid:name] structured + @name fallback resolution.
 */

import { describe, it, expect } from 'vitest';
import {
  parseStructuredMentions,
  convertStructuredMentions,
  buildEntitiesFromFallback,
  resolveMentions,
  tryLongestMemberMatch,
  MENTION_PATTERN,
  STRUCTURED_MENTION_PATTERN,
} from '../mention-utils.js';

describe('parseStructuredMentions', () => {
  it('parses single @[uid:name]', () => {
    const result = parseStructuredMentions('Hello @[uid1:Alice]!');
    expect(result).toEqual([{ uid: 'uid1', name: 'Alice', offset: 6, length: 13 }]);
  });

  it('parses multiple structured mentions with correct offsets', () => {
    const text = '@[u1:Alice] hi @[u2:Bob]';
    const result = parseStructuredMentions(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ uid: 'u1', name: 'Alice', offset: 0, length: 11 });
    expect(result[1]).toEqual({ uid: 'u2', name: 'Bob', offset: 15, length: 9 });
  });

  it('returns empty array when no structured mentions', () => {
    expect(parseStructuredMentions('plain text @notstructured')).toEqual([]);
  });

  it('handles CJK display names', () => {
    const result = parseStructuredMentions('@[uid1:陈皮皮] hi');
    expect(result).toEqual([{ uid: 'uid1', name: '陈皮皮', offset: 0, length: 11 }]);
  });

  it('handles uid with dots and hyphens', () => {
    const result = parseStructuredMentions('@[u.id-1:Name]');
    expect(result[0].uid).toBe('u.id-1');
  });
});

describe('convertStructuredMentions', () => {
  it('replaces @[uid:name] with @name and tracks output offsets', () => {
    const text = 'hello @[u1:Alice] and @[u2:Bob]';
    const mentions = parseStructuredMentions(text);
    const result = convertStructuredMentions(text, mentions);

    expect(result.content).toBe('hello @Alice and @Bob');
    expect(result.uids).toEqual(['u1', 'u2']);
    expect(result.entities).toHaveLength(2);
    // @Alice is at offset 6, length 6 (@ + 5 chars)
    expect(result.entities[0]).toEqual({ uid: 'u1', offset: 6, length: 6 });
    // @Bob is at offset 17, length 4
    expect(result.entities[1]).toEqual({ uid: 'u2', offset: 17, length: 4 });
  });

  it('handles mentions in any order (sorts by offset)', () => {
    const text = '@[u1:A] @[u2:B]';
    // Pass mentions in reverse order
    const mentions = parseStructuredMentions(text).reverse();
    const result = convertStructuredMentions(text, mentions);
    expect(result.content).toBe('@A @B');
    expect(result.entities[0].offset).toBe(0);
    expect(result.entities[1].offset).toBe(3);
  });

  it('handles same name twice with different uids — entity offsets distinct', () => {
    const text = '@[u1:Alice] @[u2:Alice]';
    const mentions = parseStructuredMentions(text);
    const result = convertStructuredMentions(text, mentions);
    expect(result.content).toBe('@Alice @Alice');
    expect(result.entities[0]).toEqual({ uid: 'u1', offset: 0, length: 6 });
    expect(result.entities[1]).toEqual({ uid: 'u2', offset: 7, length: 6 });
  });

  it('preserves text around mentions', () => {
    const text = 'prefix @[u1:Alice] middle @[u2:Bob] suffix';
    const mentions = parseStructuredMentions(text);
    const result = convertStructuredMentions(text, mentions);
    expect(result.content).toBe('prefix @Alice middle @Bob suffix');
  });

  it('handles empty mention list', () => {
    const result = convertStructuredMentions('no mentions here', []);
    expect(result.content).toBe('no mentions here');
    expect(result.entities).toEqual([]);
    expect(result.uids).toEqual([]);
  });
});

describe('buildEntitiesFromFallback', () => {
  it('resolves @name via memberMap', () => {
    const memberMap = new Map([['Alice', 'u1'], ['Bob', 'u2']]);
    const result = buildEntitiesFromFallback('@Alice @Bob', memberMap);
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toEqual({ uid: 'u1', offset: 0, length: 6 });
    expect(result.entities[1]).toEqual({ uid: 'u2', offset: 7, length: 4 });
    expect(result.uids).toEqual(['u1', 'u2']);
  });

  it('skips @name not in memberMap', () => {
    const memberMap = new Map([['Alice', 'u1']]);
    const result = buildEntitiesFromFallback('@Alice @Unknown', memberMap);
    expect(result.entities).toHaveLength(1);
    expect(result.uids).toEqual(['u1']);
  });

  it('skips @all and @所有人', () => {
    const memberMap = new Map([['Alice', 'u1']]);
    const result = buildEntitiesFromFallback('@all @Alice @所有人', memberMap);
    expect(result.entities).toHaveLength(1);
    expect(result.uids).toEqual(['u1']);
  });

  it('does not match email addresses', () => {
    const memberMap = new Map([['Alice', 'u1']]);
    const result = buildEntitiesFromFallback('contact user@example.com or @Alice', memberMap);
    // Should only match @Alice, not example
    expect(result.uids).toEqual(['u1']);
  });

  it('matches longest displayName (names with spaces handled)', () => {
    const memberMap = new Map([
      ['Alice', 'u1'],
      ['Alice Wonder', 'u2'],
    ]);
    const result = buildEntitiesFromFallback('@Alice Wonder rocks', memberMap);
    // tryLongestMemberMatch prefers "Alice Wonder" over "Alice"
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].uid).toBe('u2');
    expect(result.entities[0].length).toBe(13); // @Alice Wonder
  });

  it('handles CJK display names', () => {
    const memberMap = new Map([['陈皮皮', 'u1']]);
    const result = buildEntitiesFromFallback('@陈皮皮 hi', memberMap);
    expect(result.uids).toEqual(['u1']);
  });
});

describe('tryLongestMemberMatch', () => {
  it('returns longest matching name', () => {
    const memberMap = new Map([['A', 'u1'], ['Anyang', 'u2'], ['Anyang Su', 'u3']]);
    const sorted = ['Anyang Su', 'Anyang', 'A'];
    const result = tryLongestMemberMatch('@Anyang Su rocks', 0, memberMap, sorted);
    expect(result).toEqual({ name: 'Anyang Su', uid: 'u3' });
  });

  it('respects boundary — does not match Anyang Su from Anyang Superman', () => {
    const memberMap = new Map([['Anyang', 'u1'], ['Anyang Su', 'u2']]);
    const sorted = ['Anyang Su', 'Anyang'];
    // After "Anyang Su" comes "p" which is a name char → boundary fails
    const result = tryLongestMemberMatch('@Anyang Superman', 0, memberMap, sorted);
    // Falls back to "Anyang" since after that comes " " which is boundary
    expect(result).toEqual({ name: 'Anyang', uid: 'u1' });
  });

  it('returns undefined when no candidate matches', () => {
    const memberMap = new Map([['Alice', 'u1']]);
    const result = tryLongestMemberMatch('@Bob hi', 0, memberMap, ['Alice']);
    expect(result).toBeUndefined();
  });
});

describe('resolveMentions', () => {
  it('handles structured mentions only', () => {
    const result = resolveMentions('@[u1:Alice] hi');
    expect(result.finalContent).toBe('@Alice hi');
    expect(result.mentionUids).toEqual(['u1']);
    expect(result.mentionEntities).toHaveLength(1);
    expect(result.mentionAll).toBe(false);
  });

  it('handles plain @name via memberMap', () => {
    const memberMap = new Map([['Alice', 'u1']]);
    const result = resolveMentions('@Alice hi', memberMap);
    expect(result.finalContent).toBe('@Alice hi');
    expect(result.mentionUids).toEqual(['u1']);
  });

  it('combines structured + plain (no offset overlap)', () => {
    const memberMap = new Map([['Bob', 'u2']]);
    const result = resolveMentions('@[u1:Alice] and @Bob', memberMap);
    expect(result.finalContent).toBe('@Alice and @Bob');
    expect(result.mentionUids).toEqual(['u1', 'u2']);
    expect(result.mentionEntities).toHaveLength(2);
  });

  it('detects @all', () => {
    const result = resolveMentions('@all please review');
    expect(result.mentionAll).toBe(true);
    expect(result.mentionUids).toEqual([]);
  });

  it('detects @所有人', () => {
    const result = resolveMentions('@所有人 注意');
    expect(result.mentionAll).toBe(true);
  });

  it('does NOT treat @all-foo / @all.x as a broadcast (boundary fix)', () => {
    // Hyphen/dot are name-continuation chars; `@all-members` is a literal name,
    // not the broadcast token. Previously `[^\w]` matched and spammed everyone.
    expect(resolveMentions('notify @all-members now').mentionAll).toBe(false);
    expect(resolveMentions('see @all.hands doc').mentionAll).toBe(false);
    expect(resolveMentions('@allen replied').mentionAll).toBe(false);
  });

  it('still detects @all followed by non-name punctuation (incl. CJK)', () => {
    expect(resolveMentions('@all, please review').mentionAll).toBe(true);
    expect(resolveMentions('@所有人，注意').mentionAll).toBe(true);
    expect(resolveMentions('@all').mentionAll).toBe(true);
  });

  it('returns empty entities when no memberMap and no structured', () => {
    const result = resolveMentions('@Alice hi');
    expect(result.mentionUids).toEqual([]);
    expect(result.mentionEntities).toEqual([]);
    expect(result.finalContent).toBe('@Alice hi');
  });

  it('returns empty when text has no mentions', () => {
    const result = resolveMentions('plain text');
    expect(result.finalContent).toBe('plain text');
    expect(result.mentionUids).toEqual([]);
    expect(result.mentionEntities).toEqual([]);
    expect(result.mentionAll).toBe(false);
  });

  it('sorts entities by offset', () => {
    const result = resolveMentions('@[u2:Bob] @[u1:Alice]');
    expect(result.finalContent).toBe('@Bob @Alice');
    expect(result.mentionEntities[0].uid).toBe('u2');
    expect(result.mentionEntities[1].uid).toBe('u1');
    expect(result.mentionUids).toEqual(['u2', 'u1']);
  });
});

describe('patterns', () => {
  it('MENTION_PATTERN matches @name after whitespace', () => {
    const pattern = new RegExp(MENTION_PATTERN.source, 'g');
    const matches = [...'hello @Alice and @Bob'.matchAll(pattern)];
    expect(matches.map(m => m[1])).toEqual(['Alice', 'Bob']);
  });

  it('STRUCTURED_MENTION_PATTERN extracts uid and name', () => {
    const pattern = new RegExp(STRUCTURED_MENTION_PATTERN.source, 'g');
    const match = pattern.exec('@[uid1:Name]');
    expect(match?.[1]).toBe('uid1');
    expect(match?.[2]).toBe('Name');
  });
});

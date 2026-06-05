/**
 * @mention parsing utilities for outbound messages.
 *
 * Supports two formats in agent output:
 * - v2 structured: @[uid:displayName] — precise, generated from system prompt
 * - v1 plain: @name — resolved against memberMap (displayName → uid)
 *
 * Also detects @all / @所有人 for mentionAll signaling.
 */

import type { MentionEntity } from "./octo/types.js";

/**
 * Plain @name pattern.
 *
 * Pre-boundary (lookbehind): @ must be preceded by line start or non-alphanumeric
 * character (blacklist approach excludes emails like `user@example.com`).
 *
 * Name charset: letters, digits, underscore, CJK ideographs, Hangul, Kana,
 * Latin extended (accented), dot, hyphen.
 *
 * Capture groups:
 *   match[0] = full @name (lookbehind doesn't consume chars)
 *   match[1] = name (without @)
 */
export const MENTION_PATTERN =
  /(?:^|(?<=\s|[^a-zA-Z0-9]))@([\w\u00C0-\u024F\u4e00-\u9fff\u3040-\u30FF\uAC00-\uD7AF.\-]+)/g;

/**
 * Structured @[uid:displayName] pattern (adapter↔LLM internal format).
 *
 * uid charset: [\w.\-]+ — covers all known Octo uid formats.
 * name charset: [^\]\n]+ — anything except closing bracket and newline.
 */
export const STRUCTURED_MENTION_PATTERN = /@\[([\w.\-]+):([^\]\n]+)\]/g;

// ── Structured @[uid:name] parsing ──────────────────────────────────────────

export interface StructuredMention {
  uid: string;
  name: string;
  /** Offset of @[uid:name] in source text (UTF-16 code units). */
  offset: number;
  /** Full length of @[uid:name] match. */
  length: number;
}

/**
 * Parse @[uid:name] structured mentions from text.
 *
 * Used to extract LLM-emitted structured mentions for conversion to plain
 * @name + MentionEntity payload.
 */
export function parseStructuredMentions(text: string): StructuredMention[] {
  const results: StructuredMention[] = [];
  const pattern = new RegExp(STRUCTURED_MENTION_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    results.push({
      uid: match[1],
      name: match[2],
      offset: match.index,
      length: match[0].length,
    });
  }
  return results;
}

// ── Convert @[uid:name] → @name (outbound: LLM → human-readable) ────────────

export interface ConvertResult {
  /** Human-readable content with @[uid:name] replaced by @name. */
  content: string;
  /** Mention entities with offsets pointing into the converted content. */
  entities: MentionEntity[];
  /** UIDs in entities (same order as entities, sorted by offset). */
  uids: string[];
}

/**
 * Replace @[uid:name] with @name and produce entities pointing to the @name
 * positions in the output.
 *
 * Uses an incremental build algorithm: walks mentions in offset order, copying
 * the gap before each mention, then the replacement, tracking the precise
 * output offset for each entity. Avoids indexOf rescans that would mis-bind
 * same-name mentions.
 */
export function convertStructuredMentions(
  text: string,
  mentions: StructuredMention[],
): ConvertResult {
  const sorted = [...mentions].sort((a, b) => a.offset - b.offset);

  const entities: MentionEntity[] = [];
  const uids: string[] = [];
  let content = "";
  let cursor = 0;

  for (const m of sorted) {
    content += text.substring(cursor, m.offset);
    const replacement = `@${m.name}`;
    const newOffset = content.length;
    content += replacement;
    entities.push({
      uid: m.uid,
      offset: newOffset,
      length: replacement.length,
    });
    uids.push(m.uid);
    cursor = m.offset + m.length;
  }
  content += text.substring(cursor);

  return { content, entities, uids };
}

// ── Build entities from plain @name via memberMap (v1 fallback) ─────────────

/** Char class for valid name characters (mirrors MENTION_PATTERN inner set, no space). */
const NAME_CHAR_RE =
  /[\w\u00C0-\u024F\u4e00-\u9fff\u3040-\u30FF\uAC00-\uD7AF.\-]/;

/**
 * Try to match the longest displayName from memberMap starting at @-position.
 *
 * `sortedNames` must be sorted by length descending.
 * Boundary check: char after the matched name must be a name-terminator
 * (non-name char) to prevent partial matches like "@Anyang Su" hitting
 * "@Anyang Superman".
 */
export function tryLongestMemberMatch(
  text: string,
  atPos: number,
  memberMap: Map<string, string>,
  sortedNames: string[],
): { name: string; uid: string } | undefined {
  const after = text.substring(atPos + 1);
  for (const candidate of sortedNames) {
    if (after.startsWith(candidate)) {
      const ch = text[atPos + 1 + candidate.length];
      if (ch === undefined || !NAME_CHAR_RE.test(ch)) {
        const uid = memberMap.get(candidate);
        if (uid) return { name: candidate, uid };
      }
    }
  }
  return undefined;
}

/**
 * Build entities from plain @name text via memberMap (displayName → uid).
 *
 * Skips @all / @所有人 (handled separately as mentionAll).
 */
export function buildEntitiesFromFallback(
  content: string,
  memberMap: Map<string, string>,
): { entities: MentionEntity[]; uids: string[] } {
  const entities: MentionEntity[] = [];
  const uids: string[] = [];

  // Sort by length descending — longest-prefix-match handles names with spaces.
  const sortedNames = [...memberMap.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(MENTION_PATTERN.source, "g");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const name = match[1];

    // Skip @all / @所有人 — they go through mentionAll, not entities.
    if (name.toLowerCase() === "all" || name === "所有人") continue;

    let uid: string | undefined;
    let matchedName = name;

    const longer = tryLongestMemberMatch(content, match.index, memberMap, sortedNames);
    if (longer) {
      uid = longer.uid;
      matchedName = longer.name;
    } else {
      uid = memberMap.get(name);
    }

    if (!uid) continue;

    const atName = `@${matchedName}`;
    entities.push({ uid, offset: match.index, length: atName.length });
    uids.push(uid);

    // Advance past full match to avoid re-matching trailing chars of long names.
    pattern.lastIndex = match.index + atName.length;
  }

  return { entities, uids };
}

// ── Top-level mention resolution ────────────────────────────────────────────

/**
 * Resolve all mentions in text — runs both structured and plain pipelines,
 * deduplicates by offset, and detects @all / @所有人.
 *
 * @param content Raw text possibly containing @[uid:name] and/or @name
 * @param memberMap Optional displayName→uid map for @name resolution
 * @returns finalContent (with @[uid:name] replaced by @name) + entities + uids + mentionAll
 */
export function resolveMentions(
  content: string,
  memberMap?: Map<string, string>,
): {
  finalContent: string;
  mentionUids: string[];
  mentionEntities: MentionEntity[];
  mentionAll: boolean;
} {
  let finalContent = content;
  let entities: MentionEntity[] = [];

  // v2: @[uid:name] → @name + entities
  const structured = parseStructuredMentions(finalContent);
  if (structured.length > 0) {
    const converted = convertStructuredMentions(finalContent, structured);
    finalContent = converted.content;
    entities = [...converted.entities];
  }

  // v1: @name fallback via memberMap (skip offsets already covered by v2)
  if (memberMap && memberMap.size > 0) {
    const fallback = buildEntitiesFromFallback(finalContent, memberMap);
    const existingOffsets = new Set(entities.map(e => e.offset));
    for (const e of fallback.entities) {
      if (!existingOffsets.has(e.offset)) entities.push(e);
    }
  }

  // Sort by offset, derive uids from sorted entities.
  entities.sort((a, b) => a.offset - b.offset);
  const mentionUids = entities.map(e => e.uid);

  // @all / @所有人 detection.
  const mentionAll = /(?:^|(?<=\s))@(?:all|所有人)(?=\s|[^\w]|$)/i.test(finalContent);

  return { finalContent, mentionUids, mentionEntities: entities, mentionAll };
}

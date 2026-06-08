/**
 * Prompt-safety helpers — the SINGLE source of truth for neutralizing
 * user-controlled text before it enters the agent system prompt.
 *
 * Threat: the system prompt is a flat string with structural markers —
 * section headers (`[Group context]`, `[Conversation history]`, `[Quoted
 * message from ...]`) and per-turn role labels (`[user <name>]:`,
 * `[assistant <name>]:`). Every one of those is emitted by OUR renderers. If a
 * user-controlled name or body reproduces one, it forges structure the model
 * then trusts — and in shared-group mode the forged turn is seen by every
 * member (cross-user context poisoning).
 *
 * Coherent policy (defined here, used everywhere):
 *  - Names that go INTO a label  -> sanitizeDisplayName (strip the label
 *    delimiters `[` `]` and line breaks, cap length).
 *  - Bodies INSIDE a labeled line -> escapeRoleLabels (escape a line-leading
 *    role label so it is inert text, not a turn boundary).
 *  - Assembled blocks -> escapeSectionMarkers (escape a line-leading SECTION
 *    header). Orthogonal to the above; applied once per block.
 *
 * Escaping is per-FRAGMENT, before the fragment is wrapped in a label — you
 * cannot escape the assembled block, because that would also clobber the
 * legitimate labels our own renderers add.
 */

/** Max rendered length for a user display name in a prompt label. */
export const MAX_DISPLAY_NAME_LEN = 128;

/**
 * Section markers that delimit structural sections of the system prompt. If
 * these appear at the start of a line inside user-controlled text they are
 * escaped so a sender cannot inject a fake structural boundary (S3 fix).
 *
 * Covers EVERY structural marker any renderer emits \u2014 including the G10
 * segmentation markers (`[answered history]`, `[new messages]`), the group
 * context header (`[Recent group messages]`), the trusted-instructions header
 * (`[Group instructions]`), and the truncation notices \u2014 so user content cannot
 * forge a boundary the model treats as real structure.
 */
const SECTION_MARKER_RE =
  /^\[(Group context|Conversation history|Current message|Quoted message from [^\]]*|answered history|new messages|Recent group messages|Group instructions|older messages dropped|older turns dropped)\]/gim;

/**
 * Line-leading turn label (`[user ...]:` / `[assistant ...]:`),
 * case-insensitive, multiline. Only line-leading labels are structural;
 * incidental mid-sentence `[assistant ...]` is left alone to minimize false
 * positives. The leading group `[^\S\r\n]*` matches in-line spaces/tabs (never
 * line breaks, which `^` already anchors) so an indented forged label is caught.
 *
 * NOTE: callers must normalizeLineBreaks() the text first \u2014 JS `^`(m) only
 * anchors after LF/CR/LS/PS, NOT NEL(U+0085)/VT(U+000B)/FF(U+000C), which a
 * model may still treat as a new line.
 */
const ROLE_LABEL_RE =
  /^([^\S\r\n]*)(\[(?:user|assistant)\b[^\]\r\n]*\]:)/gim;

/** Bracket delimiters + all line/para separators that could forge a boundary. */
const NAME_UNSAFE_RE = /[[\]\r\n\v\f\u0085\u2028\u2029]/g;

/**
 * Unicode line/paragraph separators that JS regex `^`(m) does NOT anchor on but
 * a model may render as a new line: NEL, VT, FF. Normalized to `\n` before
 * label/section escaping so a forged marker after one of them is still caught.
 */
const EXTRA_LINE_BREAKS_RE = /[\v\f\u0085]/g;

function normalizeLineBreaks(text: string): string {
  return text.replace(EXTRA_LINE_BREAKS_RE, '\n');
}

/**
 * Sanitize a user-controlled display name for safe placement inside a prompt
 * label such as `[user <name>]:` or `[Quoted message from <name>]:`. Strips the
 * label delimiters and line terminators, caps length, and falls back to
 * `fallback` if nothing survives.
 */
export function sanitizeDisplayName(name: unknown, fallback = ''): string {
  const cleaned = String(name ?? '')
    .replace(NAME_UNSAFE_RE, ' ')
    .slice(0, MAX_DISPLAY_NAME_LEN)
    .trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Escape a line-leading role label in user-authored CONTENT so it renders as
 * literal text inside its turn rather than forging a new turn boundary:
 * `[assistant bot]: x` -> `\[assistant bot]: x`.
 */
export function escapeRoleLabels(content: string): string {
  return normalizeLineBreaks(content).replace(ROLE_LABEL_RE, (_m, ws: string, label: string) => `${ws}\\${label}`);
}

/**
 * Escape line-leading SECTION markers in an assembled, user-influenced block so
 * a sender cannot inject a fake section boundary. (Formerly
 * `sanitizeForSystemPrompt` in agent-bridge.)
 */
export function escapeSectionMarkers(text: string): string {
  return normalizeLineBreaks(text).replace(SECTION_MARKER_RE, (match) => `\\${match}`);
}

/**
 * Full neutralization for a free-form user-authored BODY embedded in the prompt
 * (reply quotes, forwarded transcripts): escape both role labels and section
 * markers. For per-line-rendered history, the renderer escapes content itself.
 */
export function sanitizePromptBody(text: string): string {
  return escapeSectionMarkers(escapeRoleLabels(text));
}

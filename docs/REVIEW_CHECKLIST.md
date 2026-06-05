# Code Review Checklist (cc-channel-octo)

> Living document, distilled from Stage 6 (v0.1.1) review experience.
> 9 checks that took five reviewers + multiple "按错按钮" failures to sink in.
> If you skip any of these on a security-adjacent PR, you are repeating
> someone else's mistake from June 2026.

## 0. Stage 6 ground rules

Before opening or reviewing a PR:

- **Work in an isolated `git worktree`.** Shared clone directories
  (`/tmp/cc-channel-octo`) are an accuracy hazard when multiple
  reviewers/authors operate in parallel — checkouts get clobbered, refs
  drift, and you end up validating against the wrong code. Use
  `git worktree add /tmp/cc-<name>-<task> <ref>` and remove it when done.
- **CI is the source of truth, not your laptop.** macOS DNS / file system /
  Node version differ from the GitHub Actions Linux runner. A green local
  test suite with a red CI is a portable-test design bug, not a fix bug.

## 1. CHANGES_REQUESTED re-review: reproduction first, APPROVED last

When re-reviewing a PR you previously CHANGES_REQUESTED:

- **First** write a test that reproduces the specific P0/P1 attack chain
  from your original BLOCKING comment.
- Run it. See the defense in the new code fire green.
- Then APPROVED.

Generic corner-case probes (IP form coverage, input edge cases) **do not**
substitute for reproduction tests — they only re-verify what the PR's own
tests already cover, not the specific attack you said was missing.

## 2. Refresh PR reviews state before clicking APPROVED

```bash
gh api repos/<owner>/<repo>/pulls/<N>/reviews --jq '.[-1]'
```

Confirm no newer BLOCKING / CHANGES_REQUESTED has landed since you started
writing your APPROVED comment. Today's automated reviewers run
asynchronously and can post a new BLOCKING three minutes before you submit.

Retraction (`COMMENTED: I retract`) is honest but **the click itself is the
mistake** — once you have APPROVED, the PR can be merged immediately on
CI green. The review process's job is to never reach the retraction step.

## 3. Reviewer must re-approve after author pushes new commits

After APPROVED, any new commit from the author — even one labelled `nit`
or `fix typo` — must be re-reviewed. A one-character change can introduce
a fresh corner case (PR#40: `truncateByBytes` `i < 3` nit fix introduced a
4-byte UTF-8 U+FFFD bug on `N × 4` clean boundaries).

## 4. Protocol/contract changes require test-suite-wide audit

If the PR changes the signature or runtime behaviour of a helper that is
called from multiple places (e.g. `tryResolveFile` adds `assertPublicUrl`,
`fetchWithRedirectGuard` adds per-hop credential scoping):

```bash
grep -rn '<helper-name>' src/__tests__/
```

Audit **every** caller test for second-order impact. Tests that didn't
previously hit DNS / network / external state may start hitting it.

## 5. Network tests: `vi.mock('node:dns/promises')` by default

Never write a test that depends on the runner's DNS to return NXDOMAIN for
a "fictitious" hostname like `attacker.example.com`. Local macOS, Linux
CI, corporate DNS, and offline development all fail differently — that's a
guaranteed "本地绿 CI 红" portable-test bug.

Pattern:

```typescript
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => {
    if (hostname.includes('example.com')) {
      return [{ address: '203.0.113.42', family: 4 }];  // TEST-NET-3, treated as public
    }
    throw new Error(`Test DNS mock: unexpected hostname ${hostname}`);
  }),
}));
```

Unknown hostname throws — surfaces a test bug instead of silently passing.

## 6. Cross-host header behaviour in fetch wrappers: default-block

Any fetch wrapper that follows redirects must re-decide which headers
(especially `Authorization`, `Cookie`, API keys) to send on each hop.
Reusing the initial `init.headers` across redirects leaks credentials when
hop N is on a different host than hop 0 (PR#38 round-2 P0).

Pattern: per-hop `headerPolicy` callback that gets `currentUrl` and
decides what to attach. `tryResolveFile` ↔ `fetchWithRedirectGuard` in
`url-policy.ts` is the canonical example.

## 7. Byte-safe truncation: probe ALL `N × max-sequence-bytes` boundaries

For any string-cap helper that operates on UTF-8 / surrogate pairs / any
variable-length encoding, the regression suite **must** include `cap =
N × max-sequence-length` clean-boundary cases:

- 2-byte sequences (`ñ`): `cap = N × 2`
- 3-byte sequences (CJK `中`): `cap = N × 3`
- 4-byte sequences (emoji `🚀`): `cap = N × 4`

When the cap lands exactly on the final continuation byte of a complete
sequence, the algorithm must keep the complete sequence — not over-trim
into the leader and produce `U+FFFD`. Simple `for (i < max-len)` loops
get this wrong; walk-back-to-leader + `actualLen === expectedLen` is the
canonical algorithm (PR#42).

## 8. Encoded form path traversal: defer to canonical parser

For URL path validation, never enumerate percent-encoded escape variants
by hand (`%2e`, `%2E`, `%2e.`, `.%2e`, `%252e%252e`, ...). The downstream
WHATWG URL parser decodes them all for dot-segment normalization, but
your `if (seg === '..')` check sees only the literal form.

Canonical fix:

```typescript
const candidate = `${baseUrl}/file/${storagePath}`;
const normalized = new URL(candidate);
if (!normalized.pathname.startsWith('/file/')) return undefined;
```

Defense-in-depth for `%2F` (which WHATWG keeps literal but some servers
decode): reject `%2F` / `%2f` in the storage path outright. Production
URLs never contain it.

## 9. Attacker-input validation: enumerate ALL canonical-equivalent forms

The "修了一半" meta-pattern from Stage 6's S1/S2/S4 (v4-mapped IPv6 hex /
cross-host redirect header reuse / encoded path traversal / server-side
`%2F` decoding) all share one root cause: the validator thinks of one
canonical form when the downstream parser will accept several.

For any validator on attacker-controlled input:

1. **List every canonical-equivalent form** the downstream parser/consumer
   will accept. Use spec docs, not intuition.
2. **Defer to the canonical parser** when possible (WHATWG URL, IP
   parsing libs). Re-implementing canonicalisation by hand is how you
   miss the fourth variant.
3. **Defense-in-depth** for ambiguity zones where the spec is one thing
   but real servers diverge (e.g. WHATWG keeps `%2F` literal but Apache
   `AllowEncodedSlashes` decodes it).
4. **Test matrix**: at minimum, lowercase / uppercase / mixed case
   percent variants + double encoding + the literal form. Add nested
   forms when the parser does recursive normalization.

### 9.1 Case study: WHATWG `new URL()` covers three attacker bypass classes

陈皮皮's cross-team meta-insight (Stage 6 closing): a single canonical
parser can cover multiple attacker bypass classes at once. `new URL()`
for URL sandbox checks:

| Bypass class | Example | How WHATWG normalize handles it |
|--------------|---------|--------------------------------|
| Dot-segment encoding (S4) | `%2e%2e/internal`, `%2E.`, `.%2e`, `%252e%252e` | Decodes `%2e` for dot-segment normalization, collapses `..`; `pathname.startsWith('/file/')` becomes false |
| IPv4 alternative forms | `2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`, `127.0.1` | All canonicalize to `127.0.0.1` in `URL.hostname` → `isPrivateOrLocalAddress` catches via 127/8 |
| IPv6 v4-mapped | `[::ffff:127.0.0.1]`, `[::ffff:7f00:1]` | Bracket literal preserved, S5 covers explicitly (URL doesn't auto-expand v4-mapped) |

#### IPv4 alt-form normalize table (毛豆豆 REPL-verified)

WHATWG `new URL()` canonicalizes every IPv4 alt-form to dotted-quad in
`URL.hostname` BEFORE `isPrivateOrLocalAddress` ever sees it. No manual
variant enumeration needed if you defer to the parser:

| Attacker input | `URL.hostname` | Result |
|----------------|----------------|--------|
| `http://2130706433/` | `127.0.0.1` | rejected (a===127) |
| `http://0x7f000001/` | `127.0.0.1` | rejected |
| `http://0177.0.0.1/` | `127.0.0.1` | rejected |
| `http://0x7f.0.0.1/` | `127.0.0.1` | rejected |
| `http://127.1/` (short-form) | `127.0.0.1` | rejected |
| `http://127.0.1/` (3-octet) | `127.0.0.1` | rejected |
| `http://0/` | `0.0.0.0` | rejected (a===0 → 0.0.0.0/8) |

This is the rule #9 "defer to canonical parser" working as advertised:
one `new URL()` + one `isPrivateOrLocalAddress` covers 7 attacker bypass
classes with zero hand-written variant matchers.

Does NOT cover:

- `%2F` (encoded slash) — spec says preserve literal; server-side
  decoding variance means defense-in-depth at the codebase boundary
  (`if (path.includes('%2F') || path.includes('%2f')) return undefined`).
- Double encoding `%252e%252e` — spec decodes to literal `%2e%2e`, not
  `..`. WHATWG sandbox check accepts (path stays under `/file/`). If
  downstream server double-decodes, that's a server-side concern.
- DNS rebinding — OS resolver result may change between `assertPublicUrl`
  call and `fetch`. Mitigated by short TTL + trusted-domain assumption;
  for full safety, pin IP and connect by IP (breaks TLS SNI / CDN routing).

### 9.2 Cross-parser canonical-form meta-rule

王大锤's elaboration after the fourth same-root finding (`%2F`
server-side decoding). Apply to any attacker-input field:

**1. List every parser the input passes through, end to end.**

URL example: input → Node WHATWG `new URL()` → HTTP server URL decoder
→ CDN edge → OS resolver.
Header example: input → HTTP framework parser → middleware decoder →
application code.

Each parser may normalize, decode, or reinterpret differently. Naming
them explicitly forces you to ask "what canonicalisation does each
layer apply".

**2. For each parser, list the canonical-equivalent forms it accepts.**

From spec docs, not intuition. WHATWG URL normalize covers dot-segment
encoding + IPv4 alt forms + IPv6 bracket literal. It does NOT cover
`%2F` decoding (server-side responsibility) or double encoding
(intentional literal preservation).

**3. Defer to spec-canonical parser + check a post-normalize invariant.**

Don't hand-roll variant enumeration. Use what the parser already does,
then assert the invariant on its normalized output. Canonical example:

```typescript
const candidate = `${baseUrl}/file/${storagePath}`;
const normalized = new URL(candidate);
if (!normalized.pathname.startsWith('/file/')) return undefined;
```

One check covers every dot-segment encoding variant WHATWG knows about.

**4. Defense-in-depth at the boundary you control.**

Where a downstream parser is outside your codebase (server-side / CDN /
proxy) and the spec leaves room for divergent behaviour, add a cheap
"reject impossible legitimate inputs" guard. Production data
distribution is narrower than attacker payload set; the false-positive
risk is negligible.

Example: `if (path.includes('%2F') || path.includes('%2f')) return undefined;`

Real production storage paths never contain `%2F` — a filename like
`a/b.png` would be encoded as `%252F` at most. Cheap rejection covers
Apache `AllowEncodedSlashes On`, certain reverse proxies, certain CDNs
that decode `%2F` server-side and re-resolve dot-segments. Server-side
audit ticket tracks the proper long-term fix; this is the safety net at
the boundary we control.

### 9.3 Recurrence count

The **five** "修了一半" findings from Stage 6 PRs all share one root pattern:
implementing attacker-input validation by enumerating one canonical form
when the downstream parser will accept several, OR by pinning the
invariant at one layer of the parser chain instead of the strictest
enforcement boundary.

1. PR#38 round-2: v4-mapped IPv6 hex form bypass `isPrivateOrLocalAddress`
2. PR#38 round-2: cross-host redirect Authorization header reuse
3. PR#38 round-3: encoded path traversal `%2e%2e` bypass literal `..` check
4. PR#38 round-4: `%2F` server-side decoding (out-of-scope for buildMediaUrl, tracked v0.1.2)
5. PR#45 round-1: SVG XSS in-app msgType File fix but CDN-served
   `Content-Type: image/svg+xml` lets browser parse and execute script

If you find yourself adding a fifth variant check OR pinning the invariant
at a non-terminal parser layer, stop and apply rule #11 (§11 below).

---

## 10. Challenging "missing variant" claims: REPL-verify before opening follow-up scope

毛豆豆's Stage 6 closing lesson, after a "S5 might miss IPv4 alt-forms"
self-correction during C2 review:

When you suspect an attacker-input validator is missing a canonical
variant, **run a REPL / quick test matrix to prove the bypass actually
works** *before* opening a follow-up ticket / blocking the PR / asking
for scope expansion.

Abstract reasoning ("it might miss IPv4 hex form") often misses the
broader parser context ("WHATWG `URL.hostname` already canonicalizes
every IPv4 alt-form to dotted-quad"). The seven-row table in §9.1 is
the direct artefact — 毛豆豆 ran each input through Node `new URL()`,
saw they all normalize to `127.0.0.1`, and withdrew the follow-up
proposal.

Why this matters:

- **Reviewer time is not free.** A speculative follow-up ticket pulls
  scope-owner attention, opens v0.1.2 noise, and bloats GROUP.md.
- **Over-correction has compounding cost.** Adding hand-written variant
  matchers on top of a parser that already canonicalizes is dead code
  *and* misleading future reviewers (suggests the parser doesn't cover
  what it actually covers).
- **The "defer to canonical parser" rule (§9) cuts both ways.** If you
  trust the parser for the canonical fix, you also need to verify what
  the parser already covers — don't enumerate variants the parser
  already handles.

### Recipe

1. Identify the parser in the chain that handles the variant you
   suspect is missing.
2. Run 4–7 inputs through it in a REPL / one-off test, record the
   normalized output.
3. If the parser already canonicalizes → no follow-up needed; the
   validator that runs on parser output already covers your case.
4. If the parser does NOT canonicalize → you have a real finding; open
   the follow-up with the REPL output as evidence.
5. **Either way, attach the table to your comment / ticket.** Future
   reviewers don't need to re-run your matrix.

### Anti-pattern

```
"I'm worried that S5 might miss IPv4 hex form bypass"
→ immediately open follow-up issue
→ PM tracks it for v0.1.2
→ someone else burns 30min discovering WHATWG already handles it
→ issue closed wontfix, scope noise persists
```

### Correct pattern

```
"I'm worried that S5 might miss IPv4 hex form bypass"
→ 5 minutes in Node REPL: new URL('http://2130706433/').hostname → '127.0.0.1'
→ same for 0x7f000001, 0177.0.0.1, 127.1, 127.0.1, 0x7f.0.0.1, 0/
→ conclusion: WHATWG canonicalizes all 7, S5 covers via 127/8
→ no follow-up needed; if anything, document the parser coverage
  in REVIEW_CHECKLIST.md as a case study
```

---

## Quick recall card

When in doubt, run through this in order:

1. Worktree-isolated build? ✓
2. CI green on the exact head SHA? ✓
3. Latest review state checked just before APPROVED? ✓
4. Reproduction test for the original P0 in place? ✓
5. All `<helper>` call sites audited after signature change? ✓
6. DNS mocked, not relying on NXDOMAIN? ✓
7. Cross-host header scoping verified? ✓
8. Byte-safe truncation probed at N × max-seq boundaries? ✓
9. URL validation deferred to canonical parser? ✓
10. Canonical-equivalent forms enumerated for attacker input? ✓
11. Suspected missing variant REPL-verified before opening follow-up? ✓

If any of 1-11 is missing, you are not done.

---

## 11. Pin security invariant at the strictest enforcement boundary

王大锤's Stage 6 closing element, after 毛豆豆 PR#45 P1-5 SVG XSS
residual finding (the 5th "修了一半" recurrence).

When fixing an injection / XSS / RCE-class issue:

1. **List every parser the attacker input passes through**, from the entry
   API surface to the **terminal rendering or execution boundary** —
   the latest layer that interprets the input semantically.
2. **Pin the security invariant at the strictest enforcement boundary**,
   not at the layer most familiar to you. "Familiar" usually means the
   in-app parser; "strictest" usually means the layer closest to the
   attacker's terminal goal (browser render, shell exec, SQL exec).
3. **Write the test against the invariant itself**, not at an adjacent
   behaviour that happens to correlate today. If the invariant is
   "browser must NOT render this as SVG", the test asserts
   `Content-Disposition === 'attachment'` or `Content-Type !== 'image/svg+xml'`,
   not `MessageType === File` (which is correlated but not the invariant).

### 11.1 Case study: SVG XSS in PR#45

Attacker payload → several parsers in series:

```
  user uploads SVG (with embedded <script>)
    ↓
  inbound: isSafeInlineImage("image/svg+xml")        ← in-app msgType parser
    ↓  (msgType = File, won't render in IM bubble)
  uploadFileToCOS(buf, contentType="image/svg+xml") ← CDN-serving parser
    ↓  (object stored with Content-Type: image/svg+xml, no Content-Disposition)
  CDN serves URL                                     ← terminal rendering parser
    ↓
  user opens CDN URL in browser
    ↓
  browser sees Content-Type: image/svg+xml → renders SVG
    ↓
  embedded <script> executes in CDN origin context   ← attacker goal
```

PR#45 fix at the **in-app msgType** layer (msgType=File prevents IM bubble
rendering) is necessary but **not sufficient** — the CDN-served parser
still interprets it as SVG and the browser still executes the script.

The **strictest enforcement boundary** is the CDN serving layer:
`Content-Disposition: attachment` forces browser download (no render)
regardless of Content-Type; optional `Content-Type: application/octet-stream`
is defense-in-depth.

Fix matrix:

| Layer | What it controls | Fix |
|-------|------------------|-----|
| in-app `isSafeInlineImage` | IM bubble inline rendering | `msgType=File` (PR#45 done) |
| `uploadFileToCOS` SVG arg | What CDN serves | `Content-Disposition: attachment` + override `Content-Type` |
| Test invariant | Security guarantee | `ContentDisposition === 'attachment'` (not `msgType === File`) |

### 11.2 MIME-aware parsing (related)

Any `isSafeXxx(mimeType)` gate using `===` strict equality on a MIME type
string is bypassable. RFC 2045 specifies MIME type matching as
case-insensitive, and content-type strings often carry parameters
(`; charset=utf-8`) or variant suffixes.

Five bypass variants 毛豆豆 + 王大锤 REPL-verified against PR#45's `isSafeInlineImage`:

| Input MIME | Strict `===` result | Should be |
|-----------|---------------------|-----------|
| `image/svg+xml; charset=utf-8` | true (BYPASS) | unsafe |
| `image/svg+xml;charset=utf-8` | true (BYPASS) | unsafe |
| `image/svg+xml ` (trailing space) | true (BYPASS) | unsafe |
| `image/SVG+xml` | true (BYPASS) | unsafe |
| `image/svg` (no `+xml`) | true (BYPASS) | unsafe |

RFC 6838-compliant pattern:

```typescript
function normalizeMime(input: string): string {
  return input.split(';')[0].trim().toLowerCase();
}
const normalized = normalizeMime(contentType);
if (normalized === 'image/svg+xml' || normalized === 'image/svg') return false;
```

### 11.3 Why this matters

The "strictest enforcement boundary" rule is the natural extension of
§9's "defer to canonical parser" once you accept that there are
multiple parsers in the chain. §9 says don't enumerate canonical forms
within one parser; §11 says don't enumerate fixes across multiple
parsers — pin the invariant at the layer that actually controls the
attacker's terminal goal.

Symptom in code review: a "fix" that adds a check at parser layer N
while leaving parsers N+1, N+2, ... untouched. The attacker just
shifts the entry point one layer down.

Symptom in tests: assertions on a *correlate* of the security invariant
("msgType is File") rather than the invariant itself ("browser cannot
render as SVG"). Today the correlation holds; tomorrow it breaks silently.

---

## Quick recall card (revised)

When in doubt, run through this in order:

1. Worktree-isolated build? ✓
2. CI green on the exact head SHA? ✓
3. Latest review state checked just before APPROVED? ✓
4. Reproduction test for the original P0 in place? ✓
5. All `<helper>` call sites audited after signature change? ✓
6. DNS mocked, not relying on NXDOMAIN? ✓
7. Cross-host header scoping verified? ✓
8. Byte-safe truncation probed at N × max-seq boundaries? ✓
9. URL validation deferred to canonical parser? ✓
10. Canonical-equivalent forms enumerated for attacker input? ✓
11. Suspected missing variant REPL-verified before opening follow-up? ✓
12. Security invariant pinned at strictest enforcement boundary, not
    the most familiar parser layer? ✓

If any of 1-12 is missing, you are not done.

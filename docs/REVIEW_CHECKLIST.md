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

The **five** "修了一半" findings on the same root pattern (implementing
attacker-input validation by enumerating one canonical form when the
downstream parser accepts several):

1. PR#38 — IPv6 v4-mapped hex (`[::ffff:7f00:1]`)
2. PR#38 — cross-host redirect header reuse leaking `Authorization`
3. PR#38 — encoded path traversal (`%2e%2e/`, `%2E%2E/`, `..%2f..`)
4. PR#38 (server-side audit ticket) — `%2F` server-side decoding variance
5. PR#45 — SVG XSS cross-parser: in-app MIME canonical / RFC 2397
   data-URI parser / CDN serving Content-Disposition all needed
   independent enforcement; "fix one, leave two" mode

If you find yourself adding a sixth variant check, stop and rewrite the
validator to defer to the spec parser plus a defense-in-depth boundary
guard (see §9.2 + §11).

---

## 10. Performance assertions must be reverse-verifiable

Any test that includes a timing assertion (e.g. `expect(elapsed).toBeLessThan(500)`)
MUST be reverse-verified: `git revert` the helper / fast-path under test
and confirm the assertion **fails**. If revert still passes, the assertion
is theatre and must be deleted (not relaxed by raising the threshold).

Why: V8 string optimizations, RAM bandwidth, internal representation,
and CPU frequency scaling all decouple big-O analysis from wall-clock
time in micro-benchmarks. PR#46 had a `truncateByBytes` perf assertion
asserting `< 500ms` for a payload that completed in 49ms even after
reverting the `O(n)` walk-back helper to the naive `O(n²)` implementation
— so the assertion never could have caught the regression it claimed to
guard. Two reviewers (齐静春, 王大锤) independently reached the same finding
by running the reverse-verify experiment.

### 10.1 What to keep, what to delete

| Assertion kind | Keep? | Why |
|----------------|-------|-----|
| byte-safety / correctness invariant | yes | covers real win, regression-visible |
| order-of-magnitude perf bound (e.g. `< 60s` on 100KB) | maybe | only if revert reliably fails on the CI runner; document the headroom |
| micro-benchmark threshold (e.g. `< 500ms`) | **no** | V8 optimization makes naive impl pass too; misleading |

Byte-safety / correctness assertions are the actual security or
behavioural win. If a perf assertion is added "for safety", apply
§10.5 reverse-verify before merging.

### 10.5 Reverse-verify protocol (operationalisation)

Before merging any test with a timing assertion:

1. `git revert <helper-commit>` (or stash the fast-path).
2. Re-run the test on the same CI runner / fresh worktree.
3. If the test still passes, the perf assertion is theatre. **Delete
   the perf assertion** in this PR. Do NOT raise the threshold to make
   it "work" — raising the threshold preserves the lie.
4. Keep correctness / byte-safety assertions in the same test; those
   cover the real win.
5. Document the reverse-verify result in the PR description so future
   maintainers know why the perf assertion is absent.

This rule applies symmetrically to `setTimeout`-based heuristics,
`performance.now()` deltas, and any test whose pass/fail depends on
wall-clock duration on the runner.

---

## 11. Pin assertions at the strictest enforcement boundary

When a defense-in-depth fix lands across multiple layers (in-app filter
→ encoder → storage / CDN / browser), tests MUST assert at the strictest
enforcement boundary — the parser the attacker actually reaches — not
at the most convenient or most familiar in-process layer.

The assertion that *cannot* be bypassed by drift in upstream layers is
the PRIMARY assertion. Upstream layer assertions are SECONDARY
correlates: they help regression visibility but they don't enforce the
security invariant.

**Reverse-verify rule** (per §10.5 dogfooded onto §11): if reverting
the change does NOT fail the test, the test is not testing the change.
PRIMARY and SECONDARY assertions must each independently fail when
their respective layer is reverted; if only one fails for both reverts,
one of them is decorative.

### 11.1 Case study: SVG XSS PR#45 P1-5 hardening test

Terminal parser the attacker can reach = the BROWSER fetching the CDN
object. The strictest enforcement boundary is what the CDN serves —
specifically `Content-Disposition: attachment`, which forces download
regardless of `Content-Type` drift.

- **PRIMARY** (load-bearing): `expect(putCall.ContentDisposition).toMatch(/^attachment/i)`
  — what the CDN sends, what the browser enforces.
- **SECONDARY** (correlate): `expect(sendBody.payload.type).toBe(8)`
  — `MessageType.File` in the IM payload. Helps the IM bubble UX and
  catches mis-routing, but if msgType drifts to `Image` while
  Content-Disposition stays `attachment`, the browser still downloads.

Both must independently fail when their layer reverts (verified for
PR#47 — see PR#47 review COMMENTED record on a4577a3). If reverting
Layer 1 doesn't fail the SECONDARY assertion, the SECONDARY assertion
is silently covered by upstream defense-in-depth and should be split
into a narrow test that pins Layer 1 in isolation (per §11.2).

### 11.2 Multi-layer fix → multi-narrow-test pattern

When a fix touches N layers of defense-in-depth, prefer N narrow tests
(each pinning one layer's invariant in isolation) over one broad test
that asserts the end-to-end outcome.

Why: a broad end-to-end test passes as long as ANY layer enforces the
invariant, so it can silently hide that an upstream layer has stopped
working. Narrow tests force each layer to carry its own weight.

PR#45 SVG XSS hardening shipped 3 layers (in-app MIME canonical /
RFC 2397 data-URI parser / CDN Content-Disposition); the unified test
asserted only the end-to-end outcome. PR#47 split the assertion into
PRIMARY/SECONDARY structure (Step 1). Splitting into 3 layer-pinned
tests is the full §11 application (王大锤 PR#45 review #1 follow-up,
recommended for PR#48 / PR#49 follow-up).

### 11.3 Comment template (PRIMARY / SECONDARY)

When test structure encodes a layered defense, annotate the boundary
explicitly so the next maintainer doesn't have to re-derive the model:

```typescript
// ─── §11 strictest enforcement boundary invariant (PRIMARY ASSERT) ──
// The terminal parser the attacker can reach is <X>. The strictest
// enforcement boundary is <Y>, which is what the <terminal parser>
// actually enforces regardless of upstream drift. Pin assertion to the
// invariant itself per REVIEW_CHECKLIST.md §11.
expect(<strict-boundary-invariant>).toMatch(...);

// ─── §11 defense-in-depth correlates (SECONDARY ASSERTS) ─────────
// These hold in current implementation but are NOT the security
// invariant — if <upstream layer> drifts while <strict boundary> still
// holds, the user is still safe. Kept for regression visibility.
expect(<upstream-correlate>).toBe(...);
```

### 11.4 MIME-type canonicalisation: a 4-step checklist

MIME types are the most common attacker-input field where strictest
enforcement boundary thinking matters. PR#45 SVG XSS hardened against
three variants of the same root issue — apply this 4-step pattern
whenever you write a MIME-type filter:

1. **Strip parameters**: `contentType.split(';')[0].trim()`. `image/svg+xml; charset=utf-8` and `image/svg+xml` must canonicalise to the same value before comparison.
2. **Lowercase**: `.toLowerCase()`. MIME types and the `image/` prefix are case-insensitive per RFC 6838 §4.2; `Image/Svg+Xml` is the same type as `image/svg+xml`.
3. **RFC 2397 data URI handling**: when extracting from `data:` URLs,
   parse the MIME segment up to the first `;` or `,` boundary — NOT a
   regex that assumes no parameters. `data:image/svg+xml;base64,...`,
   `data:Image/Svg+Xml;charset=utf-8;base64,...`, and
   `data:IMAGE/SVG+XML ;base64,...` (with a stray space) must all
   normalize to the canonical MIME for downstream checks.
4. **Content-Disposition pin at storage / CDN layer**: even after a
   correct in-app MIME canonical check, the CDN-served object can be
   rendered inline by the browser based on `Content-Type` alone. Pin
   `Content-Disposition: attachment` for SVG / unknown image types at
   the upload layer — this is the strictest enforcement boundary per
   §11, and is the PRIMARY assertion in any related test.

---

## 12. Author-side state check before push

Mirror of §2 (reviewer-side state check before APPROVED), applied to
the author side:

Before `git push --force-with-lease` to a branch that backs an open PR,
run:

```bash
gh pr view <N> --repo <owner/repo> --json state,mergedAt
```

If `state` is `MERGED` or `mergedAt` is non-null, **STOP**. Force-pushing
to a merged PR's branch creates dangling commits (the branch HEAD drifts
to a SHA that's never on `main`). The fix is to open a follow-up PR
from the latest `main`, not to amend the merged one.

The symmetric reviewer-side check (§2) verifies no newer
`CHANGES_REQUESTED` review supersedes the head you're about to approve.
Together the two form the author/reviewer state-check pair: any time
you take a destructive or irreversible PR action, verify state first.

This rule was introduced after the PR#46 dangling-commit incident
(commits 34cdeed / 15de583 amended onto a force-pushed branch after
the PR had already squash-merged as d0abb5b; the amendments are not
on `main` and have to be redone as a follow-up PR).

---

## 13. Markdown URL parsing: CommonMark spec compliance (depends on §11.4)

Markdown image / link regexes that match `[^)\s]+` for the URL field
are CommonMark-spec-compliant — CommonMark requires URL-encoded spaces
(`%20`) inside `(...)`. A markdown URL with a literal space (e.g.
`![](data:image/svg+xml; charset=utf-8,...)`) will be silently skipped
by the regex.

**This is not a security gap**: the image is not processed, so no
inline render happens, so no XSS path exists. It IS a usability gap:
legitimate data URIs with literal spaces in parameters won't upload.

**Threat-model dependency (explicit)**: §13's silent-skip design is
safe ONLY because §11.4 Step 4 (`Content-Disposition: attachment` pin
at the CDN / storage layer) is in force. Relaxing `[^)\s]+` to accept
literal spaces widens the set of markdown URLs that reach the upload
pipeline; any drift in §11.4 Step 4 then re-exposes the inline-render
path. The two rules are coupled: removing or weakening either one
requires reverse-verifying the other still holds.

**Action required**: when adding or modifying a markdown URL regex, add
an inline comment at the regex definition site explaining the design
choice, so the next maintainer doesn't "fix" the regex to accept
spaces and accidentally widen the attacker-input surface.

Example annotation (place at `MARKDOWN_IMAGE_RE` / `MARKDOWN_LINK_RE`
definition):

```typescript
// CommonMark spec requires URL-encoded spaces (%20); spaced URLs in
// markdown ![](...) are silent-skipped by design (image isn't processed
// = no inline render = no XSS gap). Do not relax `[^)\s]+` to accept
// spaces — that widens the attacker-input surface that §11.4 MIME
// canonicalisation depends on. See REVIEW_CHECKLIST.md §13.
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;
```

---

## 14. New §N self-rule: declare trigger + revert-invariant + sunset

Meta-rule. Every new checklist section §N (and every new subsection
§N.M that introduces a standalone rule) MUST declare three things in
its opening prose, so the checklist itself remains finite, falsifiable,
and auditable. Without this, the checklist grows monotonically and
silently accumulates dead rules whose original trigger is forgotten.

Three mandatory declarations:

1. **Trigger condition** — the concrete code pattern, PR action,
   review state, or runtime symptom that activates the rule. If you
   cannot name a trigger, the rule is decoration and must not be added.
2. **Revert-test invariant** — the §10.5 / §11 reverse-verify analogue
   for a docs rule: "if I delete this rule from the checklist,
   what observable failure mode returns?" If the answer is "nothing
   observable changes," the rule is not adding signal and must not be
   added.
3. **Sunset clause** — the upstream condition under which the rule
   becomes obsolete (spec upgrade, tooling change, language feature
   landing). Permanent rules write `sunset: none (permanent invariant)`
   explicitly — that is itself a declaration, not an omission.

Pairs with §2 (reviewer state check) / §12 (author state check) to
close the rule-system self-reference loop: any destructive or
irreversible PR action verifies state first; any new permanent rule
added to the rulebook itself declares its own falsifiability boundary.

### 14.1 Retroactive dogfooding for §10 – §13

Applying §14 backward to the §10 – §13 batch added in this PR
(documented here so the dogfooding cycle closes inside the same PR):

- **§10 Performance assertions must be reverse-verifiable**
  - trigger: a test asserts wall-clock / throughput / size in a fixed numeric threshold
  - revert-invariant: deleting §10 lets PR#46-style 500ms-theatre assertions reappear; the test passes pre- and post-fix with no signal
  - sunset: none (permanent invariant; perf-theatre risk is intrinsic to fixed-threshold assertions)
- **§11 Pin assertions at the strictest enforcement boundary**
  - trigger: a fix touches ≥2 layers of a parse → validate → encode → render → enforce pipeline
  - revert-invariant: deleting §11 lets layered-defense tests assert at the upstream layer only; PRIMARY-layer drift becomes invisible (PR#45 SVG XSS reproduction)
  - sunset: none (permanent invariant; defense-in-depth is structural)
- **§12 Author-side state check before push**
  - trigger: `git push --force-with-lease` (or any history-rewriting push) to a branch that backs an open PR
  - revert-invariant: deleting §12 lets the PR#46 dangling-commit incident recur (force-push to a merged PR's branch creates commits that never reach `main`)
  - sunset: none (permanent invariant; GitHub squash-merge semantics will not change)
- **§13 Markdown URL parsing: CommonMark spec compliance**
  - trigger: a markdown URL regex (`MARKDOWN_IMAGE_RE` / `MARKDOWN_LINK_RE` / equivalent) is added or modified
  - revert-invariant: deleting §13 lets a future maintainer "fix" `[^)\s]+` to accept literal spaces, widening the attacker-input surface that §11.4 Step 4 depends on
  - sunset: revisit if CommonMark spec changes URL-encoding requirements, or if the markdown parser is replaced with a non-regex implementation
- **§14 (this section)**
  - trigger: a new §N or rule-introducing §N.M is added to this checklist
  - revert-invariant: deleting §14 lets future additions skip trigger / revert / sunset declarations; the checklist grows unbounded and dead rules accumulate silently
  - sunset: none (permanent invariant; rule-system self-reference is required regardless of rule count)

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
11. Perf assertions reverse-verified per §10.5? ✓
12. Assertions pinned at strictest enforcement boundary per §11 (PRIMARY/SECONDARY split when defense is layered)? ✓
13. Author-side `gh pr view <N> --json state,mergedAt` run before force-push to an open PR's branch? ✓
14. New §N (or rule-introducing §N.M) declares trigger condition + revert-test invariant + sunset clause per §14? ✓

If any of 1-14 is missing, you are not done.


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

The four "修了一半" findings from PR#38 (v4-mapped IPv6 hex /
cross-host redirect header reuse / encoded path traversal / server-side
`%2F` decoding) are all instances of the same root pattern: implementing
attacker-input validation by enumerating one canonical form when the
downstream parser will accept several.

If you find yourself adding a fifth variant check, stop and rewrite the
validator to defer to the spec parser instead.

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

If any of 1-10 is missing, you are not done.

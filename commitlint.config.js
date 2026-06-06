// Conventional Commits enforcement (commit-msg hook).
// Rules are loosened to match this repo's established, real-world style —
// the goal is to lock in the convention we already follow, not to reject it.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Subjects here run long and technical (existing max ~114 chars).
    "header-max-length": [2, "always", 120],
    // Scopes use uppercase technical IDs (C2, S1, Q1) and sometimes spaces
    // (e.g. "C2 P1-5 hardening") — don't fight that.
    "scope-case": [0],
    // Subjects carry code identifiers: O(n), RichText, AES-CBC, DNS, %2F.
    "subject-case": [0],
    // Bodies/footers contain technical detail that exceeds 100 cols.
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};

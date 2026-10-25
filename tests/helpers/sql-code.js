// Shared SQL helpers for the migration guards. The implementation lives in
// scripts/lib/sql-code.mjs (GUARDSTRIP.1, C74) so the check:* scripts and the
// guards read SQL the same way: one quote-aware pass that pairs each $tag$
// body with its own closing tag. Never strip SQL comments with a regex
// (tests/comment-strip-meta-guard.test.js fails on one).

export { sqlCode, ident, splitTop } from '../../scripts/lib/sql-code.mjs'

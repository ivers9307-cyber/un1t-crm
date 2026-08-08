// ILIKE-metacharacter escaping for equality-by-ILIKE lookups.
//
// THE BUG THIS FILE EXISTS FOR (found 2026-08-07)
// `.ilike(col, value)` is the idiom this codebase uses for a CASE-INSENSITIVE
// EQUALITY check — "find the contact with this email". But ilike takes a LIKE
// *pattern*, and both wildcards are legal email characters that
// normalizeEmail() (src/lib/email-inbox.js, `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`)
// happily accepts:
//
//   _  matches any single character  → a_b@example.com  ALSO matches axb@example.com
//   %  matches any run of characters → %@example.com    matches EVERY address at
//                                      that domain; %@%.% matches essentially all
//
// Two consequences, both silent:
//   1. Accidental mismatch — a real member whose address contains an underscore
//      is filed against a lookalike contact. The caller's pick is deterministic,
//      so nothing errors.
//   2. Deliberate over-match — the sender address on an inbound email is
//      attacker-controlled, so `From: %@example.com` lets a stranger's mail be
//      linked to (and carry the identity of) whichever contact the caller picks.
//
// Escaping — rather than switching these call sites to .eq() — is deliberate:
// contacts are stored with mixed case, so .eq() on the raw value would MISS
// legitimate matches. Escaping is behaviour-preserving for every address that
// does not contain a metacharacter, and changes only the pathological ones.
//
// This is NOT a substitute for scoping. Escaping makes the query mean what it
// says; callers still owe their own location/org filter.

/**
 * Escape the LIKE metacharacters in `s` so it matches literally under
 * ILIKE. Postgres LIKE uses backslash as the default escape character, so
 * `\` must itself be escaped — and FIRST, or we would re-escape the
 * backslashes we just introduced.
 *
 * Pure. Non-strings (null/undefined/numbers) collapse to a string first, so a
 * caller that forgot to validate gets a harmless literal rather than a pattern.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function escapeLikePattern(s) {
  return String(s ?? '').replace(/[\\%_]/g, (c) => `\\${c}`)
}

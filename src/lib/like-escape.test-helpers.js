// A faithful ILIKE evaluator for the supabase mocks. TEST SUPPORT ONLY —
// nothing in src/ may import this at runtime.
//
// WHY THIS EXISTS
// Every hand-rolled supabase fake in this repo used to model `.ilike(col, val)`
// as plain case-insensitive EQUALITY:
//
//     if (f[0] === 'ilike') return String(row[f[1]]).toLowerCase() === String(f[2]).toLowerCase()
//
// which is what the call sites *meant* but not what Postgres *does*. That is
// precisely why the 2026-08-07 wildcard bug (see src/lib/like-escape.js) lived
// in the inbound-email webhook with a green suite: under the mock, the
// attacker's `%@example.com` matched exactly one contact — the one whose email
// was literally that string, i.e. nothing — so no test could see the over-match.
// A mock that is more forgiving than production hides the bug it should catch.
//
// Modelling the real semantics means a test written against these fakes fails
// before the escaping fix and passes after it.

// LIKE metacharacters, and the escape hatch. Postgres LIKE escapes with a
// backslash by default: `\%` is a literal percent, `\_` a literal underscore,
// `\\` a literal backslash.
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g

/**
 * Translate a SQL LIKE pattern into an equivalent RegExp source string.
 *
 * Walks the pattern once rather than doing sequential .replace() passes: a
 * replace chain cannot tell an escaped `\%` from a wildcard `%` without
 * re-scanning, which is the same class of mistake this helper exists to catch.
 *
 * @param {string} pattern
 * @returns {string} regex source, anchored by the caller
 */
function likePatternToRegexSource(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '\\') {
      // Escaped metacharacter — take the next char literally. A trailing lone
      // backslash matches a literal backslash (Postgres errors here; being
      // lenient keeps the helper from throwing inside a test fake).
      const next = pattern[i + 1]
      if (next === undefined) { out += '\\\\'; break }
      out += next.replace(REGEX_SPECIAL, '\\$&')
      i += 1
      continue
    }
    if (ch === '%') { out += '.*'; continue }
    if (ch === '_') { out += '.'; continue }
    out += ch.replace(REGEX_SPECIAL, '\\$&')
  }
  return out
}

/**
 * True when `value` matches the SQL LIKE `pattern`, case-insensitively —
 * i.e. what Postgres `value ILIKE pattern` returns.
 *
 * @param {string} pattern  the LIKE pattern (wildcards active unless escaped)
 * @param {unknown} value   the column value
 * @returns {boolean}
 */
export function ilikeMatches(pattern, value) {
  const re = new RegExp(`^${likePatternToRegexSource(String(pattern ?? ''))}$`, 'is')
  return re.test(String(value ?? ''))
}

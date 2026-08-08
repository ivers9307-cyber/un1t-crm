// EMAIL-INBOUND-POISON.1 — strip what Postgres cannot hold, before an INSERT.
//
// Postgres `text` cannot store a NUL byte (the insert errors, it is not
// truncated), and a lone UTF-16 surrogate cannot be encoded as valid UTF-8 —
// same failure. jsonb rejects \u0000 too, which is why a NUL-bearing webhook
// payload could not even be DEAD-LETTERED without this. Both are trivial to
// put in an email body/subject/display-name, the payload is identical on every
// Postmark retry, so the resulting 5xx was deterministic: a poison message
// burned its whole retry schedule and was never filed.
//
// This is the body-text sibling of safeAttachmentFilename
// (email-attachment-quota.js), WITHOUT the filename rules — newlines, tabs and
// every other control character are legal and meaningful in a message body and
// survive untouched. Only the two classes Postgres itself refuses are removed.
//
// Pure (no DB, no env) so both the webhook route and the shared dead-letter
// helper can use it.

const NEEDS_STRIP = /[\u0000\ud800-\udfff]/

/**
 * `value` with NUL bytes and lone surrogates removed. Non-strings pass through
 * untouched (so `sanitizeDbText(null) || fallback` composes naturally).
 *
 * Iterating with for..of walks code points: a valid surrogate PAIR arrives as
 * one code point outside the surrogate range and survives; an orphan half
 * arrives alone, inside the range, and is dropped. That also cleans up the
 * orphan a UTF-16 slice (truncateHtmlBody) can create at its cut point — which
 * is why callers sanitise AFTER truncating, never before.
 */
export function sanitizeDbText(value) {
  if (typeof value !== 'string') return value
  // Fast path: the probe regex is unflagged, so it matches the halves of valid
  // pairs too — strings with any surrogate take the slow walk, which keeps them.
  if (!NEEDS_STRIP.test(value)) return value
  let out = ''
  for (const ch of value) {
    const cp = ch.codePointAt(0)
    if (cp === 0) continue
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    out += ch
  }
  return out
}

/**
 * A deep copy of `value` with every string — keys included — run through
 * sanitizeDbText, so the result is storable in a jsonb column. Used by
 * deadLetterWebhook: the payloads most likely to need dead-lettering are
 * exactly the poison ones jsonb would otherwise refuse.
 */
export function sanitizeJsonForDb(value) {
  if (typeof value === 'string') return sanitizeDbText(value)
  if (Array.isArray(value)) return value.map(sanitizeJsonForDb)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[sanitizeDbText(k)] = sanitizeJsonForDb(v)
    return out
  }
  return value
}

// EMAIL-TICKET.5 — the sign-off appended to a ticket reply (mig 493).
//
// PLAIN TEXT, ALWAYS. `profiles.email_signature` is a text column with no
// markup path on purpose: a reply is composed as plain text and converted to
// HTML on send, so a signature that could carry markup would be the ONE
// un-sanitised HTML path into outbound mail. The safe shape is therefore
// "append to the TEXT, then convert the whole thing" — callers build the
// signed body with appendSignature() and hand the RESULT to their existing
// text→HTML escaper. Never escape the body and concatenate raw signature
// HTML afterwards; that reintroduces exactly the hole the column type closes.
//
// NEVER on an internal note. A note is written to the thread and sent to
// nobody, so signing it is noise on a staff-only line.
//
// The empty cases are the ones that bite: NULL (nobody has set one), '' (they
// cleared it) and a block of whitespace must all append NOTHING — not a
// dangling separator with nothing under it.

/**
 * RFC 3676 §4.3 signature separator: two hyphens, ONE SPACE, then the line
 * break. The trailing space is not a typo and must not be linted away — it is
 * what Gmail, Apple Mail and Thunderbird key on to collapse a signature out of
 * a quoted reply. A bare "--" line is not the convention and renders as two
 * literal hyphens in the member's mail client.
 */
export const SIGNATURE_SEPARATOR = '-- '

/** Mirrors the profiles_email_signature_len CHECK from mig 493. */
export const MAX_SIGNATURE_LENGTH = 2000

/**
 * The signature exactly as it will be appended, or '' when there is none.
 *
 * CRLF is normalised to LF so a signature pasted out of a mail client doesn't
 * put stray carriage returns into the body, and the whole thing is trimmed so
 * trailing blank lines can't smuggle in an empty-looking-but-present value.
 *
 * @param {string|null|undefined} signature
 * @returns {string}
 */
export function normalizeSignature(signature) {
  if (typeof signature !== 'string') return ''
  return signature.replace(/\r\n?/g, '\n').trim()
}

/**
 * Would this signature add anything at all? The UI uses this to decide
 * whether to show the "this gets added" preview; NULL/''/whitespace are all
 * "no signature".
 *
 * @param {string|null|undefined} signature
 * @returns {boolean}
 */
export function hasSignature(signature) {
  return normalizeSignature(signature).length > 0
}

/**
 * body + blank line + "-- " + signature.
 *
 * Returns the body UNCHANGED when there is no signature — no separator, no
 * trailing newlines, nothing. That is the case that matters: every reply in
 * the system today has no signature, and a stray "--" on all of them would be
 * a visible regression for every member.
 *
 * @param {string} body        the operator's typed reply (already trimmed by
 *                             the route's Zod schema, but not assumed to be)
 * @param {string|null|undefined} signature  profiles.email_signature
 * @returns {string}
 */
export function appendSignature(body, signature) {
  const text = typeof body === 'string' ? body : ''
  const sig = normalizeSignature(signature)
  if (!sig) return text

  // Trailing whitespace on the body would otherwise stack up in front of the
  // blank line and push the separator down the message.
  const trimmed = text.replace(/\s+$/, '')
  if (!trimmed) return `${SIGNATURE_SEPARATOR}\n${sig}`
  return `${trimmed}\n\n${SIGNATURE_SEPARATOR}\n${sig}`
}

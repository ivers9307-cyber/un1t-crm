// REPSET-PUB.3A — client-side logic for the App Store reviewer login gate.
//
// NO native imports: vitest runs this in Node (mobile/lib/**/*.test.js), and
// the login screen + auth-context consume it. Nothing secret lives here — the
// gate code is typed by the reviewer and only ever exists in the environment
// of the server route. A code literal in this file would ship inside the
// Metro bundle on every member's phone; that exact mistake is why
// scripts/check-secrets.mjs exists.
//
// THE TRIGGER, and why it is this one. champ-app's reviewer entry is not a
// hidden gesture — it is the demo EMAIL itself: typing
// appreview@un1tdublin.com into the ordinary email field short-circuits the
// "send me a code" step and the next screen takes the gate code instead of an
// emailed OTP. Apple hands the reviewer that email in the App Store Connect
// demo-account fields, so the trigger arrives with the credentials and there
// is nothing extra to document. Copied here as-is: no long-press, no tap
// sequence, no affordance a curious member could stumble into.
//
// ONE adaptation. champ funnels the gate code through the SAME digits-only
// 8-char OTP input the emailed code uses, which silently constrains the gate
// code to exactly 8 digits — paste an alphanumeric one and the input eats
// every non-digit and the submit button never enables, which reads as "that
// code didn't work". Richard sets a FRESH code at submission time, so that
// trap would fire at the worst possible moment. The merged app therefore
// renders a separate free-text field for the gate code, normalised by the
// helpers below rather than by mobile/lib/otp.js.

/**
 * The one account the reviewer gate can sign in. Not a secret — it is the
 * demo username in App Store Connect. Member-only server-side (no staff
 * profile rows), so the identity resolver lands it on the member shell.
 */
export const REVIEW_DEMO_EMAIL = 'appreview@un1tdublin.com'

/** Shortest gate code the submit button will accept. */
export const MIN_GATE_CODE_LENGTH = 6
/** Longest we keep — a paste guard, not a policy. */
export const MAX_GATE_CODE_LENGTH = 64

/**
 * Is this the reviewer demo account? Compared on the normalised form because
 * the reviewer types it on a phone keyboard (leading space, autocapitalised
 * first letter). Mirrors the server's own normalisation so the client can
 * never advance to a code step the route would then refuse on the email.
 *
 * @param {unknown} email
 * @returns {boolean}
 */
export function isReviewDemoEmail(email) {
  if (typeof email !== 'string') return false
  return email.trim().toLowerCase() === REVIEW_DEMO_EMAIL
}

/**
 * Keystrokes/paste → the value we send as `code`. Whitespace is stripped
 * (a code copied out of a mail or a notes app arrives wrapped or spaced),
 * everything else is preserved — case included, because the server does NOT
 * case-fold the secret and folding it here would silently shrink the space
 * Richard picks from.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeGateCode(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, '').slice(0, MAX_GATE_CODE_LENGTH)
}

/**
 * Is the typed gate code long enough to submit? A floor, not an exact length:
 * this screen cannot know how long the configured code is, and a submit button
 * that stayed disabled on a correct code would be unexplainable.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCompleteGateCode(value) {
  return normalizeGateCode(value).length >= MIN_GATE_CODE_LENGTH
}

/**
 * Pull the one-time token out of POST /api/mobile/review-login's envelope.
 *
 * Returns null for EVERY unsuccessful shape — 404 (gate not configured), 403,
 * 429, 503, a transport blip, or a 200 that somehow carries no token. The
 * caller turns null into one neutral message: the reviewer must never be told
 * which of those it was, and handing `undefined` to verifyOtp would surface
 * as a confusing Supabase error instead.
 *
 * @param {any} envelope the object api() resolves with
 * @returns {string|null}
 */
export function reviewLoginOtp(envelope) {
  if (!envelope || envelope.success !== true) return null
  const otp = envelope.data?.otp
  return typeof otp === 'string' && otp.length > 0 ? otp : null
}

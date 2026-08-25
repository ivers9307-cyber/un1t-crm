// REPSET-PUB.3A — the App Store reviewer login gate's pure logic.
//
// Ported from champ-app's July 2026 hardened route
// (champ-app/src/app/api/mobile/review-login/route.js, REVIEW-LOGIN-HARDEN.1).
// The decisions live here rather than inline in the route so each one is
// unit-testable on its own — the route is then a thin ORDERING of them, and
// the ordering is what the route's own tests pin.
//
// WHY THE GATE EXISTS: the merged app's only auth entry is the staff login via
// an 8-digit emailed OTP. An Apple reviewer cannot receive that email, so
// review stalls at the login screen — a guaranteed Guideline 2.1 rejection.
// This gate lets EXACTLY one member-only demo account in, on a code that lives
// only in the environment.
//
// HARDENING (do not weaken):
//   - The gate code lives ONLY in REVIEW_LOGIN_CODE. There is NO source
//     fallback and no default: unset ⇒ the route is OFF (404), so an
//     unconfigured deploy cannot be used as a backdoor. This is also why the
//     code must never appear in a bundle — scripts/check-secrets.mjs exists
//     because a hardcoded gate code shipped once and had to be burned.
//   - The comparison is constant-time AND length-blind (see below).
//   - The per-IP limiter runs BEFORE the credential check, so guessing the
//     code is throttled regardless of the email supplied.

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'

/**
 * The ONE account this gate may ever sign in. Member-only by construction:
 * it has an auth.users row and a contacts row, and deliberately NO
 * profiles / profile_locations rows, so a session minted here resolves
 * `not_staff` at the identity spine and reaches only the reviewer's own
 * seeded member data. (Verified against the live project 2026-08-25; the
 * July data-fix deleted the staff rows and mig 404 — signups OFF — is what
 * keeps them from coming back.)
 */
export const REVIEW_DEMO_EMAIL = 'appreview@un1tdublin.com'

// Per-process key for the length-blind compare below. Random per boot: it is
// never persisted, never transmitted, and only has to make two HMACs of the
// same process comparable to each other.
const COMPARE_KEY = randomBytes(32)

/**
 * Constant-time string equality that ALSO hides the length.
 *
 * `crypto.timingSafeEqual` throws on unequal-length buffers, so the usual
 * `a.length !== b.length` early-exit leaks the secret's length through timing
 * (src/proxy.js accepts that leak because CRM_API_KEY is a fixed 64-char hex
 * string by convention — the reviewer gate code has no such convention, and
 * Richard picks a fresh one at submission time). HMAC-ing both sides to a
 * fixed 32 bytes first removes the leak entirely: every comparison is over
 * two 32-byte digests regardless of input length.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const da = createHmac('sha256', COMPARE_KEY).update(a, 'utf8').digest()
  const db = createHmac('sha256', COMPARE_KEY).update(b, 'utf8').digest()
  return timingSafeEqual(da, db)
}

/**
 * Read the configured gate code. NO fallback — an unset, blank or
 * whitespace-only value is `null`, and `null` means the route is OFF.
 *
 * Reading it through a function (rather than a module-load `const`) is a
 * deliberate divergence from champ's route: on Vercel a module-load capture
 * freezes the value for the lifetime of the warm lambda, so flipping the env
 * at submission time would not take effect until something forced a cold
 * start. Here the route re-reads per request, which is also what lets the
 * route tests exercise both states without module-cache surgery.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function readReviewCode(env = process.env) {
  const raw = env?.REVIEW_LOGIN_CODE
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

// NOTE (REPSET-PUB.3A-b): there is deliberately no IP reader here. The route
// uses getClientIp() from src/lib/rate-limit.js — the house reader every other
// rate-limited endpoint already shares. A local reimplementation existed
// briefly and silently dropped the x-real-ip fallback, which would have put
// any request arriving without x-forwarded-for into the shared 'unknown'
// bucket instead of its own.

/**
 * Do the supplied credentials open the gate?
 *
 * Both legs are checked with the constant-time compare and BOTH are always
 * evaluated (no `&&` short-circuit), so a correct email cannot be
 * distinguished from a wrong one by timing. Email is normalised (trim +
 * lowercase) because it is typed by a human on a phone; the CODE is not
 * normalised beyond a trim — it is a secret, and case-folding it would shrink
 * the space Richard picks from.
 *
 * @param {object} args
 * @param {string|null} args.configuredCode  from readReviewCode()
 * @param {unknown} args.email
 * @param {unknown} args.code
 * @returns {boolean}
 */
export function credentialsMatch({ configuredCode, email, code }) {
  if (typeof configuredCode !== 'string' || configuredCode.length === 0) return false
  const emailOk = constantTimeEquals(String(email ?? '').trim().toLowerCase(), REVIEW_DEMO_EMAIL)
  const codeOk = constantTimeEquals(String(code ?? '').trim(), configuredCode)
  return emailOk && codeOk
}

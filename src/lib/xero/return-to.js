// INTEG hub inline #4 (Phase 3) — open-redirect guard for the OPTIONAL
// `return_to` carried through the Xero OAuth `state`.
//
// The hub's inline "Connect / Reconnect" button starts the full-page OAuth
// redirect with `?return_to=/settings/integrations-hub` so the callback can
// bounce the browser back to the hub (instead of the default per-location
// Xero tab). `return_to` is carried INSIDE the signed `state` — the same
// `state` value is echoed to Xero AND stored in an httpOnly cookie, and the
// callback only trusts `state` when it byte-matches that cookie, so a
// tampered `return_to` fails the cookie==state check before it is ever read.
//
// This module is the SECOND line of defence: even a value that survived the
// cookie binding is validated to an INTERNAL, SAME-ORIGIN PATH before it is
// ever used as a redirect target — after OAuth we must NEVER bounce the
// browser to an attacker-controlled absolute URL. `safeReturnTo()` returns
// the validated path or null; on null the callback falls back to its
// existing default redirect (the per-location Xero tab).
//
// Pure + unit-tested (return-to.test.js). No I/O, no imports.

// Exact-match allowlist of internal destinations we accept post-OAuth. Kept
// tiny on purpose — the hub, and (defensively) /settings itself.
const ALLOWLIST = ['/settings/integrations-hub', '/settings']

// The EXISTING default redirect the callback already uses:
// /settings/locations/<id>?tab=xero. Matched on the path (query stripped),
// so ?tab=xero&connected=… decoration passes.
const LOCATION_TAB_RE = /^\/settings\/locations\/[^/?#]+$/

// Control chars (0x00-0x1F, 0x7F) + any whitespace — none may appear in a path.
const UNSAFE_CHARS_RE = /[\u0000-\u001f\u007f\s]/

/**
 * Validate an OPTIONAL post-OAuth `return_to` to an internal, same-origin
 * path. ALL of these must hold, else null (caller uses its default redirect):
 *
 *   1. Non-empty string, at most 512 chars.
 *   2. Starts with a single "/" and NOT "//" (a protocol-relative URL like
 *      "//evil.com" is otherwise treated as absolute by the browser).
 *   3. No backslash anywhere — "/\evil.com" / "\\evil.com" are treated as
 *      protocol-relative by some browsers.
 *   4. No scheme/host and no control chars or whitespace — reject "://" and
 *      any control char (0x00-0x1F, 0x7F) or whitespace.
 *   5. Path (query/hash stripped) matches the ALLOWLIST or the existing
 *      per-location Xero-tab shape.
 *
 * @param {unknown} returnTo
 * @returns {string|null} the validated internal path, or null.
 */
export function safeReturnTo(returnTo) {
  if (typeof returnTo !== 'string' || returnTo.length === 0) return null
  if (returnTo.length > 512) return null
  // Must be an absolute internal path — not protocol-relative / scheme'd.
  if (!returnTo.startsWith('/')) return null
  if (returnTo.startsWith('//')) return null
  if (returnTo.includes('\\')) return null
  // Reject control chars, whitespace, and any scheme separator.
  if (UNSAFE_CHARS_RE.test(returnTo)) return null
  if (returnTo.includes('://')) return null
  // Compare the PATH ONLY (drop query/hash) against the allowlist.
  const path = returnTo.split(/[?#]/)[0]
  if (ALLOWLIST.includes(path)) return returnTo
  if (LOCATION_TAB_RE.test(path)) return returnTo
  return null
}

/**
 * Encode a validated internal path for carrying inside the dotted `state`
 * string. base64url has no "." so it never collides with the "nonce.locId"
 * delimiter. Callers MUST pass an already-`safeReturnTo`-validated value.
 * @param {string} path
 * @returns {string}
 */
export function encodeReturnTo(path) {
  return Buffer.from(String(path), 'utf8').toString('base64url')
}

/**
 * Decode a base64url `return_to` segment back to a path. Returns null on
 * an empty/invalid segment. The caller MUST re-run `safeReturnTo` on the
 * result — decoding is not validation.
 * @param {string|undefined|null} encoded
 * @returns {string|null}
 */
export function decodeReturnTo(encoded) {
  if (!encoded || typeof encoded !== 'string') return null
  try {
    const s = Buffer.from(encoded, 'base64url').toString('utf8')
    return s || null
  } catch {
    return null
  }
}

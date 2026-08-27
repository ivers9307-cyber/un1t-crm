// src/lib/mail/auth-strategy.js
//
// IMAP-CONNECTOR Phase 1.3 — the OAuth seam (design doc §2.1).
//
// ── What this file is for ─────────────────────────────────────────────────
// It resolves a stored `email_mailbox_credentials` row into an AUTH STRATEGY
// — the object a mail client is handed — and never into a raw password that
// call sites pass around. That is the entire point:
//
//   password mode   →  { user, pass }
//   oauth mode      →  { user, accessToken }
//
// Both imapflow and nodemailer accept an `auth` object of either shape, so
// EVERY call site downstream reads:
//
//     const verdict = resolveAuth(row)
//     if (!verdict.ok) return verdict
//     await withMailbox({ host, port, secure, auth: verdict.auth }, ...)
//
// and is byte-identical in both modes. When OAuth is eventually built, the
// only new code is a token-refresh step inside this file plus a consent
// screen — not surgery across the poller, the verifier and the sender.
//
// ── The provider work landed; this file did not change shape ──────────────
// MAILBOX-OAUTH.1 filled the seam in. Microsoft is wired end to end (a
// multi-tenant app registration and ordinary consent — no CASA, and Exchange
// Online has no basic-auth IMAP left, so it is the only way into those
// mailboxes). Google is present and REFUSING with its real reason: Gmail over
// IMAP with XOAUTH2 needs the `https://mail.google.com/` scope, which Google
// classes as RESTRICTED, and shipping that to users outside our own Workspace
// requires OAuth app verification PLUS an annual third-party CASA Tier 2
// assessment — real money and months of calendar time. Leaving the app in
// Testing status is not a workaround (those refresh tokens expire after 7
// days). See src/lib/mail/oauth-providers.js.
//
// 🔴 THE REFRESH LIVES NEXT DOOR, DELIBERATELY. This function stays PURE and
// SYNCHRONOUS — no DB, no network — because three call sites depend on that,
// including one (the connect route's credential merge) that cannot await.
// `resolveFreshAuth(db, row)` in src/lib/mail/oauth-tokens.js is the wrapper
// that renews a spent token and then delegates right back here, so both paths
// build the auth object with the same code. Call sites that can await use the
// wrapper; the verdicts below are unchanged either way.
//
// ── Two hard guarantees ───────────────────────────────────────────────────
// 1. IT NEVER THROWS. Callers are a cron poller and a connect route, and both
//    have better things to do than distinguish an exception from a verdict. A
//    catch-all wraps the whole body so even a pathological row (a getter that
//    throws, a Proxy) produces a verdict.
// 2. IT NEVER LEAKS THE SECRET. Every `error` string below is a compile-time
//    constant: no interpolation of the row, the ciphertext, the plaintext, or
//    the underlying exception message. These verdicts are written to
//    `email_mailbox_ingress.last_error`, rendered on the connect screen and
//    passed to logError — a template literal here is a credential in the
//    database's error column forever. Nothing in this file logs, either;
//    deciding what to record belongs to the caller, which knows the context.
//    (`username` is excluded too — not a secret, but PII, and no error
//    message needs it when the caller already holds the row.)
//
// Pure apart from `Date.now()` for the OAuth expiry check, which is injectable
// for tests. No DB, no network.
import { isConfigured, open } from './secret-box.js'

/**
 * Treat an access token that expires within this window as ALREADY expired.
 *
 * A token with four seconds left passes a naive `expires_at > now` check and
 * then dies mid-session, which surfaces as a mailbox that authenticates and
 * then fails halfway through a fetch — far harder to read than a clean
 * "expired" verdict. Connecting, opening a folder and fetching takes seconds,
 * so the check has to cover the whole operation, not its first millisecond.
 *
 * Safe to err early: the remedy for `oauth_expired` is a refresh, so it costs
 * a refresh call, not a lost message.
 *
 * 🔴 STRICTLY SMALLER THAN oauth-tokens.js's REFRESH_WINDOW_MS (5 minutes),
 * and the ordering is the point. That one decides when to SPEND a refresh;
 * this one decides when to REFUSE a token outright. Keeping the refresh window
 * wider means the renewal always fires first, so a caller going through
 * `resolveFreshAuth` should essentially never see `oauth_expired` — and when
 * it does, that is the genuinely different fact that a refresh was attempted
 * and did not stick.
 */
const EXPIRY_SKEW_MS = 60_000

/** @typedef {{ ok: true, auth: { user: string, pass: string } }} PasswordVerdict */
/** @typedef {{ ok: true, auth: { user: string, accessToken: string } }} OAuthVerdict */
/** @typedef {{ ok: false, reason: 'not_configured'|'decrypt_failed'|'oauth_expired'|'unsupported_auth_type', error: string }} FailedVerdict */

/**
 * Build a failure verdict. Exists so the shape is written once and so it is
 * structurally impossible to interpolate a value into `error` by accident —
 * every caller below passes a literal.
 *
 * @param {'not_configured'|'decrypt_failed'|'oauth_expired'|'unsupported_auth_type'} reason
 * @param {string} error — a CONSTANT, operator-readable sentence
 * @returns {FailedVerdict}
 */
function fail(reason, error) {
  return { ok: false, reason, error }
}

/**
 * Resolve a stored credential row into an auth strategy.
 *
 * Never throws. Never returns, logs or embeds the secret in an error.
 *
 * Failure reasons, and what each one asks of whoever reads it:
 *
 *   `not_configured`        Nothing usable is stored, or `MAILBOX_SECRET_KEY`
 *                           is absent from the environment. Operator action:
 *                           connect the mailbox / set the env var. Kept
 *                           distinct from `decrypt_failed` because the two
 *                           have completely different remedies and the same
 *                           symptom.
 *   `decrypt_failed`        A ciphertext exists but will not open — the wrong
 *                           key (a rotation applied without re-encrypting),
 *                           or a tampered/truncated column. This is the one
 *                           that must be investigated rather than retried.
 *   `oauth_expired`         The access token is past (or within a minute of)
 *                           its expiry. Refresh and retry.
 *   `unsupported_auth_type` The row names an auth type this build cannot
 *                           satisfy — a row written by a newer deploy, or by
 *                           hand. Fail rather than guess: guessing `password`
 *                           for an unknown type would hand an OAuth token to
 *                           an IMAP LOGIN command in the clear.
 *
 * `auth_type` is normalised (trimmed, lower-cased) and an absent value is read
 * as `'password'`, mirroring the column's own `NOT NULL DEFAULT 'password'` —
 * a row projected by a `select` that omitted the column must not read as
 * unsupported.
 *
 * @param {object|null|undefined} credentialRow — an `email_mailbox_credentials` row
 * @param {{ now?: number }} [options] — `now` is injectable for tests only;
 *   production call sites pass one argument, per the pinned contract.
 * @returns {PasswordVerdict|OAuthVerdict|FailedVerdict}
 */
export function resolveAuth(credentialRow, { now = Date.now() } = {}) {
  try {
    if (!credentialRow || typeof credentialRow !== 'object') {
      return fail('not_configured', 'No credential is stored for this mailbox.')
    }

    const user = typeof credentialRow.username === 'string' ? credentialRow.username.trim() : ''
    if (!user) {
      return fail('not_configured', 'The stored credential has no username.')
    }

    const authType = String(credentialRow.auth_type ?? 'password').trim().toLowerCase()

    if (authType === 'password') {
      const ciphertext = credentialRow.secret_ciphertext
      if (typeof ciphertext !== 'string' || !ciphertext) {
        return fail('not_configured', 'No password is stored for this mailbox.')
      }
      // Check the key BEFORE attempting the open, so a deployment that simply
      // forgot the env var reports the fixable thing rather than reporting
      // every mailbox in the estate as `decrypt_failed` simultaneously — an
      // alarm shape that reads as a breach.
      if (!isConfigured()) {
        return fail(
          'not_configured',
          'Mailbox encryption is not configured on this deployment (MAILBOX_SECRET_KEY).'
        )
      }
      let pass
      try {
        pass = open(ciphertext)
      } catch {
        // The underlying message is deliberately discarded. It is ours and
        // carries no secret today, but this string is persisted and displayed,
        // and the only way to keep that true forever is to never forward it.
        return fail(
          'decrypt_failed',
          'The stored password could not be decrypted. It may have been encrypted with a different key.'
        )
      }
      if (!pass) {
        return fail('not_configured', 'The stored password is empty.')
      }
      return { ok: true, auth: { user, pass } }
    }

    if (authType === 'oauth') {
      const ciphertext = credentialRow.oauth_access_token_ciphertext
      if (typeof ciphertext !== 'string' || !ciphertext) {
        return fail('not_configured', 'No OAuth access token is stored for this mailbox.')
      }
      // Expiry is judged BEFORE decrypting: a token we already know is dead
      // needs a refresh whatever the ciphertext says, and there is no reason
      // to unwrap a credential we are about to discard. An unparseable or
      // absent `oauth_expires_at` is NOT treated as expired — the token may
      // be perfectly good, and refusing to use it would be inventing an
      // outage out of a missing timestamp.
      const expiresAt = credentialRow.oauth_expires_at
      if (expiresAt != null && expiresAt !== '') {
        const expiresMs = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt)
        if (Number.isFinite(expiresMs) && expiresMs - EXPIRY_SKEW_MS <= now) {
          return fail('oauth_expired', 'The OAuth access token has expired and needs refreshing.')
        }
      }
      if (!isConfigured()) {
        return fail(
          'not_configured',
          'Mailbox encryption is not configured on this deployment (MAILBOX_SECRET_KEY).'
        )
      }
      let accessToken
      try {
        accessToken = open(ciphertext)
      } catch {
        return fail(
          'decrypt_failed',
          'The stored OAuth token could not be decrypted. It may have been encrypted with a different key.'
        )
      }
      if (!accessToken) {
        return fail('not_configured', 'The stored OAuth token is empty.')
      }
      return { ok: true, auth: { user, accessToken } }
    }

    return fail('unsupported_auth_type', 'This mailbox uses an authentication type this build cannot use.')
  } catch {
    // Unreachable for any row PostgREST can produce. It exists so the "never
    // throws" guarantee is structural rather than a promise about the code
    // above staying correct. `decrypt_failed` is the honest bucket: the
    // credential could not be read, and the cause needs a human.
    return fail('decrypt_failed', 'The stored credential could not be read.')
  }
}

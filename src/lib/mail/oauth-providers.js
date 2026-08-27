// src/lib/mail/oauth-providers.js
//
// MAILBOX-OAUTH.1 — which mail providers this build can sign in to, and the
// signed round-trip that carries an operator to one and back.
//
// Spec: docs/superpowers/specs/2026-08-26-imap-mailbox-connector-design.md
// §2.1 (the OAuth seam), §12.3 (the nodemailer shape correction).
//
// ── PURE, ON PURPOSE ───────────────────────────────────────────────────────
// No DB, no network, no `fetch`. It reads `process.env` and it does HMAC, and
// that is all. The network half lives in oauth-tokens.js and the persistence
// half lives with it, so a table of provider facts can be unit-tested against
// nothing and a wrong endpoint is a failing assertion rather than a live
// request to somebody else's identity service.
//
// ── WHY MICROSOFT IS THE ONE THAT SHIPS, AND GOOGLE IS NOT ────────────────
// This inverts the order everyone expects, so it is written down rather than
// discovered:
//
//   MICROSOFT is cheap. A multi-tenant app registration plus ordinary user (or
//   admin) consent. The delegated scopes below are Exchange Online's documented
//   IMAP/SMTP scopes, they need no security assessment, and — decisively —
//   Exchange Online has NO basic-auth IMAP left, so OAuth is not a nicety for
//   a Microsoft mailbox, it is the ONLY way in. Today the connector refuses
//   those accounts outright (MICROSOFT_REFUSAL in the connection route), which
//   means every Microsoft-shaped customer is currently unreachable. Basic auth
//   for SMTP client submission is being retired on the same trajectory, so the
//   gap only widens.
//
//   GOOGLE is not. Gmail over IMAP with XOAUTH2 needs `https://mail.google.com/`,
//   which Google classes as RESTRICTED — as are gmail.readonly and gmail.modify,
//   so there is no unrestricted way to read a Gmail mailbox at all. Shipping a
//   restricted scope to users outside our own Workspace requires Google OAuth
//   app verification PLUS an annual third-party CASA Tier 2 security
//   assessment: real money, and weeks-to-months of calendar time that no amount
//   of engineering shortens. Leaving the app in Testing status is not a
//   workaround — refresh tokens issued to a Testing app expire after 7 days, so
//   every connected mailbox would silently stop once a week.
//
// 🔴 SO GOOGLE IS PRESENT AND REFUSING, NOT ABSENT AND NOT HALF-BUILT.
// The temptation is to wire the Google branch anyway "so it is ready". A
// provider that half-works is worse than one that says why it cannot: an
// operator who clicks *Sign in with Google*, completes consent, and watches the
// mailbox die seven days later has been given a broken feature and a support
// ticket, where an operator who is told "this needs Google verification and a
// CASA assessment we have not bought" has been given a decision to escalate.
// The registry therefore carries Google as a first-class entry whose status is
// `unavailable` and whose reason names the actual blocker. When the business
// funds verification, the change here is `status: 'available'` plus a client id
// — the endpoints and scopes below are already correct.
//
// ── THE STATE PARAMETER ───────────────────────────────────────────────────
// An OAuth callback is an unauthenticated GET that a third party sends a
// browser to. Two things have to be true of it and neither implies the other:
//
//   1. CSRF — the round trip must have started here. Otherwise an attacker
//      completes a consent flow with THEIR mailbox and, if the callback trusts
//      whatever `state` says, binds their account to a mailbox belonging to
//      somebody else's studio (or the reverse: binds the victim's mailbox
//      wherever the attacker chooses).
//   2. PROVENANCE — the callback has to know which location and which mailbox
//      the flow was for, and it cannot ask the provider, and it must not read
//      it from a query parameter the caller controls.
//
// `signState`/`verifyState` answer both: an HMAC over a JSON payload, keyed on
// CRON_SECRET, exactly the idiom /api/sonos/connect established. The callback
// ALSO binds it to an httpOnly cookie and ALSO re-runs guardMailboxAdmin on the
// session, so three independent things must agree. The signature is what
// survives a browser that dropped the cookie; the cookie is what survives a
// leaked signing key; the session guard is what makes the whole route legible
// to `check:route-guards` rather than an EXEMPT entry.
//
// CRON_SECRET rather than MAILBOX_SECRET_KEY, deliberately. The mailbox key
// encrypts customers' credentials; using the same bytes to sign a URL
// parameter would put a value derived from that key into browser history, a
// provider's logs and an operator's clipboard. Different job, different key,
// and CRON_SECRET is already the estate's state-signing secret.

import crypto from 'node:crypto'

/**
 * How long a consent round trip may take.
 *
 * Ten minutes matches /api/xero/connect's cookie. It is generous for a click-
 * through and short enough that a state value in a browser history or a shared
 * screenshot is inert by the time anyone finds it. The cookie expires on the
 * same clock, so the two halves cannot disagree about whether a flow is stale.
 */
export const STATE_TTL_MS = 10 * 60_000

/** The cookie the start route sets and the callback requires. */
export const STATE_COOKIE = 'mailbox_oauth_state'

/**
 * 🔴 ONE STATIC REDIRECT URI FOR THE WHOLE ESTATE, AND IT CANNOT BE OTHERWISE.
 *
 * Microsoft (and Google, and every other identity provider worth using)
 * requires the `redirect_uri` to match a value registered on the app
 * REGISTRATION, byte for byte. The natural-looking route path here would be
 * `…/locations/<id>/email/mailboxes/<mailboxId>/oauth/callback`, which carries
 * the tenant in the path — and which can never be registered, because every
 * location and every mailbox would need its own registered URI.
 *
 * So the callback is a single fixed path and the location + mailbox ride
 * INSIDE the signed state. That is the same shape /api/xero/callback uses
 * (XERO_REDIRECT_URI is one static value; the location lives in `state`), and
 * it is the reason the callback is not under /api/locations/[id]/… with its
 * siblings.
 */
export const OAUTH_CALLBACK_PATH = '/api/email/oauth/callback'

/**
 * The provider table.
 *
 * `status` is the only field a reader needs to answer "can I connect this
 * today", and it is deliberately a string rather than a boolean so a third
 * state — configured-but-not-deployed — is expressible without a schema
 * change here.
 *
 *   'available'    — this build can complete the flow, given env vars.
 *   'unavailable'  — this build will not attempt it, and `unavailableReason`
 *                    says why in words an operator can escalate.
 *
 * Host/port/TLS defaults live here as well as in the settings UI's
 * PROVIDER_PRESETS, and that duplication is deliberate: the UI's copy is what
 * an operator sees and may override on a custom host, and this copy is what
 * the CALLBACK writes when nobody typed anything at all. A Microsoft mailbox
 * connected by consent never passes through the host form, so the callback
 * cannot read the values off a request body — it has to know them.
 */
export const OAUTH_PROVIDERS = {
  microsoft: {
    key: 'microsoft',
    label: 'Microsoft 365 / Outlook',
    status: 'available',

    // `common` accepts BOTH work/school accounts and personal Microsoft
    // accounts (outlook.com, hotmail.com) — Exchange Online's OAuth support
    // for IMAP/POP/SMTP covers both, and a franchise studio running the
    // owner's outlook.com address is a real customer shape. `organizations`
    // would refuse those, silently, at the authorize step. Overridable per
    // deployment for an estate that wants to pin a single tenant.
    tenantEnv: 'MAILBOX_OAUTH_MICROSOFT_TENANT',
    defaultTenant: 'common',

    clientIdEnv: 'MAILBOX_OAUTH_MICROSOFT_CLIENT_ID',
    clientSecretEnv: 'MAILBOX_OAUTH_MICROSOFT_CLIENT_SECRET',

    authorizeUrl: (tenant) =>
      `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
    tokenUrl: (tenant) =>
      `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,

    // 🔴 THE RESOURCE PREFIX IS LOAD-BEARING AND IS NOT A TYPO.
    // These are Exchange Online's own scopes, not Microsoft Graph's, and they
    // live on `outlook.office.com`. Requesting the Graph spelling, or mixing a
    // Graph scope into this list, fails the token request outright — Microsoft
    // issues a token for ONE resource per request, and IMAP/SMTP are a
    // different resource from Graph. Verified against Microsoft Learn,
    // "Authenticate an IMAP, POP or SMTP connection using OAuth".
    //
    // SMTP.Send is requested alongside IMAP even for a receive-only mailbox.
    // Asking for it later would mean sending the operator back through consent
    // the first time they enable replies, and an incremental-consent prompt on
    // a settings screen months after connecting reads as the app having been
    // compromised. One consent, both directions, and the operator still
    // chooses whether replies actually leave this way (that is `egress`).
    //
    // offline_access is what makes a refresh token exist at all. Without it
    // the mailbox works for exactly one access-token lifetime (~1 hour) and
    // then stops, which is the failure mode that looks like a bug in our
    // poller and is not.
    scopes: [
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
      'offline_access',
    ],

    imap_host: 'outlook.office365.com',
    imap_port: 993,
    imap_secure: true,
    // 587 + STARTTLS, so `smtp_secure` is FALSE. This is the pair that is
    // wrong in half the SMTP connectors ever written: 465 is implicit TLS
    // (secure true), 587 is STARTTLS (secure false), and pairing 587 with true
    // fails as an opaque connect timeout rather than as a TLS error. Office
    // 365 offers 587 only, so the pair is stated together and never typed.
    smtp_host: 'smtp.office365.com',
    smtp_port: 587,
    smtp_secure: false,
    sent_folder: 'Sent Items',
  },

  google: {
    key: 'google',
    label: 'Google (Sign in with Google)',
    status: 'unavailable',

    // The operator-facing sentence. It is a compile-time constant, it names
    // the actual blocker, and it names it in terms a business can act on —
    // "buy an assessment" is a decision somebody can take, "not supported" is
    // not. It deliberately points at the thing that DOES work today, because
    // the alternative to this flow is not "no Gmail", it is "Gmail with an app
    // password", which is already shipped and already fine.
    unavailableReason:
      'Signing in with Google is not available. Reading a Gmail mailbox over IMAP needs Google’s ' +
      'restricted “https://mail.google.com/” scope, which requires OAuth app verification plus an ' +
      'annual third-party CASA Tier 2 security assessment before it can be used outside our own ' +
      'Google Workspace — that is a purchase and a review cycle, not a setting. Leaving the app ' +
      'unverified is not a way round it: Google expires those refresh tokens after 7 days, so every ' +
      'connected mailbox would stop weekly. Connect Gmail and Google Workspace accounts with a ' +
      '16-character app password instead — that works today and is on this same screen.',

    // 🔴 ENABLING THIS ENTRY NEEDS A MIGRATION AS WELL AS A CLIENT ID.
    // `email_mailbox_credentials.provider` is CHECK-constrained to
    // ('gmail','microsoft','custom') — verified against the live database
    // 2026-08-27 — and the callback writes `provider.config.key`. So flipping
    // this to `status: 'available'` without first widening that CHECK (or
    // renaming this key to 'gmail') fails the INSERT with a 23514, and it fails
    // it at the LAST step: after the operator has completed consent and after a
    // live grant exists at Google with nothing on our side referring to it —
    // exactly the "refuse before the redirect, never after" rule this file is
    // otherwise built around. Pinned by a test in oauth-providers.test.js so
    // whoever flips the switch is told, rather than finding out in production.
    //
    // Everything else is present and correct so that the day verification is
    // granted, nothing here has to be researched again. Nothing reads these
    // while the status is 'unavailable'.
    tenantEnv: null,
    defaultTenant: null,
    clientIdEnv: 'MAILBOX_OAUTH_GOOGLE_CLIENT_ID',
    clientSecretEnv: 'MAILBOX_OAUTH_GOOGLE_CLIENT_SECRET',
    authorizeUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    scopes: ['https://mail.google.com/'],
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    imap_secure: true,
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    smtp_secure: true,
    sent_folder: '[Gmail]/Sent Mail',
  },
}

/**
 * Every provider, as the settings UI wants to render them: what it is called,
 * whether it can be used, and — when it cannot — why not.
 *
 * Returned as data rather than as JSX copy so the same sentence reaches the
 * form, the API refusal and any future health surface without three people
 * writing three versions of it. No secret, no client id, nothing that changes
 * per deployment: safe to hand to a browser.
 */
export function oauthProviderCatalogue() {
  return Object.values(OAUTH_PROVIDERS).map((p) => ({
    key: p.key,
    label: p.label,
    status: p.status,
    unavailableReason: p.status === 'available' ? null : (p.unavailableReason || null),
  }))
}

/**
 * Resolve a provider key to everything a flow needs, or the reason it cannot
 * be run.
 *
 * NEVER THROWS and never returns a secret in an error string — same posture as
 * resolveAuth(). These verdicts are shown to operators and, on the poller's
 * side, can reach `email_mailbox_ingress.last_error`.
 *
 * The three refusals are kept apart because they have three different fixes
 * and exactly one symptom:
 *
 *   `unknown_provider`     — a key nothing in this build knows. A stale form,
 *                            a hand-written request, a row from a newer deploy.
 *   `provider_unavailable` — we know it and deliberately will not run it. This
 *                            is Google, and its remedy is a purchase order.
 *   `not_configured`       — we would run it, but this deployment has no client
 *                            id/secret. One Vercel env var away, and the fix
 *                            belongs to us, not to the customer.
 *
 * Collapsing the last two would be the expensive mistake: an operator told
 * "not configured" about Google would go and ask an engineer to set an env
 * var that will not help, and an operator told "unavailable" about Microsoft
 * would give up on a mailbox that is one deploy from working.
 *
 * @param {string} providerKey
 * @param {{env?: object}} [options] — `env` is injectable for tests only.
 * @returns {{ok: true, config: object} | {ok: false, reason: string, error: string}}
 */
export function resolveOAuthProvider(providerKey, { env = process.env } = {}) {
  const key = String(providerKey ?? '').trim().toLowerCase()
  const provider = Object.prototype.hasOwnProperty.call(OAUTH_PROVIDERS, key)
    ? OAUTH_PROVIDERS[key]
    : null

  if (!provider) {
    return {
      ok: false,
      reason: 'unknown_provider',
      error: 'That mail provider is not one this release can sign in to.',
    }
  }

  if (provider.status !== 'available') {
    return { ok: false, reason: 'provider_unavailable', error: provider.unavailableReason }
  }

  const clientId = String(env[provider.clientIdEnv] ?? '').trim()
  const clientSecret = String(env[provider.clientSecretEnv] ?? '').trim()
  if (!clientId || !clientSecret) {
    // The env var NAMES are safe to state and are the single most useful thing
    // to say — they turn "it does not work" into a ticket somebody can close.
    // The VALUES are never touched here.
    return {
      ok: false,
      reason: 'not_configured',
      error:
        `Signing in with ${provider.label} is not set up on this deployment yet ` +
        `(${provider.clientIdEnv} / ${provider.clientSecretEnv}). Nothing has been changed.`,
    }
  }

  const tenant = provider.tenantEnv
    ? (String(env[provider.tenantEnv] ?? '').trim() || provider.defaultTenant)
    : provider.defaultTenant

  return {
    ok: true,
    config: {
      key: provider.key,
      label: provider.label,
      clientId,
      clientSecret,
      authorizeUrl: provider.authorizeUrl(tenant),
      tokenUrl: provider.tokenUrl(tenant),
      scopes: [...provider.scopes],
      // The mailbox defaults the callback writes. Copied, not referenced, so a
      // caller mutating the returned object cannot edit the module's table.
      imap_host: provider.imap_host,
      imap_port: provider.imap_port,
      imap_secure: provider.imap_secure,
      smtp_host: provider.smtp_host,
      smtp_port: provider.smtp_port,
      smtp_secure: provider.smtp_secure,
      sent_folder: provider.sent_folder,
    },
  }
}

/**
 * The absolute callback URL this deployment registers with the provider.
 *
 * Built from getAppUrl()'s value by the caller rather than read here, because
 * getAppUrl() throws when NEXT_PUBLIC_APP_URL is unset (no silent env
 * fallbacks — CLAUDE.md) and this module does not throw.
 *
 * @param {string} appUrl — origin with no trailing slash
 */
export function callbackUrl(appUrl) {
  return `${String(appUrl || '').replace(/\/+$/, '')}${OAUTH_CALLBACK_PATH}`
}

/**
 * The URL the operator's browser is sent to.
 *
 * `prompt=consent` is set for the same reason /api/xero/connect sets it: a
 * user who already authorised this app under an OLDER scope list is otherwise
 * re-issued a token carrying the PREVIOUS scopes, so adding SMTP.Send later
 * would appear to work and then fail at the first reply. It also guarantees a
 * refresh token comes back — Microsoft omits one on a silent re-authorisation,
 * and a connection with no refresh token dies in an hour with no error worth
 * reading.
 *
 * `login_hint` pre-fills the account picker with the mailbox address. Not a
 * security control (the operator can sign in as anyone), purely the difference
 * between "which of my six accounts was this for" and a one-click confirm. The
 * callback proves the identity that actually came back by dialling IMAP with
 * it, not by trusting this.
 */
export function buildAuthorizeUrl({ config, state, redirectUri, loginHint }) {
  const u = new URL(config.authorizeUrl)
  u.searchParams.set('client_id', config.clientId)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('response_mode', 'query')
  u.searchParams.set('scope', config.scopes.join(' '))
  u.searchParams.set('state', state)
  u.searchParams.set('prompt', 'consent')
  if (loginHint) u.searchParams.set('login_hint', loginHint)
  return u.toString()
}

/* ─────────────────────────────── the state ─────────────────────────────── */

/**
 * Sign a state payload.
 *
 * base64url + '.' + HMAC-SHA256(base64url), the exact shape signState() uses
 * in /api/sonos/connect. Two files rather than an import because that one
 * lives inside a route module whose GET handler runs on import in some tooling,
 * and a mail library reaching into a Sonos route for a crypto helper is a
 * dependency nobody would predict.
 *
 * @param {object} payload
 * @param {string} secret
 * @returns {string}
 */
export function signState(payload, secret) {
  const raw = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('base64url')
  return `${raw}.${sig}`
}

/**
 * Verify + decode a state value.
 *
 * Returns null for anything that is not a valid, unexpired signature over a
 * JSON object. NEVER throws and never says WHY — a callback that reports
 * "signature ok, payload stale" separately from "bad signature" is an oracle,
 * and there is nothing an honest caller does differently between the two.
 *
 * `timingSafeEqual` on equal-length buffers only; unequal lengths short-circuit
 * because timingSafeEqual throws on a length mismatch (and a length difference
 * is not a secret — base64url of a SHA-256 is always 43 characters).
 *
 * @param {string} state
 * @param {string} secret
 * @param {{now?: number, ttlMs?: number}} [options]
 * @returns {object|null}
 */
export function verifyState(state, secret, { now = Date.now(), ttlMs = STATE_TTL_MS } = {}) {
  if (!secret) return null
  const [raw, sig] = String(state || '').split('.')
  if (!raw || !sig) return null
  let expected
  try {
    expected = crypto.createHmac('sha256', secret).update(raw).digest('base64url')
  } catch {
    return null
  }
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  let payload
  try {
    payload = JSON.parse(Buffer.from(raw, 'base64url').toString())
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null

  // An expiry is REQUIRED, not optional. A signed state with no `ts` would be
  // valid forever — a replayable, unexpiring capability sitting in whatever
  // browser history, proxy log or shared screenshot it landed in. A payload
  // that does not carry one is refused rather than trusted.
  const ts = Number(payload.ts)
  if (!Number.isFinite(ts)) return null
  // The future check catches a clock skew large enough that the TTL means
  // nothing, and costs one comparison.
  if (ts > now + ttlMs || now - ts > ttlMs) return null

  return payload
}

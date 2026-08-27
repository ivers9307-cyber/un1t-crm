// src/lib/mail/oauth-tokens.js
//
// MAILBOX-OAUTH.2 — the token lifecycle for an OAuth-connected mailbox:
// exchange a consent code, refresh a spent access token, and hand the poller
// and the sender an auth strategy that is fresh at the moment they use it.
//
// Spec: docs/superpowers/specs/2026-08-26-imap-mailbox-connector-design.md §2.1.
// Shape borrowed from src/lib/xero/client.js, which has run this lifecycle in
// production since mig 029 — load the row, refresh if it is about to expire,
// PERSIST THE ROTATED TOKENS, hand the caller a usable credential. The three
// deliberate departures from that file are called out where they happen:
// tokens are sealed rather than plaintext, nothing throws, and a refresh
// failure is classified rather than collapsed.
//
// ── WHY THE REFRESH IS HERE AND NOT IN auth-strategy.js ────────────────────
// resolveAuth() is documented, and tested, as PURE: no DB, no network, no
// clock beyond an injectable `Date.now()`, and it NEVER THROWS. That contract
// is load-bearing in three places — the connect route calls it synchronously
// mid-way through a credential merge, the poller calls it before it has opened
// anything, and smtp-send calls it on the path to a member's reply. Making it
// async so it could refresh would ripple an `await` into all three and, worse,
// would put a network call and a database write inside the one function in
// this subsystem whose whole value is that it cannot fail in an interesting
// way.
//
// So the seam stays exactly where §2.1 put it and gains a wrapper:
//
//     resolveAuth(row)                → pure verdict, may say `oauth_expired`
//     resolveFreshAuth(db, row)       → refreshes first, then that same verdict
//
// Call sites that can await (the poller, the sender) use the wrapper and get a
// mailbox that keeps working. The one that cannot — the connect route's
// "change the host, keep the credential" merge — keeps the pure call, which is
// correct there: it is verifying a credential against a live server in the next
// breath, so a stale token surfaces as a refusal the operator is looking at
// rather than as a silent refresh nobody asked for.
//
// ── 🔴 A REFRESH FAILURE AND A REVOKED GRANT ARE DIFFERENT THINGS ──────────
// This is the requirement the whole file is shaped around. Both look identical
// from the poller — "we could not get a token" — and they demand opposite
// responses:
//
//   REVOKED  The operator (or their admin) withdrew consent, removed the app,
//            changed the account password, or let the refresh token age out.
//            NOTHING WE DO FIXES IT. Retrying every five minutes for a day is
//            pure noise. The remedy is a human clicking *Sign in* again, so it
//            takes the AUTH backoff curve and says so in those words.
//   TRANSIENT The identity service was slow, rate-limited, 5xx'd, or the socket
//            died. The grant is perfectly good. Retrying IS the fix, so it
//            takes the TRANSPORT curve and must never park the mailbox for
//            24 hours over a blip at Microsoft.
//
// The signal that tells them apart is the OAuth 2.0 `error` field, not the
// HTTP status: RFC 6749 §5.2 specifies `invalid_grant` for exactly "the
// refresh token is invalid, expired, revoked, or was issued to another
// client", and every provider here returns it with a 400. A 400 carrying any
// OTHER error code is OUR bug (a wrong client id, a malformed request) and is
// treated as transient-but-loud rather than as the customer's fault — telling
// an operator to re-authorise because we sent a malformed request would have
// them chasing their own IT department over our defect.
//
// ── NOTHING IN HERE LOGS OR RETURNS A TOKEN ───────────────────────────────
// Same posture as the password (spec §6). Every `error` string below is a
// compile-time constant: no interpolation of the row, the ciphertext, the
// token, the response body, or the underlying exception. These verdicts reach
// `email_mailbox_ingress.last_error`, which renders on an operator's settings
// card, and a template literal here is a credential in a database column
// forever. The provider's own error CODE is logged (it is ours to read, and it
// is the only thing that makes a failure diagnosable) — never its body, which
// on a token endpoint can echo request parameters back.

import { logError, logWarn } from '@/lib/log'
import { seal, open, isConfigured } from './secret-box.js'
import { resolveAuth } from './auth-strategy.js'
import { resolveOAuthProvider } from './oauth-providers.js'

const MODULE = 'mail/oauth-tokens'

/**
 * Refresh when the stored token has less than this left.
 *
 * Five minutes, against auth-strategy's own 60-second EXPIRY_SKEW_MS. The two
 * numbers are doing different jobs and the ordering between them matters: this
 * one decides when to SPEND a refresh, the other decides when to REFUSE a
 * token outright. Keeping this window strictly larger means the refresh always
 * fires before the refusal can, so `oauth_expired` is a state the poller
 * should essentially never see — and if it does, it means a refresh was tried
 * and did not stick, which is a genuinely different fact.
 *
 * Five minutes rather than one because a poll tick is not instantaneous: it
 * connects, opens a folder, downloads bodies, uploads attachments and POSTs to
 * our own webhook, all on one token. A token that was valid when the session
 * opened and dies mid-fetch surfaces as a half-ingested mailbox, which is much
 * harder to read than a clean re-auth.
 */
export const REFRESH_WINDOW_MS = 5 * 60_000

/** Longest a token request may take before we give up and call it transient. */
const TOKEN_REQUEST_TIMEOUT_MS = 15_000

/**
 * How long an access token is assumed to last when the provider does not say.
 *
 * Deliberately CONSERVATIVE (10 minutes, against Microsoft's usual ~60-75).
 * Under-estimating costs an extra refresh; over-estimating means handing
 * imapflow a token we believe is live and is not, which is the failure this
 * whole module exists to prevent. Every provider here does return `expires_in`,
 * so this is the branch nothing takes — it exists so that a provider which
 * stops returning it degrades into "refreshes often" rather than "stops".
 */
const FALLBACK_EXPIRES_IN_S = 600

/**
 * Failure verdicts. Reasons are a closed set so callers can switch on them:
 *
 *   'oauth_revoked'         permanent until a human re-authorises
 *   'oauth_refresh_failed'  transient; retrying is the fix
 *   'not_configured'        this deployment or this row cannot run the flow
 *   'oauth_denied'          the operator (or their admin) said no at consent
 *   plus whatever resolveAuth() itself returns, passed through unchanged
 */
function fail(reason, error) {
  return { ok: false, reason, error }
}

/** Constant sentences. Written once so no call site invents a variant. */
const REVOKED_MESSAGE =
  'This mailbox’s sign-in has been withdrawn or has expired, so mail cannot be collected from it. ' +
  'Open the account in Settings → Email and sign in again.'

const REFRESH_FAILED_MESSAGE =
  'The mail provider’s sign-in service could not be reached to renew this account’s access. ' +
  'Nothing is wrong with the connection itself and checking will resume on its own.'

const EXCHANGE_FAILED_MESSAGE =
  'The mail provider did not complete the sign-in. Nothing has been saved — please try again.'

const DENIED_MESSAGE =
  'The sign-in was not completed — permission was declined at the provider. Nothing has been changed.'

const NO_REFRESH_TOKEN_MESSAGE =
  'The mail provider did not issue a long-lived permission for this account, so it would stop ' +
  'collecting mail within the hour. Nothing has been saved — sign in again and accept every ' +
  'permission the provider asks for.'

const ENCRYPTION_MESSAGE =
  'Mailbox sign-ins cannot be stored on this deployment yet — its encryption key is not configured. ' +
  'Nothing has been saved.'

/**
 * POST to a token endpoint and classify what comes back.
 *
 * NEVER THROWS. Every exit is one of the verdicts above.
 *
 * `client_secret` goes in the BODY (client_secret_post), not an Authorization
 * header. Microsoft accepts both; the body form is what its own documentation
 * shows and what its error messages assume, which matters more than elegance
 * the first time a client id is wrong at 6pm.
 *
 * @param {object} config — from resolveOAuthProvider()
 * @param {Record<string,string>} form — grant-specific parameters
 * @param {{fetch?: Function, timeoutMs?: number}} [deps] — test seam
 * @returns {Promise<{ok: true, tokens: object} | {ok: false, reason: string, error: string}>}
 */
async function postToken(config, form, deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch
  const timeoutMs = deps.timeoutMs ?? TOKEN_REQUEST_TIMEOUT_MS

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    ...form,
  })

  // An AbortController rather than trusting the platform default. This runs
  // inside a Vercel function on a five-minute cron that has to reach every
  // connected mailbox; an identity service that accepts a connection and then
  // says nothing must cost fifteen seconds, not the whole sweep. §5.3 — one
  // customer's problem must never delay another's — applies to their identity
  // provider exactly as it applies to their mail server.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res
  try {
    res = await doFetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: controller.signal,
    })
  } catch (err) {
    // A thrown fetch is a network fault, an abort, or a DNS failure — never a
    // refusal by the provider, because a refusal has a status. Transient by
    // construction. `err.name` is logged (it separates AbortError from the
    // rest) and nothing else: an error from a fetch can carry the request
    // options, and the request options carry the client secret.
    logWarn(MODULE, 'token request did not complete', {
      provider: config.key, grant: form.grant_type, err: err?.name || 'error',
    })
    return fail('oauth_refresh_failed', REFRESH_FAILED_MESSAGE)
  } finally {
    clearTimeout(timer)
  }

  let json = null
  try {
    json = await res.json()
  } catch {
    json = null
  }

  if (res.ok) {
    const accessToken = typeof json?.access_token === 'string' ? json.access_token : ''
    if (!accessToken) {
      // A 200 with no token is a contract violation, not a refusal. Loud,
      // transient — a retry costs nothing and there is no operator action.
      logError(MODULE, 'token endpoint answered 200 with no access_token', {
        provider: config.key, grant: form.grant_type,
      })
      return fail('oauth_refresh_failed', REFRESH_FAILED_MESSAGE)
    }
    return { ok: true, tokens: json }
  }

  // ── THE CLASSIFICATION ────────────────────────────────────────────────
  // RFC 6749 §5.2: `invalid_grant` means the grant itself is dead — revoked,
  // expired, or issued to another client. That is the ONLY code that means a
  // human has to act, and it is deliberately matched on the code rather than
  // on the status: a 400 is also what a malformed request gets, and telling an
  // operator their consent was withdrawn because WE sent a bad client id would
  // send them to their IT department over our defect.
  const code = typeof json?.error === 'string' ? json.error : ''
  if (code === 'invalid_grant') {
    logWarn(MODULE, 'grant is no longer valid — operator must sign in again', {
      provider: config.key, grant: form.grant_type, status: res.status, code,
    })
    return fail('oauth_revoked', REVOKED_MESSAGE)
  }

  // `invalid_client` / `unauthorized_client` / `invalid_scope` are OURS: a
  // wrong secret, an app registration missing a scope, a redirect URI that
  // does not match. They are logged at error level because somebody has to
  // look, and reported as transient because retrying is harmless and the
  // operator has nothing to fix.
  logError(MODULE, 'token endpoint refused the request', {
    provider: config.key, grant: form.grant_type, status: res.status, code: code || 'unknown',
  })
  return fail(
    'oauth_refresh_failed',
    form.grant_type === 'authorization_code' ? EXCHANGE_FAILED_MESSAGE : REFRESH_FAILED_MESSAGE
  )
}

/**
 * Absolute expiry for a token set, as an ISO string.
 *
 * Computed from OUR clock rather than from any `expires_on` the provider might
 * send, because the value is compared against our clock everywhere else
 * (auth-strategy's skew check, REFRESH_WINDOW_MS here). Mixing the two clocks
 * is how a token that is fine reads as expired on a host whose time has
 * drifted.
 */
function expiresAtIso(tokens, now) {
  const seconds = Number(tokens?.expires_in)
  const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds : FALLBACK_EXPIRES_IN_S
  return new Date(now + lifetime * 1000).toISOString()
}

/**
 * Exchange a consent code for the first token set.
 *
 * `redirectUri` must be byte-identical to the one sent to the authorize
 * endpoint — the provider compares them, and a mismatch is an `invalid_grant`
 * that reads exactly like a revoked consent. Passing it explicitly rather than
 * rebuilding it here is what keeps the two call sites honest.
 *
 * 🔴 A TOKEN SET WITH NO REFRESH TOKEN IS REFUSED, NOT STORED. Without one the
 * mailbox works for an hour and then stops, and it stops as an auth failure
 * that looks exactly like a revoked password — an operator would go and
 * re-generate credentials that were never the problem. Microsoft omits the
 * refresh token when `offline_access` was not granted (a tenant policy can
 * strip it), so this is a real branch and not defensive decoration. Refusing
 * at connect time puts the failure in front of the person who can fix it,
 * while they are still looking at the screen.
 */
export async function exchangeCodeForTokens({ config, code, redirectUri }, deps = {}) {
  const now = deps.now ? deps.now() : Date.now()
  const result = await postToken(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    // Requesting the scopes again on the token call is what Microsoft's
    // documented auth-code flow does, and it is what pins the token to the
    // Outlook resource rather than to whatever the consent happened to cover.
    scope: config.scopes.join(' '),
  }, deps)
  if (!result.ok) return result

  const refreshToken = typeof result.tokens.refresh_token === 'string' ? result.tokens.refresh_token : ''
  if (!refreshToken) {
    logError(MODULE, 'consent returned no refresh token — refusing to store a connection that dies in an hour', {
      provider: config.key,
    })
    return fail('not_configured', NO_REFRESH_TOKEN_MESSAGE)
  }

  return {
    ok: true,
    tokens: {
      accessToken: result.tokens.access_token,
      refreshToken,
      expiresAt: expiresAtIso(result.tokens, now),
      scope: typeof result.tokens.scope === 'string' ? result.tokens.scope : '',
    },
  }
}

/**
 * Spend a refresh token for a new access token.
 *
 * 🔴 THE REFRESH TOKEN MAY ROTATE. Microsoft returns a new one on most
 * refreshes and the caller MUST persist it — this is the same trap
 * src/lib/xero/client.js documents ("Xero rotates the refresh_token on every
 * call — the new value MUST be persisted or future refreshes break"). When the
 * provider does NOT send one, the existing token stays valid and is carried
 * forward; treating a missing rotation as a lost grant would disconnect a
 * perfectly good mailbox on every other refresh.
 */
export async function refreshAccessToken({ config, refreshToken }, deps = {}) {
  const now = deps.now ? deps.now() : Date.now()
  const result = await postToken(config, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: config.scopes.join(' '),
  }, deps)
  if (!result.ok) return result

  return {
    ok: true,
    tokens: {
      accessToken: result.tokens.access_token,
      // Carried forward when absent — see above.
      refreshToken: typeof result.tokens.refresh_token === 'string' && result.tokens.refresh_token
        ? result.tokens.refresh_token
        : refreshToken,
      expiresAt: expiresAtIso(result.tokens, now),
      scope: typeof result.tokens.scope === 'string' ? result.tokens.scope : '',
    },
  }
}

/**
 * The column patch for a token set: three sealed/plain columns and nothing
 * else.
 *
 * Sealed with the SAME secret-box the password uses, deliberately (spec §6).
 * An OAuth refresh token is not weaker than a password — it is a bearer
 * credential for the same mailbox, it survives a password change, and it is
 * the one an attacker would prefer because using it leaves no "new sign-in"
 * notification. The estate's existing OAuth precedent, `xero_connections`,
 * stores tokens in PLAINTEXT behind a service-role-only table and carries its
 * own `TODO: layer pgcrypto-based encryption later`. That precedent does not
 * transfer here for exactly the reason mig 572 already gives about the
 * password: those are OUR tokens for OUR accounts, and these are a CUSTOMER's.
 *
 * Throws only if `seal()` throws (missing/malformed MAILBOX_SECRET_KEY), which
 * is why every caller checks isConfigured() first and why this is not exported
 * as a verdict-returning function — a caller that reaches it has already
 * proven the key is there.
 */
function tokenColumns(tokens) {
  return {
    auth_type: 'oauth',
    oauth_access_token_ciphertext: seal(tokens.accessToken),
    oauth_refresh_token_ciphertext: seal(tokens.refreshToken),
    oauth_expires_at: tokens.expiresAt,
    // 🔴 THE PASSWORD COLUMN IS CLEARED WHEN A MAILBOX BECOMES OAUTH.
    // Leaving a stale app password behind an OAuth connection would keep a
    // live credential for the customer's mailbox in our database that nothing
    // reads, nothing rotates and no screen mentions — the definition of a
    // secret nobody is responsible for. It also makes auth_type the single
    // source of truth about how this mailbox authenticates, rather than a hint
    // that two credentials disagree.
    secret_ciphertext: null,
  }
}

export { tokenColumns as oauthTokenColumns }

/**
 * Resolve a credential row to a usable auth strategy, REFRESHING FIRST when
 * the stored access token is spent or nearly spent.
 *
 * This is the function the poller and the sender call. Password rows pass
 * straight through to resolveAuth() untouched — the refresh path is not
 * reachable for them, and a password mailbox must not pay a single extra
 * branch for a feature it does not use.
 *
 * NEVER THROWS. Returns resolveAuth()'s own verdict shape, so a call site can
 * be switched from one to the other by adding `await` and a `db` argument.
 *
 * ── WHY A FAILED PERSIST DOES NOT FAIL THE POLL ───────────────────────────
 * If the refresh succeeds and the database write does not, we hold a live
 * access token and a mailbox full of a customer's mail waiting to be
 * collected. Refusing to use it would trade a bookkeeping failure for a
 * CERTAIN loss of this tick's mail — precisely the "removing a silent failure
 * must never create a louder one" rule in CLAUDE.md. So the write is attempted,
 * its failure is logged structurally at error level, and the token is used.
 * The cost is that the next tick refreshes again from the old refresh token,
 * which providers permit; the benefit is that a Supabase blip does not stop a
 * studio receiving mail.
 *
 * @param {object} db — service-role supabase client
 * @param {object} credentialRow — an `email_mailbox_credentials` row, which
 *   MUST include `oauth_refresh_token_ciphertext` for a refresh to be possible
 * @param {object} [deps] — `{ fetch, now, env }`, test seam only
 * @returns {Promise<object>} the resolveAuth verdict shape
 */
export async function resolveFreshAuth(db, credentialRow, deps = {}) {
  const now = deps.now ? deps.now() : Date.now()

  // Everything that is not an OAuth row is somebody else's problem, answered
  // by the pure resolver exactly as before.
  const authType = String(credentialRow?.auth_type ?? 'password').trim().toLowerCase()
  if (authType !== 'oauth') return resolveAuth(credentialRow, { now })

  // Is a refresh even due? Asked BEFORE anything is unsealed: the common case
  // is a token with fifty minutes left, and that case must cost one Date.parse
  // and no crypto.
  const expiresAt = credentialRow?.oauth_expires_at
  const expiresMs = expiresAt instanceof Date
    ? expiresAt.getTime()
    : (expiresAt ? Date.parse(expiresAt) : NaN)
  // An unreadable or absent expiry is NOT treated as "refresh now" — that is
  // the same judgement auth-strategy makes, for the same reason: a missing
  // timestamp is not evidence a token is dead, and refreshing on it would
  // spend a grant on every single tick of a mailbox whose provider simply did
  // not send `expires_in`.
  const due = Number.isFinite(expiresMs) && expiresMs - REFRESH_WINDOW_MS <= now
  if (!due) return resolveAuth(credentialRow, { now })

  // From here a refresh is wanted. Anything that stops us reaching the
  // provider falls back to resolveAuth's verdict on the token we already hold,
  // which is the honest answer — sometimes that token is still usable for
  // another four minutes, and using it beats refusing.
  const sealedRefresh = credentialRow.oauth_refresh_token_ciphertext
  if (typeof sealedRefresh !== 'string' || !sealedRefresh) {
    // No refresh token at all. exchangeCodeForTokens refuses to create such a
    // row, so this is either a hand-written row or a SELECT that omitted the
    // column — and the second one is the likely and dangerous case, because it
    // would silently downgrade every mailbox to "expires in an hour, forever".
    logError(MODULE, 'oauth credential has no refresh token — cannot renew', {
      mailboxId: credentialRow?.mailbox_id,
    })
    return resolveAuth(credentialRow, { now })
  }

  if (!isConfigured()) {
    // 🔴 STATED HERE RATHER THAN DELEGATED, AND THAT IS THE WHOLE POINT.
    //
    // This branch is only reachable when a refresh is DUE, which means the
    // stored token is spent or nearly so — and resolveAuth judges expiry
    // BEFORE it asks whether the key exists. So delegating returned
    // `oauth_expired` for any token already past its skew, and the poller's
    // config-fault door is `reason === 'not_configured' && !isConfigured()`:
    // the deployment fault walked straight past it onto the AUTH backoff curve
    // and paused the tenant for up to 24 hours over an env var nobody set.
    //
    // That is exactly the shape IMAP-CONFIGPAUSE.1 already fixed once, and it
    // reappeared here because the fault was being classified by a function
    // that asks a different question first. A missing key is a deployment
    // fault at every token age, so this says so directly. The sentence matches
    // auth-strategy's own for the same condition — the poller keys on the
    // REASON, and an operator reading the card sees one wording either way.
    return fail(
      'not_configured',
      'Mailbox encryption is not configured on this deployment (MAILBOX_SECRET_KEY).'
    )
  }

  // resolveAuth opens only the ACCESS token, so the refresh token has to be
  // opened here. The failure is reported the same way it is there — a constant
  // sentence, the underlying error discarded rather than forwarded, because
  // this string is persisted and displayed.
  let refreshToken
  try {
    refreshToken = open(sealedRefresh)
  } catch {
    logError(MODULE, 'stored refresh token could not be decrypted', {
      mailboxId: credentialRow?.mailbox_id,
    })
    return fail(
      'decrypt_failed',
      'The stored sign-in for this mailbox could not be read. It may have been encrypted with a ' +
      'different key — sign in again from Settings → Email.'
    )
  }

  const provider = resolveOAuthProvider(credentialRow.provider, deps.env ? { env: deps.env } : undefined)
  if (!provider.ok) {
    // The provider this row names cannot be run by THIS BUILD — an env var was
    // dropped, or `status` was flipped to 'unavailable' after mailboxes had
    // already been connected to it.
    //
    // 🔴 REPORTED AS A DEPLOYMENT FAULT, NOT AS THE TENANT'S. Every mailbox on
    // that provider hits this at the same instant, so putting it on the auth
    // backoff curve would pause every one of them for up to 24 hours over a
    // missing env var — the exact shape IMAP-CONFIGPAUSE.1 already fixed once
    // for MAILBOX_SECRET_KEY. `provider_unavailable` is its own reason so the
    // poller can record it without counting or pausing. The sentence is
    // carried through verbatim: it is already written for an operator and
    // already names the fix.
    return fail('provider_unavailable', provider.error)
  }

  const refreshed = await refreshAccessToken(
    { config: provider.config, refreshToken },
    { fetch: deps.fetch, now: () => now, timeoutMs: deps.timeoutMs }
  )
  if (!refreshed.ok) {
    // 🔴 THE ONE PLACE THE TWO FAILURES DIVERGE, AND THE ONLY PLACE THEY CAN.
    // `oauth_revoked` is passed up as-is so the poller can put it on the AUTH
    // curve and the card can tell the operator to sign in again.
    // `oauth_refresh_failed` is passed up as-is so the poller can put it on the
    // TRANSPORT curve and NOT tell the operator anything is their fault.
    return refreshed
  }

  // ── Persist, then use. In that order, and the failure of the first does not
  //    stop the second. ────────────────────────────────────────────────────
  let patch = null
  try {
    patch = tokenColumns(refreshed.tokens)
  } catch {
    // seal() threw despite isConfigured() — a key that decodes to 32 bytes but
    // is rejected by the cipher, or a token the cipher will not take. Nothing
    // is written; the fresh token is still USED for this run rather than
    // thrown away, because we hold a working credential and a mailbox full of
    // a customer's mail.
    logError(MODULE, 'refreshed tokens could not be sealed', { mailboxId: credentialRow?.mailbox_id })
  }

  if (patch) {
    try {
      const { error } = await db.from('email_mailbox_credentials')
        .update({ ...patch, updated_at: new Date(now).toISOString() })
        .eq('mailbox_id', credentialRow.mailbox_id)
      if (error) {
        logError(MODULE, 'could not store the renewed sign-in — using it for this run anyway', {
          mailboxId: credentialRow?.mailbox_id, code: error.code, error: error.message,
        })
      }
    } catch (err) {
      logError(MODULE, 'storing the renewed sign-in threw — using it for this run anyway', {
        mailboxId: credentialRow?.mailbox_id, err: err?.message || 'error',
      })
    }

    // Resolved through resolveAuth rather than returned directly, so the auth
    // object this function hands back is built by exactly the same code that
    // builds it in the password case and in the not-due case. Three
    // constructors for one contract is how shapes drift, and this one is
    // handed straight to imapflow.
    return resolveAuth(
      {
        ...credentialRow,
        auth_type: 'oauth',
        oauth_access_token_ciphertext: patch.oauth_access_token_ciphertext,
        oauth_expires_at: refreshed.tokens.expiresAt,
      },
      { now }
    )
  }

  // The seal failed, so there is no ciphertext to hand resolveAuth and no way
  // to make one — calling seal() again would throw again, and this function
  // does not throw. The verdict is built by hand HERE and nowhere else, in the
  // one branch where the plaintext is already in scope. `user` is normalised
  // the same way resolveAuth normalises it so the two shapes cannot differ.
  const user = typeof credentialRow.username === 'string' ? credentialRow.username.trim() : ''
  if (!user) return fail('not_configured', 'The stored credential has no username.')
  return { ok: true, auth: { user, accessToken: refreshed.tokens.accessToken } }
}

/** Exported for the callback route, which reports a declined consent. */
export const OAUTH_DENIED_MESSAGE = DENIED_MESSAGE
/** Exported for the callback route's encryption pre-check. */
export const OAUTH_ENCRYPTION_MESSAGE = ENCRYPTION_MESSAGE

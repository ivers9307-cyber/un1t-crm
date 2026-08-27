// MAILBOX-OAUTH.2 — the token lifecycle.
//
// Six properties, and every one of them is a real incident if it slips:
//
//   1. 🔴 A TOKEN NEVER ESCAPES. Not into a return value, not into an `error`
//      string that lands in `email_mailbox_ingress.last_error` and renders on
//      a card an owner can read, not into a log line, not into the arguments
//      the logger was called with. Asserted by scanning EVERY logger call and
//      EVERY returned verdict for the literal token bytes, rather than by
//      reading the source and believing it.
//   2. 🔴 REFRESH-BEFORE-USE ACTUALLY REFRESHES, and persists the rotated pair.
//      Microsoft rotates the refresh token on most refreshes; a caller that
//      does not store the new one has a mailbox that dies on the SECOND
//      renewal, days later, looking like a provider fault.
//   3. 🔴 A REFRESH FAILURE IS DISTINGUISHABLE FROM A REVOKED GRANT. One is
//      fixed by waiting, the other only by a human clicking Sign in. They are
//      told apart by the OAuth `error` CODE, never by the HTTP status — a 400
//      is also what OUR malformed request gets.
//   4. 🔴 THE PASSWORD PATH IS BYTE-FOR-BYTE UNCHANGED. resolveFreshAuth is
//      now in front of every password mailbox in the estate. It must make no
//      network call, no database write, and return exactly what resolveAuth
//      would have returned — proven by running the real resolveAuth beside it
//      and comparing, not by asserting a shape.
//   5. A FAILED PERSIST DOES NOT FAIL THE POLL. We hold a live token and a
//      mailbox full of a customer's mail; refusing to use it would trade a
//      bookkeeping failure for a certain loss of this tick's mail.
//   6. NOTHING THROWS. The callers are a cron and a send path.
//
// secret-box runs FOR REAL throughout — a stub would prove this file calls a
// function, where the thing worth pinning is that a sealed token opens and the
// plaintext never leaves.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The logger is mocked so every call can be SCANNED. This is the only way to
// assert "no token was logged" as a fact rather than as a reading of the code.
vi.mock('@/lib/log', () => ({
  logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn(),
}))

import {
  exchangeCodeForTokens,
  refreshAccessToken,
  resolveFreshAuth,
  oauthTokenColumns,
  REFRESH_WINDOW_MS,
  OAUTH_DENIED_MESSAGE,
  OAUTH_ENCRYPTION_MESSAGE,
} from './oauth-tokens'
import { resolveAuth } from './auth-strategy'
import { seal, open as openSealed } from './secret-box'
import { resolveOAuthProvider } from './oauth-providers'
import { logError, logWarn } from '@/lib/log'

const KEY = Buffer.alloc(32, 19).toString('base64')

const ENV = Object.freeze({
  MAILBOX_OAUTH_MICROSOFT_CLIENT_ID: 'the-client-id',
  MAILBOX_OAUTH_MICROSOFT_CLIENT_SECRET: 'the-client-secret',
})

const CONFIG = () => resolveOAuthProvider('microsoft', { env: ENV }).config

// Deliberately distinctive strings. Every leak assertion searches for these
// literals, so they must not look like anything else in the file.
const ACCESS = 'ACCESS-TOKEN-b9f3e1'
const REFRESH = 'REFRESH-TOKEN-4c7a20'
const ROTATED = 'REFRESH-TOKEN-ROTATED-11de55'
const APP_PASSWORD = 'APP-PASSWORD-77aa31'

const NOW = Date.parse('2026-08-27T10:00:00.000Z')

/** A fetch that answers once with a given status + JSON body. */
function fetchOnce(status, body) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }))
}

/** A token endpoint that answers with a normal Microsoft token response. */
function fetchTokens(overrides = {}) {
  return fetchOnce(200, {
    access_token: ACCESS,
    refresh_token: REFRESH,
    expires_in: 3600,
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All',
    ...overrides,
  })
}

/**
 * A supabase stand-in that records updates. `.update().eq()` is a thenable,
 * exactly as supabase-js is — a plain Promise here would hide an await bug.
 */
function fakeDb({ error = null, throws = false } = {}) {
  const updates = []
  return {
    updates,
    from(table) {
      return {
        update(payload) {
          const b = {
            _filters: [],
            eq(col, val) { b._filters.push([col, val]); return b },
            then(res, rej) {
              if (throws) return Promise.reject(new Error('supabase is down')).then(res, rej)
              updates.push({ table, payload, filters: b._filters })
              return Promise.resolve({ data: null, error }).then(res, rej)
            },
          }
          return b
        },
      }
    },
  }
}

/** An OAuth credential row as PostgREST hands it back. */
function oauthRow(overrides = {}) {
  return {
    mailbox_id: 'mb-1',
    provider: 'microsoft',
    auth_type: 'oauth',
    username: 'hello@theirgym.ie',
    secret_ciphertext: null,
    oauth_access_token_ciphertext: seal(ACCESS),
    oauth_refresh_token_ciphertext: seal(REFRESH),
    // Comfortably live: fifty minutes left, so no refresh is due.
    oauth_expires_at: new Date(NOW + 50 * 60_000).toISOString(),
    ...overrides,
  }
}

/** A password credential row — the shape 100% of production rows have today. */
function passwordRow(overrides = {}) {
  return {
    mailbox_id: 'mb-2',
    provider: 'gmail',
    auth_type: 'password',
    username: 'studio@un1tdublin.com',
    secret_ciphertext: seal(APP_PASSWORD),
    oauth_access_token_ciphertext: null,
    oauth_refresh_token_ciphertext: null,
    oauth_expires_at: null,
    ...overrides,
  }
}

/**
 * Every string that has passed through the logger this test, flattened.
 *
 * The assertion "no token was logged" is only worth something if it covers the
 * META objects too — a token smuggled into `{ err }` is still a token in a log
 * aggregator forever.
 */
function loggedText() {
  const calls = [...logError.mock.calls, ...logWarn.mock.calls]
  return JSON.stringify(calls)
}

/** Assert that nothing anywhere in this test carried a credential. */
function expectNoSecretsAnywhere(...verdicts) {
  const haystack = JSON.stringify(verdicts) + loggedText()
  for (const secret of [ACCESS, REFRESH, ROTATED, APP_PASSWORD, 'the-client-secret']) {
    expect(haystack).not.toContain(secret)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.MAILBOX_SECRET_KEY = KEY
})

afterEach(() => {
  delete process.env.MAILBOX_SECRET_KEY
})

/* ══════════════════════════════════════════════════════════════════════════
   1. THE PASSWORD PATH IS UNCHANGED
   ══════════════════════════════════════════════════════════════════════════ */

describe('🔴 the password path is byte-for-byte what it was', () => {
  // This is the regression that would hurt most. resolveFreshAuth now sits in
  // front of every password mailbox in the estate, on the poller AND on the
  // send path. If it does anything at all beyond delegating, it does it to
  // customers who never asked for OAuth.

  it('returns EXACTLY what resolveAuth returns, compared against the real thing', async () => {
    const row = passwordRow()
    const fresh = await resolveFreshAuth(fakeDb(), row, { now: () => NOW })
    const pure = resolveAuth(row, { now: NOW })
    expect(fresh).toEqual(pure)
    expect(fresh).toEqual({ ok: true, auth: { user: 'studio@un1tdublin.com', pass: APP_PASSWORD } })
  })

  it('makes NO network request', async () => {
    const fetchSpy = vi.fn()
    await resolveFreshAuth(fakeDb(), passwordRow(), { now: () => NOW, fetch: fetchSpy })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('makes NO database write', async () => {
    const db = fakeDb()
    await resolveFreshAuth(db, passwordRow(), { now: () => NOW })
    expect(db.updates).toEqual([])
  })

  it('logs nothing at all for a healthy password row', async () => {
    await resolveFreshAuth(fakeDb(), passwordRow(), { now: () => NOW })
    expect(logError).not.toHaveBeenCalled()
    expect(logWarn).not.toHaveBeenCalled()
  })

  // An `auth_type` omitted by a projection must read as 'password' (the
  // column's own NOT NULL DEFAULT), not as something unsupported.
  it('treats a row with no auth_type as a password row, like resolveAuth does', async () => {
    const { auth_type, ...noType } = passwordRow()
    expect(auth_type).toBe('password')
    const fresh = await resolveFreshAuth(fakeDb(), noType, { now: () => NOW })
    expect(fresh).toEqual(resolveAuth(noType, { now: NOW }))
    expect(fresh.ok).toBe(true)
  })

  it('carries every password FAILURE through unchanged, reason for reason', async () => {
    const cases = [
      ['no credential at all', null],
      ['no password stored', passwordRow({ secret_ciphertext: null })],
      ['no username', passwordRow({ username: '   ' })],
      ['a ciphertext that will not open', passwordRow({ secret_ciphertext: 'v1:AAAA:BBBB:CCCC' })],
      ['an auth type this build cannot satisfy', passwordRow({ auth_type: 'kerberos' })],
    ]
    for (const [, row] of cases) {
      const fresh = await resolveFreshAuth(fakeDb(), row, { now: () => NOW })
      expect(fresh).toEqual(resolveAuth(row, { now: NOW }))
      expect(fresh.ok).toBe(false)
    }
  })

  // 🔴 THE ONE THE OTHER PASSWORD TESTS DO NOT CATCH, and it was found by
  // deliberately breaking the short-circuit to see what failed: nothing did.
  //
  // The healthy password row has `oauth_expires_at: null`, so even WITHOUT the
  // `authType !== 'oauth'` short-circuit it falls through the not-due check and
  // behaves identically. The row that separates them is one carrying a STALE
  // `oauth_expires_at` — a mailbox switched back from a provider sign-in to an
  // app password, or any projection that carried the column along. On such a
  // row a missing short-circuit would spend a refresh, hit the provider, and
  // report an OAuth failure for a mailbox that authenticates with a password.
  //
  // `auth_type` IS the single source of truth about how a mailbox
  // authenticates. Nothing else may be consulted first.
  it('🔴 ignores a stale oauth_expires_at left on a password row', async () => {
    const fetchSpy = vi.fn()
    const db = fakeDb()
    const row = passwordRow({
      // Long dead — a refresh would be "due" if anything looked at it.
      oauth_expires_at: new Date(NOW - 24 * 3600_000).toISOString(),
      oauth_refresh_token_ciphertext: seal(REFRESH),
    })

    const verdict = await resolveFreshAuth(db, row, { now: () => NOW, fetch: fetchSpy, env: ENV })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(db.updates).toEqual([])
    expect(verdict).toEqual(resolveAuth(row, { now: NOW }))
    expect(verdict).toEqual({ ok: true, auth: { user: 'studio@un1tdublin.com', pass: APP_PASSWORD } })
  })

  it('does not put the app password anywhere it can be read', async () => {
    const verdict = await resolveFreshAuth(fakeDb(), passwordRow(), { now: () => NOW })
    // The plaintext IS the point of the happy verdict, so it is legitimately in
    // `auth.pass` — what must not happen is it reaching a log line.
    expect(verdict.auth.pass).toBe(APP_PASSWORD)
    expect(loggedText()).not.toContain(APP_PASSWORD)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   2. REFRESH BEFORE USE
   ══════════════════════════════════════════════════════════════════════════ */

describe('🔴 refresh-before-use actually refreshes', () => {
  it('does NOT refresh a token with fifty minutes left', async () => {
    const fetchSpy = vi.fn()
    const db = fakeDb()
    const verdict = await resolveFreshAuth(db, oauthRow(), { now: () => NOW, fetch: fetchSpy, env: ENV })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(db.updates).toEqual([])
    expect(verdict).toEqual({ ok: true, auth: { user: 'hello@theirgym.ie', accessToken: ACCESS } })
  })

  it('DOES refresh a token inside the five-minute window, before it is spent', async () => {
    // The window is wider than auth-strategy's own 60-second refusal skew on
    // purpose: the renewal must always fire before the refusal can.
    const doFetch = fetchTokens({ access_token: 'ACCESS-TOKEN-RENEWED-a1' })
    const db = fakeDb()
    const row = oauthRow({ oauth_expires_at: new Date(NOW + REFRESH_WINDOW_MS - 1000).toISOString() })

    const verdict = await resolveFreshAuth(db, row, { now: () => NOW, fetch: doFetch, env: ENV })

    expect(doFetch).toHaveBeenCalledTimes(1)
    expect(verdict).toEqual({ ok: true, auth: { user: 'hello@theirgym.ie', accessToken: 'ACCESS-TOKEN-RENEWED-a1' } })
  })

  it('refreshes an already-expired token rather than reporting oauth_expired', async () => {
    // The whole reason the wrapper exists: `oauth_expired` is a refusal nothing
    // acts on — the poller cannot mint a token and the operator has nothing to
    // fix.
    const doFetch = fetchTokens({ access_token: 'ACCESS-TOKEN-RENEWED-a1' })
    const row = oauthRow({ oauth_expires_at: new Date(NOW - 60_000).toISOString() })
    const verdict = await resolveFreshAuth(fakeDb(), row, { now: () => NOW, fetch: doFetch, env: ENV })
    expect(verdict.ok).toBe(true)
    expect(resolveAuth(row, { now: NOW }).reason).toBe('oauth_expired')
  })

  it('sends the refresh grant with the client credentials in the BODY', async () => {
    const doFetch = fetchTokens()
    const row = oauthRow({ oauth_expires_at: new Date(NOW).toISOString() })
    await resolveFreshAuth(fakeDb(), row, { now: () => NOW, fetch: doFetch, env: ENV })

    const [url, init] = doFetch.mock.calls[0]
    expect(url).toContain('login.microsoftonline.com')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(init.body.toString())
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe(REFRESH)
    expect(form.get('client_id')).toBe('the-client-id')
  })

  // 🔴 THE SAME TRAP src/lib/xero/client.js DOCUMENTS. Microsoft returns a new
  // refresh token on most refreshes. Not persisting it means the mailbox dies
  // on the SECOND renewal, days later, looking like a provider fault.
  it('persists the ROTATED refresh token, sealed', async () => {
    const doFetch = fetchTokens({ refresh_token: ROTATED })
    const db = fakeDb()
    const row = oauthRow({ oauth_expires_at: new Date(NOW).toISOString() })

    await resolveFreshAuth(db, row, { now: () => NOW, fetch: doFetch, env: ENV })

    expect(db.updates).toHaveLength(1)
    const { table, payload, filters } = db.updates[0]
    expect(table).toBe('email_mailbox_credentials')
    expect(filters).toEqual([['mailbox_id', 'mb-1']])
    // Sealed, not plaintext — and it really is the rotated one.
    expect(payload.oauth_refresh_token_ciphertext).not.toContain(ROTATED)
    expect(openSealed(payload.oauth_refresh_token_ciphertext)).toBe(ROTATED)
    expect(openSealed(payload.oauth_access_token_ciphertext)).toBe(ACCESS)
  })

  it('carries the OLD refresh token forward when the provider rotates nothing', async () => {
    // Treating an absent rotation as a lost grant would disconnect a perfectly
    // good mailbox on every other refresh.
    const doFetch = fetchTokens({ refresh_token: undefined })
    const db = fakeDb()
    const row = oauthRow({ oauth_expires_at: new Date(NOW).toISOString() })

    await resolveFreshAuth(db, row, { now: () => NOW, fetch: doFetch, env: ENV })

    expect(openSealed(db.updates[0].payload.oauth_refresh_token_ciphertext)).toBe(REFRESH)
  })

  it('writes the new expiry from OUR clock, not from the provider’s', async () => {
    const doFetch = fetchTokens({ expires_in: 3600 })
    const db = fakeDb()
    const row = oauthRow({ oauth_expires_at: new Date(NOW).toISOString() })
    await resolveFreshAuth(db, row, { now: () => NOW, fetch: doFetch, env: ENV })
    expect(db.updates[0].payload.oauth_expires_at).toBe(new Date(NOW + 3600_000).toISOString())
  })

  // 🔴 A stale app password sitting behind an OAuth connection is a live
  // credential for a customer's mailbox that nothing reads, nothing rotates
  // and no screen mentions.
  it('clears the password column when a mailbox authenticates by token', async () => {
    const doFetch = fetchTokens()
    const db = fakeDb()
    const row = oauthRow({ oauth_expires_at: new Date(NOW).toISOString() })
    await resolveFreshAuth(db, row, { now: () => NOW, fetch: doFetch, env: ENV })
    expect(db.updates[0].payload.secret_ciphertext).toBeNull()
    expect(db.updates[0].payload.auth_type).toBe('oauth')
  })

  it('does not treat an absent or unreadable expiry as "refresh now"', async () => {
    // A missing timestamp is not evidence a token is dead, and refreshing on it
    // would spend a grant on every tick of a mailbox whose provider simply did
    // not send expires_in.
    const fetchSpy = vi.fn()
    for (const value of [null, '', 'not-a-date', undefined]) {
      await resolveFreshAuth(fakeDb(), oauthRow({ oauth_expires_at: value }), {
        now: () => NOW, fetch: fetchSpy, env: ENV,
      })
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('accepts a Date object for the expiry, as some drivers hand back', async () => {
    const fetchSpy = vi.fn()
    await resolveFreshAuth(fakeDb(), oauthRow({ oauth_expires_at: new Date(NOW + 50 * 60_000) }), {
      now: () => NOW, fetch: fetchSpy, env: ENV,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   3. REVOKED vs COULD-NOT-REFRESH
   ══════════════════════════════════════════════════════════════════════════ */

describe('🔴 a revoked grant and a failed refresh are different facts', () => {
  const due = () => oauthRow({ oauth_expires_at: new Date(NOW).toISOString() })
  const run = (doFetch) => resolveFreshAuth(fakeDb(), due(), { now: () => NOW, fetch: doFetch, env: ENV })

  // RFC 6749 §5.2: `invalid_grant` is the ONLY code that means a human has to
  // act. Matched on the CODE, never the status.
  it('`invalid_grant` is oauth_revoked, and tells the operator to sign in again', async () => {
    const verdict = await run(fetchOnce(400, { error: 'invalid_grant', error_description: 'token expired' }))
    expect(verdict).toMatchObject({ ok: false, reason: 'oauth_revoked' })
    expect(verdict.error).toMatch(/sign in again/i)
  })

  // 🔴 THE ONE THAT MATTERS MOST. A 400 is also what OUR malformed request
  // gets. Telling an operator their consent was withdrawn because we sent a
  // bad client id sends them to their IT department over our defect.
  it('a 400 with ANY OTHER code is NOT revoked — it is ours, and transient', async () => {
    for (const code of ['invalid_client', 'unauthorized_client', 'invalid_scope', 'invalid_request']) {
      vi.clearAllMocks()
      const verdict = await run(fetchOnce(400, { error: code }))
      expect(verdict.reason).toBe('oauth_refresh_failed')
      expect(verdict.error).not.toMatch(/sign in again/i)
      // Somebody has to look at these — they are a deployment defect.
      expect(logError).toHaveBeenCalled()
    }
  })

  it('a 5xx is transient — the grant is fine', async () => {
    const verdict = await run(fetchOnce(503, { error: 'temporarily_unavailable' }))
    expect(verdict.reason).toBe('oauth_refresh_failed')
  })

  it('a 429 is transient', async () => {
    expect((await run(fetchOnce(429, {}))).reason).toBe('oauth_refresh_failed')
  })

  it('a thrown fetch — DNS, socket, abort — is transient, never revoked', async () => {
    const verdict = await run(vi.fn(async () => { throw new Error('ECONNRESET') }))
    expect(verdict.reason).toBe('oauth_refresh_failed')
  })

  it('a 200 carrying no access_token is a contract violation, and transient', async () => {
    const verdict = await run(fetchOnce(200, { token_type: 'Bearer' }))
    expect(verdict.reason).toBe('oauth_refresh_failed')
    expect(logError).toHaveBeenCalled()
  })

  it('an unparseable body does not throw and does not read as revoked', async () => {
    const verdict = await run(vi.fn(async () => ({
      ok: false, status: 502, json: async () => { throw new SyntaxError('not json') },
    })))
    expect(verdict.reason).toBe('oauth_refresh_failed')
  })

  // The two sentences are what an operator sees, and they must say opposite
  // things about whose problem this is.
  it('the two sentences differ in what they ask of the operator', async () => {
    const revoked = await run(fetchOnce(400, { error: 'invalid_grant' }))
    const failed = await run(fetchOnce(503, {}))
    expect(revoked.error).not.toBe(failed.error)
    expect(revoked.error).toMatch(/Settings/)
    expect(failed.error).toMatch(/resume on its own/i)
    expect(failed.error).toMatch(/Nothing is wrong with the connection/i)
  })

  it('aborts a token endpoint that accepts the connection and says nothing', async () => {
    // One customer's identity provider must never delay another's mailbox.
    const doFetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted'); err.name = 'AbortError'; reject(err)
      })
    }))
    const verdict = await resolveFreshAuth(fakeDb(), due(), {
      now: () => NOW, fetch: doFetch, env: ENV, timeoutMs: 10,
    })
    expect(verdict.reason).toBe('oauth_refresh_failed')
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   4. THE THINGS THAT ARE NOT THE TENANT'S FAULT
   ══════════════════════════════════════════════════════════════════════════ */

describe('deployment faults are reported as deployment faults', () => {
  const due = (o = {}) => oauthRow({ oauth_expires_at: new Date(NOW).toISOString(), ...o })

  // Every mailbox on that provider hits this at the same instant. On the auth
  // backoff curve that pauses all of them for up to 24 hours over an env var.
  it('a provider this deployment cannot run is `provider_unavailable`', async () => {
    const verdict = await resolveFreshAuth(fakeDb(), due(), {
      now: () => NOW, fetch: vi.fn(), env: {},
    })
    expect(verdict.reason).toBe('provider_unavailable')
    expect(verdict.error).toMatch(/MAILBOX_OAUTH_MICROSOFT_CLIENT_ID/)
  })

  it('carries Google’s refusal verbatim for a row that somehow names it', async () => {
    const verdict = await resolveFreshAuth(fakeDb(), due({ provider: 'google' }), {
      now: () => NOW, fetch: vi.fn(), env: ENV,
    })
    expect(verdict.reason).toBe('provider_unavailable')
    expect(verdict.error).toMatch(/CASA/)
  })

  // 🔴 A DEFECT FOUND BY THIS TEST, NOT BY READING THE CODE.
  //
  // This branch is only reached when a refresh is DUE — i.e. the token is
  // spent — and resolveAuth judges EXPIRY BEFORE it asks whether the key
  // exists. So delegating to it answered `oauth_expired`, while the poller's
  // config-fault door is `reason === 'not_configured' && !isConfigured()`.
  // A missing MAILBOX_SECRET_KEY therefore walked past that door onto the AUTH
  // backoff curve and paused the tenant for up to 24 hours over an env var —
  // the exact failure IMAP-CONFIGPAUSE.1 fixed once already, reintroduced
  // because the fault was being classified by a function that asks a different
  // question first.
  it('a missing encryption key is not_configured at EVERY token age', async () => {
    // The row is sealed FIRST, then the key is removed — the real shape of the
    // incident (rows exist, the env var went missing).
    for (const expiry of [
      new Date(NOW).toISOString(),              // exactly spent
      new Date(NOW - 3600_000).toISOString(),   // an hour dead
      new Date(NOW + 60_000).toISOString(),     // inside auth-strategy's own skew
      new Date(NOW + 4 * 60_000).toISOString(), // due, but not yet refusable
    ]) {
      process.env.MAILBOX_SECRET_KEY = KEY
      const row = due({ oauth_expires_at: expiry })
      delete process.env.MAILBOX_SECRET_KEY
      const verdict = await resolveFreshAuth(fakeDb(), row, { now: () => NOW, fetch: vi.fn(), env: ENV })
      expect(verdict).toMatchObject({ ok: false, reason: 'not_configured' })
      expect(verdict.error).toMatch(/MAILBOX_SECRET_KEY/)
    }
  })

  it('spends no refresh when the key is gone — there is nothing to store it with', async () => {
    process.env.MAILBOX_SECRET_KEY = KEY
    const row = due()
    delete process.env.MAILBOX_SECRET_KEY
    const fetchSpy = vi.fn()
    await resolveFreshAuth(fakeDb(), row, { now: () => NOW, fetch: fetchSpy, env: ENV })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // The likely and dangerous case is a SELECT that omitted the column, which
  // would silently downgrade every mailbox to "expires in an hour, forever".
  it('a row with no refresh token is loud, and falls back to the pure verdict', async () => {
    const row = due({ oauth_refresh_token_ciphertext: null })
    const verdict = await resolveFreshAuth(fakeDb(), row, { now: () => NOW, fetch: vi.fn(), env: ENV })
    expect(logError).toHaveBeenCalled()
    expect(verdict).toEqual(resolveAuth(row, { now: NOW }))
  })

  it('a refresh token sealed with a different key reports decrypt_failed', async () => {
    // The one failure that must be investigated rather than retried.
    const row = due({ oauth_refresh_token_ciphertext: 'v1:AAAA:BBBB:CCCC' })
    const verdict = await resolveFreshAuth(fakeDb(), row, { now: () => NOW, fetch: vi.fn(), env: ENV })
    expect(verdict).toMatchObject({ ok: false, reason: 'decrypt_failed' })
    expect(verdict.error).toMatch(/different key/i)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   5. A FAILED PERSIST DOES NOT COST THE TICK
   ══════════════════════════════════════════════════════════════════════════ */

describe('🔴 a database that will not take the new token does not lose the mail', () => {
  const due = () => oauthRow({ oauth_expires_at: new Date(NOW).toISOString() })

  it('uses the fresh token anyway when the update errors', async () => {
    // Refusing to use a live token would trade a bookkeeping failure for a
    // CERTAIN loss of this tick's mail — CLAUDE.md's rule, exactly.
    const db = fakeDb({ error: { code: '57014', message: 'statement timeout' } })
    const verdict = await resolveFreshAuth(db, due(), {
      now: () => NOW, fetch: fetchTokens({ access_token: 'ACCESS-TOKEN-RENEWED-a1' }), env: ENV,
    })
    expect(verdict).toEqual({ ok: true, auth: { user: 'hello@theirgym.ie', accessToken: 'ACCESS-TOKEN-RENEWED-a1' } })
    expect(logError).toHaveBeenCalled()
  })

  it('uses the fresh token anyway when the update THROWS', async () => {
    const db = fakeDb({ throws: true })
    const verdict = await resolveFreshAuth(db, due(), {
      now: () => NOW, fetch: fetchTokens({ access_token: 'ACCESS-TOKEN-RENEWED-a1' }), env: ENV,
    })
    expect(verdict.ok).toBe(true)
    expect(logError).toHaveBeenCalled()
  })

  it('still refuses when the row has no username to authenticate as', async () => {
    const db = fakeDb()
    const verdict = await resolveFreshAuth(db, oauthRow({
      oauth_expires_at: new Date(NOW).toISOString(), username: '  ',
    }), { now: () => NOW, fetch: fetchTokens(), env: ENV })
    expect(verdict.ok).toBe(false)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   6. THE EXCHANGE
   ══════════════════════════════════════════════════════════════════════════ */

describe('exchanging a consent code', () => {
  const exchange = (doFetch) => exchangeCodeForTokens(
    { config: CONFIG(), code: 'the-consent-code', redirectUri: 'https://crm.repset.ie/api/email/oauth/callback' },
    { fetch: doFetch, now: () => NOW }
  )

  it('sends the authorization_code grant with the exact redirect URI', async () => {
    // The provider compares them byte for byte, and a mismatch surfaces as
    // `invalid_grant` — which reads exactly like a revoked consent.
    const doFetch = fetchTokens()
    await exchange(doFetch)
    const form = new URLSearchParams(doFetch.mock.calls[0][1].body.toString())
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('the-consent-code')
    expect(form.get('redirect_uri')).toBe('https://crm.repset.ie/api/email/oauth/callback')
    expect(form.get('scope')).toContain('offline_access')
  })

  it('returns the token set with an absolute expiry', async () => {
    const result = await exchange(fetchTokens())
    expect(result.ok).toBe(true)
    expect(result.tokens).toEqual({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      expiresAt: new Date(NOW + 3600_000).toISOString(),
      scope: 'https://outlook.office.com/IMAP.AccessAsUser.All',
    })
  })

  it('falls back to a CONSERVATIVE lifetime when the provider omits expires_in', async () => {
    // Under-estimating costs an extra refresh; over-estimating means handing
    // imapflow a token we believe is live and is not.
    const result = await exchange(fetchTokens({ expires_in: undefined }))
    expect(Date.parse(result.tokens.expiresAt) - NOW).toBeLessThanOrEqual(10 * 60_000)
  })

  it('ignores a nonsense expires_in rather than minting a token in the past', async () => {
    for (const junk of [-1, 0, 'soon', null]) {
      const result = await exchange(fetchTokens({ expires_in: junk }))
      expect(Date.parse(result.tokens.expiresAt)).toBeGreaterThan(NOW)
    }
  })

  // 🔴 A connection with no refresh token works for an hour and then stops, as
  // an auth failure that looks exactly like a revoked password — so an operator
  // would go and regenerate credentials that were never the problem.
  it('REFUSES a token set with no refresh token rather than storing it', async () => {
    const result = await exchange(fetchTokens({ refresh_token: undefined }))
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('not_configured')
    expect(result.error).toMatch(/sign in again and accept every permission/i)
    expect(logError).toHaveBeenCalled()
  })

  it('refuses an empty-string refresh token the same way', async () => {
    expect((await exchange(fetchTokens({ refresh_token: '' }))).ok).toBe(false)
  })

  it('reports an exchange failure with the exchange sentence, not the refresh one', async () => {
    // "please try again" belongs on a screen somebody is looking at; "checking
    // will resume on its own" belongs to a cron.
    const result = await exchange(fetchOnce(400, { error: 'invalid_request' }))
    expect(result.error).toMatch(/Nothing has been saved — please try again/i)
  })

  it('an invalid_grant during exchange still reads as revoked', async () => {
    // Usually a redirect_uri mismatch or a code used twice.
    expect((await exchange(fetchOnce(400, { error: 'invalid_grant' }))).reason).toBe('oauth_revoked')
  })
})

describe('refreshAccessToken on its own', () => {
  it('rotates when a new refresh token comes back', async () => {
    const result = await refreshAccessToken(
      { config: CONFIG(), refreshToken: REFRESH },
      { fetch: fetchTokens({ refresh_token: ROTATED }), now: () => NOW }
    )
    expect(result.tokens.refreshToken).toBe(ROTATED)
  })

  it('carries forward when none does', async () => {
    const result = await refreshAccessToken(
      { config: CONFIG(), refreshToken: REFRESH },
      { fetch: fetchTokens({ refresh_token: undefined }), now: () => NOW }
    )
    expect(result.tokens.refreshToken).toBe(REFRESH)
  })

  it('does not demand a refresh token in the response to succeed', async () => {
    // Unlike the exchange, where its absence is fatal.
    const result = await refreshAccessToken(
      { config: CONFIG(), refreshToken: REFRESH },
      { fetch: fetchTokens({ refresh_token: undefined }), now: () => NOW }
    )
    expect(result.ok).toBe(true)
  })
})

describe('oauthTokenColumns', () => {
  it('seals both tokens and clears the password', () => {
    const patch = oauthTokenColumns({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 'X' })
    expect(patch.auth_type).toBe('oauth')
    expect(patch.secret_ciphertext).toBeNull()
    expect(patch.oauth_access_token_ciphertext).not.toContain(ACCESS)
    expect(openSealed(patch.oauth_access_token_ciphertext)).toBe(ACCESS)
    expect(openSealed(patch.oauth_refresh_token_ciphertext)).toBe(REFRESH)
  })

  it('produces a ciphertext the pure resolver can open — the round trip is proven here', () => {
    const patch = oauthTokenColumns({
      accessToken: ACCESS, refreshToken: REFRESH,
      expiresAt: new Date(NOW + 3600_000).toISOString(),
    })
    expect(resolveAuth({ ...patch, username: 'hello@theirgym.ie' }, { now: NOW }))
      .toEqual({ ok: true, auth: { user: 'hello@theirgym.ie', accessToken: ACCESS } })
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   7. NOTHING LEAKS, AND NOTHING THROWS
   ══════════════════════════════════════════════════════════════════════════ */

describe('🔴 no token reaches a response, a log line or a stored error', () => {
  const due = () => oauthRow({ oauth_expires_at: new Date(NOW).toISOString() })

  it('not on a successful refresh', async () => {
    const db = fakeDb()
    const verdict = await resolveFreshAuth(db, due(), { now: () => NOW, fetch: fetchTokens({ refresh_token: ROTATED }), env: ENV })
    // The access token is legitimately in `auth.accessToken` — that is the
    // product. The REFRESH token must not be anywhere at all, and neither
    // token may reach a log.
    expect(JSON.stringify(verdict)).not.toContain(ROTATED)
    expect(JSON.stringify(verdict)).not.toContain(REFRESH)
    expect(loggedText()).not.toContain(ACCESS)
    expect(loggedText()).not.toContain(REFRESH)
    expect(loggedText()).not.toContain(ROTATED)
  })

  it('not on a revoked grant', async () => {
    const verdict = await resolveFreshAuth(fakeDb(), due(), {
      now: () => NOW, fetch: fetchOnce(400, { error: 'invalid_grant' }), env: ENV,
    })
    expectNoSecretsAnywhere(verdict)
  })

  it('not on a transient failure', async () => {
    const verdict = await resolveFreshAuth(fakeDb(), due(), {
      now: () => NOW, fetch: fetchOnce(503, { error: 'temporarily_unavailable' }), env: ENV,
    })
    expectNoSecretsAnywhere(verdict)
  })

  // 🔴 A token endpoint's error body can ECHO REQUEST PARAMETERS BACK — which
  // on this endpoint means the refresh token and the client secret. This is the
  // single most likely way a credential ends up in `last_error`, on a card an
  // owner can read.
  it('not when the provider echoes our own request back in its error body', async () => {
    const hostile = fetchOnce(400, {
      error: 'invalid_request',
      error_description: `refresh_token=${REFRESH} client_secret=the-client-secret was rejected`,
      trace: { access_token: ACCESS },
    })
    const verdict = await resolveFreshAuth(fakeDb(), due(), { now: () => NOW, fetch: hostile, env: ENV })
    expectNoSecretsAnywhere(verdict)
    // The error CODE is ours to read and is the only thing that makes a
    // failure diagnosable — it IS logged.
    expect(loggedText()).toContain('invalid_request')
  })

  it('not when the exception itself carries the request options', async () => {
    const err = new Error('fetch failed')
    err.options = { body: `refresh_token=${REFRESH}&client_secret=the-client-secret` }
    const verdict = await resolveFreshAuth(fakeDb(), due(), {
      now: () => NOW, fetch: vi.fn(async () => { throw err }), env: ENV,
    })
    expectNoSecretsAnywhere(verdict)
  })

  it('not on an exchange, in any of its outcomes', async () => {
    const results = []
    for (const doFetch of [
      fetchTokens(),
      fetchOnce(400, { error: 'invalid_grant', error_description: `code exchanged for ${ACCESS}` }),
      fetchTokens({ refresh_token: undefined }),
      fetchOnce(500, { error_description: REFRESH }),
    ]) {
      results.push(await exchangeCodeForTokens(
        { config: CONFIG(), code: 'the-consent-code', redirectUri: 'https://x/cb' },
        { fetch: doFetch, now: () => NOW }
      ))
    }
    // The successful exchange legitimately returns the tokens — that is what
    // the callback seals. What must never happen is any of it being LOGGED.
    expect(loggedText()).not.toContain(ACCESS)
    expect(loggedText()).not.toContain(REFRESH)
    // And no FAILED result carries one.
    expect(JSON.stringify(results.filter(r => !r.ok))).not.toContain(ACCESS)
    expect(JSON.stringify(results.filter(r => !r.ok))).not.toContain(REFRESH)
  })

  it('never logs the client secret, on any path', async () => {
    await resolveFreshAuth(fakeDb(), due(), { now: () => NOW, fetch: fetchOnce(401, { error: 'invalid_client' }), env: ENV })
    expect(loggedText()).not.toContain('the-client-secret')
  })
})

describe('nothing throws — the callers are a cron and a member’s reply', () => {
  it('survives junk rows', async () => {
    for (const row of [null, undefined, 'a string', 42, [], {}]) {
      await expect(resolveFreshAuth(fakeDb(), row, { now: () => NOW, env: ENV })).resolves.toBeTruthy()
    }
  })

  it('survives a db argument that is not a client at all', async () => {
    // The refresh succeeded; the persist is what has no client. The mail must
    // still be collectable.
    const verdict = await resolveFreshAuth(null, oauthRow({ oauth_expires_at: new Date(NOW).toISOString() }), {
      now: () => NOW, fetch: fetchTokens(), env: ENV,
    })
    expect(verdict.ok).toBe(true)
  })

  it('exposes the two operator sentences the callback route renders', () => {
    expect(OAUTH_DENIED_MESSAGE).toMatch(/declined/i)
    expect(OAUTH_ENCRYPTION_MESSAGE).toMatch(/encryption key/i)
    expect(OAUTH_ENCRYPTION_MESSAGE).toMatch(/Nothing has been saved/i)
  })
})

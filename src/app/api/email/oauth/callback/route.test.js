// MAILBOX-OAUTH.4 — where a mailbox sign-in comes back.
//
// The trickiest route in this feature, because it is an unauthenticated-looking
// GET that a third party sends a browser to, and it writes a customer
// credential. What this file pins:
//
//   1. 🔴 THE AUTH POSTURE IS THREE INDEPENDENT THINGS, and no two of them are
//      the same claim. The SESSION says who this is; the SIGNATURE says the
//      flow started at ../start and names the location/mailbox it started for;
//      the COOKIE says this is the browser that started it. The signature is
//      what survives a dropped cookie, the cookie is what survives a leaked
//      signing key, and the session is what makes the route legible to
//      `check:route-guards` rather than an EXEMPT entry. Each is tested ALONE,
//      with the other two satisfied.
//   2. 🔴 NO TOKEN REACHES A REDIRECT URL, AN AUDIT ROW OR A LOG LINE. These
//      land in browser history and in a table read by more people, for longer,
//      than anything else this feature touches.
//   3. VERIFY BEFORE PERSIST. A token that opens nothing is refused while the
//      operator is still looking at the screen.
//   4. SMTP IS VERIFIED AND ITS FAILURE IS NOT FATAL — receive-over-IMAP while
//      replying through Postmark is a supported state, and there is no field
//      for the operator to clear here.
//   5. A VERIFIED SIGN-IN RESUMES POLLING, and drops the cursor only when the
//      ACCOUNT changed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
// A NextRequest, not a bare Request: the route reads `request.cookies`, which
// is Next's own parsed-cookie accessor and does not exist on the platform
// Request. A plain Request here would throw before a single assertion ran.
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
// Both would open real sockets.
vi.mock('@/lib/mail/imap-connection', () => ({ verifyConnection: vi.fn() }))
vi.mock('@/lib/mail/smtp-send', () => ({ verifySmtpConnection: vi.fn() }))
// The token endpoint. Driven directly rather than through fetch, so the
// classification lives in its own file's tests and this one is about the route.
vi.mock('@/lib/mail/oauth-tokens', async () => {
  const actual = await vi.importActual('@/lib/mail/oauth-tokens')
  return { ...actual, exchangeCodeForTokens: vi.fn() }
})
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { GET } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { verifyConnection } from '@/lib/mail/imap-connection'
import { verifySmtpConnection } from '@/lib/mail/smtp-send'
import { exchangeCodeForTokens } from '@/lib/mail/oauth-tokens'
import { logAuditEvent } from '@/lib/audit'
import { logError, logWarn } from '@/lib/log'
import { open as openSealed } from '@/lib/mail/secret-box'
import { signState, STATE_COOKIE } from '@/lib/mail/oauth-providers'
import { makeDb, writesTo, updatesTo, insertsInto } from '@/app/api/email/tickets/_test-db'
import {
  LOC_A, MB_STUDIO, MB_ACCOUNTS, MB_OTHER_LOCATION,
  OWNER_A, OWNER_B, MANAGER_A, MASTER, adminState,
} from '@/app/api/locations/[id]/email/mailboxes/_test-fixtures'

const TEST_KEY = Buffer.alloc(32, 17).toString('base64')
const CRON_SECRET = 'a-test-cron-secret'

const ACCESS = 'ACCESS-TOKEN-cc41f0'
const REFRESH = 'REFRESH-TOKEN-90ab77'
const CODE = 'the-consent-code-from-microsoft'

const onPostmark = (m) => ({ ...m, ingress: 'postmark', egress: 'postmark' })

// ── The fake DB, extended for this feature's two tables ─────────────────────
// Same shape as the connection route's test, for the same reason: neither
// table is in the shared fake's map, so reads would silently fall through to
// an empty set and every "already connected" assertion would pass wrongly.
const NEW_TABLES = {
  email_mailbox_credentials: 'credentials',
  email_mailbox_ingress: 'ingressRows',
}

function extendDb(db, { credentials = [], ingressRows = [] } = {}) {
  db._state.credentials = credentials
  db._state.ingressRows = ingressRows
  const realFrom = db.from

  db.from = (table) => {
    const key = NEW_TABLES[table]
    if (!key) return realFrom(table)

    const b = { _filters: [], _op: 'select', _payload: null, _select: '*' }
    const hits = () => db._state[key].filter(
      r => b._filters.every(([col, value]) => (r[col] ?? null) === value)
    )
    const settle = (shape) => {
      const injected = db._state.errors?.[table]
      if (injected) return { data: null, error: injected }
      if (b._op === 'insert') {
        db.inserts.push({ table, payload: b._payload })
        const row = { ...b._payload }
        db._state[key].push(row)
        return { data: row, error: null }
      }
      if (b._op === 'update') {
        db.updates.push({ table, payload: b._payload, filters: b._filters })
        for (const r of hits()) Object.assign(r, b._payload)
        return shape === 'list' ? { data: hits(), error: null } : { data: hits()[0] ?? null, error: null }
      }
      db.selects.push({ table, columns: b._select })
      const rows = hits()
      return shape === 'list' ? { data: rows, error: null } : { data: rows[0] ?? null, error: null }
    }
    b.select = (columns) => { b._select = columns ?? '*'; return b }
    b.insert = (p) => { b._op = 'insert'; b._payload = p; return b }
    b.update = (p) => { b._op = 'update'; b._payload = p; return b }
    b.eq = (col, value) => { b._filters.push([col, value]); return b }
    b.single = () => Promise.resolve(settle('single'))
    b.maybeSingle = () => Promise.resolve(settle('single'))
    b.then = (res, rej) => Promise.resolve(settle('list')).then(res, rej)
    return b
  }
  return db
}

let db
function world(extra = {}, tables = {}) {
  db = extendDb(makeDb(adminState({
    mailboxes: [onPostmark(MB_STUDIO), onPostmark(MB_ACCOUNTS), onPostmark(MB_OTHER_LOCATION)],
    ...extra,
  })), {
    ingressRows: [{ mailbox_id: MB_STUDIO.id, folder: 'inbox', consecutive_failures: 4, paused_until: '2026-08-28T09:00:00Z', last_error: 'Invalid credentials', uidvalidity: 12345, last_uid: 900 }],
    ...tables,
  })
  createServerClient.mockImplementation(() => db)
  return db
}

/** A well-formed state for the standard flow. */
function goodState(overrides = {}) {
  return signState({
    nonce: 'nonce-1', locationId: LOC_A, mailboxId: MB_STUDIO.id,
    provider: 'microsoft', profileId: OWNER_A.id, ts: Date.now(), ...overrides,
  }, CRON_SECRET)
}

/**
 * Drive the callback. By default everything agrees — a real state, the same
 * value in the cookie, and a code. Each test breaks exactly one thing.
 */
async function callback({ state, cookie, code = CODE, error = null } = {}) {
  const s = state === undefined ? goodState() : state
  const params = new URLSearchParams()
  if (code) params.set('code', code)
  if (s) params.set('state', s)
  if (error) params.set('error', error)
  const cookieValue = cookie === undefined ? s : cookie
  const headers = {}
  if (cookieValue) headers.cookie = `${STATE_COOKIE}=${cookieValue}`
  const res = await GET(new NextRequest(`https://crm.repset.ie/api/email/oauth/callback?${params}`, { headers }))
  return res
}

/** The Location header of a redirect, parsed. */
const dest = (res) => new URL(res.headers.get('location'))
const errorParam = (res) => dest(res).searchParams.get('email_oauth_error')
const okParam = (res) => dest(res).searchParams.get('email_oauth_connected')

const credentialFor = (id) => db._state.credentials.find(c => c.mailbox_id === id) || null
const mailboxRow = (id) => db._state.mailboxes.find(m => m.id === id)
const ingressFor = (id) => db._state.ingressRows.find(r => r.mailbox_id === id) || null

/** Everything that reached a logger this test. */
const loggedText = () => JSON.stringify([...logError.mock.calls, ...logWarn.mock.calls])

beforeEach(() => {
  vi.clearAllMocks()
  process.env.MAILBOX_SECRET_KEY = TEST_KEY
  process.env.CRON_SECRET = CRON_SECRET
  process.env.NEXT_PUBLIC_APP_URL = 'https://crm.repset.ie'
  process.env.MAILBOX_OAUTH_MICROSOFT_CLIENT_ID = 'the-client-id'
  process.env.MAILBOX_OAUTH_MICROSOFT_CLIENT_SECRET = 'the-client-secret'
  getCurrentUser.mockResolvedValue(OWNER_A)
  verifyConnection.mockResolvedValue({ ok: true })
  verifySmtpConnection.mockResolvedValue({ ok: true })
  exchangeCodeForTokens.mockResolvedValue({
    ok: true,
    tokens: {
      accessToken: ACCESS, refreshToken: REFRESH,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), scope: 'IMAP SMTP',
    },
  })
  world()
})

afterEach(() => {
  delete process.env.MAILBOX_SECRET_KEY
  delete process.env.CRON_SECRET
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.MAILBOX_OAUTH_MICROSOFT_CLIENT_ID
  delete process.env.MAILBOX_OAUTH_MICROSOFT_CLIENT_SECRET
})

/* ══════════════════════════════════════════════════════════════════════════
   1. THE AUTH POSTURE — THREE THINGS, EACH TESTED ALONE
   ══════════════════════════════════════════════════════════════════════════ */

describe('🔴 the callback carries state, and is nevertheless guarded three ways', () => {
  // (1) THE SESSION. A callback IS an ordinary same-site top-level GET, so the
  // session cookie rides along under SameSite=Lax — which is why this route is
  // guarded the ordinary way rather than being an EXEMPT entry. But a browser
  // that lost its session mid-flow is a real state, not an attack.
  it('sends an unauthenticated browser to sign in, and writes nothing', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await callback()
    expect(dest(res).pathname).toBe('/login')
    expect(writesTo(db)).toEqual([])
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
  })

  // 🔴 A signature proves where a flow STARTED. It never proves the person
  // finishing it is still permitted — an owner demoted between the redirect
  // and the callback must be refused here.
  it('re-runs the elevation gate against the location the STATE names', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const res = await callback()
    expect(res.status).toBe(403)
    expect(writesTo(db)).toEqual([])
  })

  // The attack: a signed-in owner of ANOTHER studio replaying a state that
  // names this one. The signature verifies; the gate must still refuse.
  it('refuses an owner of a different studio holding a perfectly valid state', async () => {
    getCurrentUser.mockResolvedValue(OWNER_B)
    const res = await callback()
    expect(res.status).toBe(403)
    expect(credentialFor(MB_STUDIO.id)).toBeNull()
  })

  // (2) THE SIGNATURE. Without it the location and mailbox would be read from
  // a query parameter the caller controls — the whole point of signing.
  it('refuses a state signed with a different key', async () => {
    const res = await callback({ state: signState({
      locationId: LOC_A, mailboxId: MB_STUDIO.id, provider: 'microsoft',
      profileId: OWNER_A.id, ts: Date.now(),
    }, 'not-the-signing-secret') })
    expect(errorParam(res)).toMatch(/expired or did not come from this browser/i)
    expect(writesTo(db)).toEqual([])
  })

  it('refuses a state whose payload was rewritten to name another mailbox', async () => {
    const signed = goodState()
    const [raw, sig] = signed.split('.')
    const payload = JSON.parse(Buffer.from(raw, 'base64url').toString())
    payload.mailboxId = MB_ACCOUNTS.id
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`
    const res = await callback({ state: forged, cookie: forged })
    expect(errorParam(res)).toBeTruthy()
    expect(credentialFor(MB_ACCOUNTS.id)).toBeNull()
  })

  it('refuses an expired state', async () => {
    const stale = signState({
      nonce: 'n', locationId: LOC_A, mailboxId: MB_STUDIO.id, provider: 'microsoft',
      profileId: OWNER_A.id, ts: Date.now() - 60 * 60_000,
    }, CRON_SECRET)
    const res = await callback({ state: stale, cookie: stale })
    expect(errorParam(res)).toBeTruthy()
    expect(writesTo(db)).toEqual([])
  })

  it('refuses a missing state outright', async () => {
    const res = await callback({ state: null, cookie: null })
    expect(errorParam(res)).toBeTruthy()
  })

  // (3) THE COOKIE. Redundant with the signature BY DESIGN: the signature
  // fails if the signing key leaks, the cookie fails if the browser is not the
  // one that started the flow. Neither is a superset of the other.
  it('refuses a valid, correctly-signed state with NO cookie', async () => {
    const res = await callback({ cookie: null })
    expect(errorParam(res)).toMatch(/did not come from this browser/i)
    expect(writesTo(db)).toEqual([])
  })

  it('refuses when the cookie holds a DIFFERENT flow’s state', async () => {
    const other = goodState({ nonce: 'a-different-flow' })
    const res = await callback({ cookie: other })
    expect(errorParam(res)).toBeTruthy()
    expect(writesTo(db)).toEqual([])
  })

  // Both people are elevated here, so this is not an escalation — but binding
  // a mailbox on the second person's authority while the audit row names them
  // for a decision the first one made is a state worth refusing.
  it('refuses a flow finished by a different signed-in user than started it', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await callback()
    expect(errorParam(res)).toMatch(/started by a different person/i)
    expect(writesTo(db)).toEqual([])
  })

  it('refuses when the deployment lost its signing secret', async () => {
    delete process.env.CRON_SECRET
    const res = await callback()
    expect(errorParam(res)).toBeTruthy()
    expect(writesTo(db)).toEqual([])
  })

  // When the state never verified there is no trustworthy location id, so it
  // must NOT be read out of the unverified payload — the same mistake as
  // trusting an unverified `return_to`.
  it('lands on /settings, never on a location read out of an unverified state', async () => {
    const res = await callback({ state: 'garbage.signature', cookie: 'garbage.signature' })
    expect(dest(res).pathname).toBe('/settings')
    expect(dest(res).pathname).not.toContain(LOC_A)
  })

  it('clears the flow cookie on EVERY exit, so a spent state cannot be replayed', async () => {
    const cases = [
      () => callback(),
      () => callback({ cookie: null }),
      () => callback({ error: 'access_denied' }),
      async () => { getCurrentUser.mockResolvedValue(null); return callback() },
    ]
    for (const run of cases) {
      vi.clearAllMocks()
      getCurrentUser.mockResolvedValue(OWNER_A)
      verifyConnection.mockResolvedValue({ ok: true })
      verifySmtpConnection.mockResolvedValue({ ok: true })
      exchangeCodeForTokens.mockResolvedValue({
        ok: true,
        tokens: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
      })
      world()
      const res = await run()
      const setCookies = res.headers.getSetCookie?.() || []
      expect(setCookies.some(c => c.startsWith(`${STATE_COOKIE}=`) && /Max-Age=0/.test(c))).toBe(true)
    }
  })

  // 404 as JSON would be an odd thing for a browser navigation to land on, and
  // "deleted" and "belongs to another studio" must read the same.
  it('answers a mailbox that no longer exists with a redirect, not a JSON 404', async () => {
    const state = goodState({ mailboxId: '99999999-9999-4999-8999-999999999999' })
    const res = await callback({ state, cookie: state })
    expect(res.status).toBe(307)
    expect(errorParam(res)).toMatch(/no longer exists/i)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   2. CONSENT DECLINED, AND THE EXCHANGE
   ══════════════════════════════════════════════════════════════════════════ */

describe('what the provider said', () => {
  it('treats a declined consent as a person saying no, not as an error', async () => {
    const res = await callback({ error: 'access_denied', code: null })
    expect(errorParam(res)).toMatch(/declined/i)
    expect(logError).not.toHaveBeenCalled()
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
    expect(writesTo(db)).toEqual([])
  })

  it('treats a callback with no code as the same', async () => {
    const res = await callback({ code: null })
    expect(errorParam(res)).toMatch(/declined/i)
    expect(writesTo(db)).toEqual([])
  })

  it('rebuilds the redirect URI byte-identically to the one ../start sent', async () => {
    // The provider compares them, and a mismatch surfaces as `invalid_grant`,
    // which reads exactly like a revoked consent.
    await callback()
    expect(exchangeCodeForTokens).toHaveBeenCalledWith(expect.objectContaining({
      code: CODE, redirectUri: 'https://crm.repset.ie/api/email/oauth/callback',
    }))
  })

  it('carries an exchange refusal’s own sentence, and stores nothing', async () => {
    exchangeCodeForTokens.mockResolvedValue({
      ok: false, reason: 'oauth_revoked', error: 'This mailbox’s sign-in has been withdrawn.',
    })
    const res = await callback()
    expect(errorParam(res)).toBe('This mailbox’s sign-in has been withdrawn.')
    expect(credentialFor(MB_STUDIO.id)).toBeNull()
    expect(verifyConnection).not.toHaveBeenCalled()
  })

  it('re-resolves the provider rather than trusting the state’s copy', async () => {
    // A deployment that lost its env var between the redirect and the callback
    // must not proceed on a stale one.
    delete process.env.MAILBOX_OAUTH_MICROSOFT_CLIENT_ID
    const res = await callback()
    expect(errorParam(res)).toMatch(/MAILBOX_OAUTH_MICROSOFT_CLIENT_ID/)
    expect(exchangeCodeForTokens).not.toHaveBeenCalled()
  })

  it('refuses if the encryption key vanished between the two requests', async () => {
    delete process.env.MAILBOX_SECRET_KEY
    const res = await callback()
    expect(errorParam(res)).toMatch(/encryption key is not configured/i)
    expect(writesTo(db)).toEqual([])
  })

  it('refuses a deactivated account', async () => {
    world({ mailboxes: [onPostmark({ ...MB_STUDIO, active: false }), onPostmark(MB_ACCOUNTS)] })
    const res = await callback()
    expect(errorParam(res)).toMatch(/deactivated/i)
    expect(writesTo(db)).toEqual([])
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   3. VERIFY BEFORE PERSIST
   ══════════════════════════════════════════════════════════════════════════ */

describe('🔴 verify before persist — the identity that came back is proven, not trusted', () => {
  // A consent screen lets the operator sign in as ANY account, and nothing in
  // the token says which mailbox it opens.
  it('dials IMAP with the freshly-minted token before writing anything', async () => {
    await callback()
    expect(verifyConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'outlook.office365.com', port: 993, secure: true,
        auth: { user: MB_STUDIO.address, accessToken: ACCESS },
      }),
      'INBOX'
    )
  })

  // 🔴 The auth object is built by resolveAuth from a SYNTHETIC row, so the
  // thing verified is byte-identical to what the poller will later resolve —
  // and a broken seal/open round trip fails HERE, in front of a person, not on
  // a cron at 3am.
  it('proves the seal/open round trip works on this deployment, in front of the operator', async () => {
    await callback()
    const auth = verifyConnection.mock.calls[0][0].auth
    // An `accessToken`, never a `pass` — an OAuth token handed to an IMAP
    // LOGIN command would be the credential in the clear.
    expect(auth.accessToken).toBe(ACCESS)
    expect(auth.pass).toBeUndefined()
  })

  it('stores NOTHING when the token opens no mailbox', async () => {
    verifyConnection.mockResolvedValue({ ok: false, error: 'AUTHENTICATIONFAILED' })
    const res = await callback()
    expect(credentialFor(MB_STUDIO.id)).toBeNull()
    expect(mailboxRow(MB_STUDIO.id).ingress).toBe('postmark')
    expect(writesTo(db)).toEqual([])
    expect(errorParam(res)).toMatch(/could not be opened with it/i)
  })

  // The remote end's own bytes are LOGGED, never returned — a mail server's
  // multi-kilobyte reply has no business in a URL an operator can screenshot.
  it('does not put the mail server’s own error text in the redirect', async () => {
    verifyConnection.mockResolvedValue({ ok: false, error: 'A1 NO [AUTHENTICATIONFAILED] tenant blob 0x8004789A' })
    const res = await callback()
    expect(errorParam(res)).not.toContain('0x8004789A')
    expect(loggedText()).toContain('0x8004789A')
  })

  it('tells the operator the administrator may need to switch IMAP on', async () => {
    verifyConnection.mockResolvedValue({ ok: false, error: 'refused' })
    expect(errorParam(await callback())).toMatch(/administrator/i)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   4. SMTP IS VERIFIED, AND ITS FAILURE IS NOT FATAL
   ══════════════════════════════════════════════════════════════════════════ */

describe('🔴 SMTP is checked, and a refusal costs the send leg, not the connection', () => {
  it('verifies SMTP on 587 with STARTTLS, using the same token', async () => {
    await callback()
    expect(verifySmtpConnection).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.office365.com', port: 587, secure: false,
      auth: { user: MB_STUDIO.address, accessToken: ACCESS },
    }))
  })

  it('sets egress smtp and says replies will leave from this address', async () => {
    const res = await callback()
    expect(mailboxRow(MB_STUDIO.id).egress).toBe('smtp')
    expect(credentialFor(MB_STUDIO.id).smtp_host).toBe('smtp.office365.com')
    expect(okParam(res)).toMatch(/replies will leave from this address/i)
  })

  // Refusing the whole connection because a tenant's admin left SMTP AUTH off
  // would cost the operator the receiving half they came for — and unlike the
  // password route there is no field here for them to clear.
  it('still connects for RECEIVING when SMTP is refused', async () => {
    verifySmtpConnection.mockResolvedValue({ ok: false, error: 'SMTP AUTH disabled' })
    const res = await callback()
    expect(mailboxRow(MB_STUDIO.id).ingress).toBe('imap')
    expect(credentialFor(MB_STUDIO.id)).toBeTruthy()
    expect(okParam(res)).toMatch(/connected for receiving/i)
  })

  it('leaves egress on postmark and stores no SMTP host when SMTP is refused', async () => {
    // `egress` follows what was actually PROVEN, exactly as it follows the
    // outgoing-server field on the password path.
    verifySmtpConnection.mockResolvedValue({ ok: false, error: 'SMTP AUTH disabled' })
    await callback()
    expect(mailboxRow(MB_STUDIO.id).egress).toBe('postmark')
    expect(credentialFor(MB_STUDIO.id).smtp_host).toBeNull()
    expect(credentialFor(MB_STUDIO.id).smtp_port).toBeNull()
  })

  it('explains WHY sending is off rather than just saying it is', async () => {
    verifySmtpConnection.mockResolvedValue({ ok: false, error: 'nope' })
    expect(okParam(await callback())).toMatch(/SMTP.*authentication turned off|administrator/i)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   5. WHAT GETS WRITTEN
   ══════════════════════════════════════════════════════════════════════════ */

describe('the write', () => {
  it('inserts a sealed credential with the provider’s own server settings', async () => {
    await callback()
    const cred = credentialFor(MB_STUDIO.id)
    expect(cred).toMatchObject({
      mailbox_id: MB_STUDIO.id,
      provider: 'microsoft',
      auth_type: 'oauth',
      username: MB_STUDIO.address,
      imap_host: 'outlook.office365.com',
      imap_port: 993,
      imap_secure: true,
      sent_folder: 'Sent Items',
      created_by: OWNER_A.id,
    })
  })

  it('stores CIPHERTEXT, and the ciphertext really opens to the tokens', async () => {
    await callback()
    const cred = credentialFor(MB_STUDIO.id)
    expect(cred.oauth_access_token_ciphertext).not.toContain(ACCESS)
    expect(cred.oauth_refresh_token_ciphertext).not.toContain(REFRESH)
    expect(openSealed(cred.oauth_access_token_ciphertext)).toBe(ACCESS)
    expect(openSealed(cred.oauth_refresh_token_ciphertext)).toBe(REFRESH)
  })

  // 🔴 A stale app password behind an OAuth connection is a live credential
  // nothing reads, nothing rotates and no screen mentions.
  it('clears any password that was there before', async () => {
    world({}, { credentials: [{
      mailbox_id: MB_STUDIO.id, provider: 'gmail', auth_type: 'password',
      username: 'old@un1tdublin.com', secret_ciphertext: 'v1:x:y:z',
      imap_host: 'imap.gmail.com', created_at: '2026-08-01T00:00:00Z',
    }] })
    await callback()
    expect(credentialFor(MB_STUDIO.id).secret_ciphertext).toBeNull()
    expect(credentialFor(MB_STUDIO.id).auth_type).toBe('oauth')
  })

  // CREDENTIAL FIRST, THEN THE ingress FLIP — with the flip first, a failed
  // credential write leaves the poller told to read a mailbox it has no login
  // for.
  it('writes the credential BEFORE flipping ingress', async () => {
    await callback()
    const order = writesTo(db).map(w => w.table)
    expect(order.indexOf('email_mailbox_credentials')).toBeLessThan(order.indexOf('email_mailboxes'))
  })

  it('refuses before anything is written when the current connection cannot be read', async () => {
    // That read decides whether this is a first connect and whether the cursor
    // must drop, so proceeding on an unreadable answer would guess at both.
    db._state.errors = { email_mailbox_credentials: { code: '42501', message: 'denied' } }
    const res = await callback()
    expect(mailboxRow(MB_STUDIO.id).ingress).toBe('postmark')
    expect(errorParam(res)).toMatch(/Could not read this account/i)
  })

  it('does not flip ingress when the credential WRITE fails', async () => {
    // Only the insert is broken — the read before it must still answer, or
    // this would prove the read guard instead.
    const original = db.from.bind(db)
    db.from = (table) => {
      const b = original(table)
      if (table !== 'email_mailbox_credentials') return b
      const realInsert = b.insert.bind(b)
      b.insert = (p) => {
        const chained = realInsert(p)
        chained.then = (res) => Promise.resolve({ data: null, error: { code: '23505', message: 'conflict' } }).then(res)
        return chained
      }
      return b
    }
    const res = await callback()
    expect(mailboxRow(MB_STUDIO.id).ingress).toBe('postmark')
    expect(errorParam(res)).toMatch(/Could not save/i)
    // And the audit row is NOT written for a credential that never landed.
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  // 🔴 A verified sign-in must actually RESUME polling: the auth backoff curve
  // parks a repeatedly-failing mailbox up to 24 hours out, and a revoked grant
  // is exactly what puts it there. Storing a working token while `paused_until`
  // sits a day in the future is a fix the operator cannot see for a day.
  it('clears the failure state and the pause', async () => {
    await callback()
    const ingress = ingressFor(MB_STUDIO.id)
    expect(ingress.consecutive_failures).toBe(0)
    expect(ingress.paused_until).toBeNull()
    // A stale reason beside a fresh success is the contradiction that makes an
    // operator distrust the panel.
    expect(ingress.last_error).toBeNull()
  })

  // A watermark belongs to ONE account; keeping it across a change of login
  // silently skips every message at or below it.
  it('drops the cursor when the account identity changed', async () => {
    // From a Gmail app password to a Microsoft sign-in: same address, a
    // genuinely different account being read.
    world({}, { credentials: [{
      mailbox_id: MB_STUDIO.id, provider: 'gmail', auth_type: 'password',
      username: MB_STUDIO.address, secret_ciphertext: 'v1:x:y:z',
      imap_host: 'imap.gmail.com', created_at: '2026-08-01T00:00:00Z',
    }] })
    await callback()
    expect(ingressFor(MB_STUDIO.id).uidvalidity).toBeNull()
    expect(ingressFor(MB_STUDIO.id).last_uid).toBeNull()
  })

  it('KEEPS the cursor when the same account simply signs in again', async () => {
    // Re-consent after a revoked grant. Dropping the watermark here would
    // re-ingest nothing but would lose the poller's place.
    world({}, { credentials: [{
      mailbox_id: MB_STUDIO.id, provider: 'microsoft', auth_type: 'oauth',
      username: MB_STUDIO.address, imap_host: 'outlook.office365.com',
      created_at: '2026-08-01T00:00:00Z',
    }] })
    await callback()
    expect(ingressFor(MB_STUDIO.id).uidvalidity).toBe(12345)
    expect(ingressFor(MB_STUDIO.id).last_uid).toBe(900)
  })

  it('updates rather than inserts when a credential row already exists', async () => {
    world({}, { credentials: [{
      mailbox_id: MB_STUDIO.id, provider: 'microsoft', auth_type: 'oauth',
      username: MB_STUDIO.address, imap_host: 'outlook.office365.com',
      created_at: '2026-08-01T00:00:00Z',
    }] })
    await callback()
    expect(insertsInto(db, 'email_mailbox_credentials')).toEqual([])
    expect(updatesTo(db, 'email_mailbox_credentials')).toHaveLength(1)
  })

  it('does not claim "nothing happened" when only the ingress flip failed', async () => {
    // The sign-in IS stored and IS verified; telling the operator "could not
    // save" would send them round the consent loop again for a credential they
    // already banked.
    const original = db.from.bind(db)
    db.from = (table) => {
      const b = original(table)
      if (table !== 'email_mailboxes') return b
      const realUpdate = b.update?.bind(b)
      if (realUpdate) {
        b.update = (p) => {
          const chained = realUpdate(p)
          chained.then = (res) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(res)
          return chained
        }
      }
      return b
    }
    const res = await callback()
    expect(errorParam(res)).toMatch(/saved and checked/i)
    expect(errorParam(res)).not.toMatch(/Nothing has been changed/i)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
   6. THE AUDIT ROW, AND THE LEAK SURFACE
   ══════════════════════════════════════════════════════════════════════════ */

describe('the audit row', () => {
  it('records a first connect under its own action', async () => {
    await callback()
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'email_mailbox_connection.connected',
      locationId: LOC_A,
    }))
  })

  it('records a re-sign-in as a credential change, not a fresh connect', async () => {
    world({}, { credentials: [{
      mailbox_id: MB_STUDIO.id, provider: 'microsoft', auth_type: 'oauth',
      username: MB_STUDIO.address, imap_host: 'outlook.office365.com',
      created_at: '2026-08-01T00:00:00Z',
    }] })
    await callback()
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'email_mailbox_connection.credential_changed',
    }))
  })

  // Audited the moment the credential is on disk, not at the end — an audit
  // log that records only the fully-successful path is not an audit log for
  // the cases anyone opens it for.
  it('audits even when a LATER step fails', async () => {
    const original = db.from.bind(db)
    db.from = (table) => {
      const b = original(table)
      if (table !== 'email_mailboxes') return b
      const realUpdate = b.update?.bind(b)
      if (realUpdate) {
        b.update = (p) => {
          const chained = realUpdate(p)
          chained.then = (res) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(res)
          return chained
        }
      }
      return b
    }
    await callback()
    expect(logAuditEvent).toHaveBeenCalled()
  })

  it('names the address, the provider and what was proven — and no token', async () => {
    await callback()
    const details = logAuditEvent.mock.calls[0][0].details
    expect(details).toMatchObject({
      address: MB_STUDIO.address, provider: 'microsoft', auth_type: 'oauth',
      verified: true, smtp_verified: true,
    })
    expect(JSON.stringify(details)).not.toContain(ACCESS)
    expect(JSON.stringify(details)).not.toContain(REFRESH)
  })
})

describe('🔴 no token reaches a URL, an audit row or a log line', () => {
  const everything = (res) => JSON.stringify({
    location: res.headers.get('location'),
    cookies: res.headers.getSetCookie?.() || [],
    audit: logAuditEvent.mock.calls,
    logs: [...logError.mock.calls, ...logWarn.mock.calls],
  })

  it('not on the happy path', async () => {
    const res = await callback()
    const all = everything(res)
    expect(all).not.toContain(ACCESS)
    expect(all).not.toContain(REFRESH)
    // Nor the consent code, which is a one-time credential in its own right.
    expect(all).not.toContain(CODE)
  })

  it('not when IMAP refuses the token', async () => {
    verifyConnection.mockResolvedValue({ ok: false, error: 'AUTHENTICATIONFAILED' })
    const all = everything(await callback())
    expect(all).not.toContain(ACCESS)
    expect(all).not.toContain(REFRESH)
  })

  it('not when the credential store is unreadable', async () => {
    db._state.errors = { email_mailbox_credentials: { code: '42501', message: 'denied' } }
    const all = everything(await callback())
    expect(all).not.toContain(ACCESS)
    expect(all).not.toContain(REFRESH)
  })

  it('never puts the client secret or the encryption key anywhere', async () => {
    const all = everything(await callback())
    expect(all).not.toContain('the-client-secret')
    expect(all).not.toContain(TEST_KEY)
    expect(all).not.toContain(CRON_SECRET)
  })

  // The success redirect carries the mailbox id so the right panel opens — a
  // mailbox id in a URL is fine (the page behind it is already gated, and the
  // id was proven to belong to this location before this point).
  it('carries only the mailbox id and a sentence back to the settings page', async () => {
    const res = await callback()
    const u = dest(res)
    expect(u.pathname).toBe(`/settings/locations/${LOC_A}`)
    expect(u.searchParams.get('section')).toBe('email')
    expect(u.searchParams.get('email_oauth_mailbox')).toBe(MB_STUDIO.id)
    expect([...u.searchParams.keys()].sort())
      .toEqual(['email_oauth_connected', 'email_oauth_mailbox', 'section'])
  })
})

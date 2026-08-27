// MAILBOX-OAUTH.3 — starting a mailbox sign-in.
//
// A GET that writes nothing and is still one of the more dangerous routes in
// this feature, because what it HANDS OUT is a signed capability naming a
// location and a mailbox — and the callback trusts that value. Five properties:
//
//   1. THE GATE IS THE PASSWORD ROUTE'S GATE. A manager holds `email_inbox`
//      and is not elevated; if this were gated on the surface permission one
//      of them could bind a Microsoft account to `accounts@` and take the
//      studio's billing correspondence. Every refusal also asserts that no
//      state was minted — a route that 403s and signs anyway is the same hole.
//   2. GOOGLE IS REFUSED HERE, WITH THE REASON, BEFORE ANY WORK.
//   3. EVERY REFUSABLE THING IS REFUSED BEFORE THE REDIRECT. A refusal after
//      consent leaves a live grant at the provider that nothing on our side
//      refers to, and an operator who has already handed a third party access
//      to their mail being told it did not work.
//   4. THE STATE IS SIGNED, SCOPED AND MIRRORED INTO AN httpOnly COOKIE.
//   5. NO SECRET REACHES THE REDIRECT. The client id is public by
//      construction; the client secret is not, and this URL ends up in browser
//      history and in Microsoft's logs.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { GET } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { makeDb, writesTo } from '@/app/api/email/tickets/_test-db'
import {
  LOC_A, MB_STUDIO, MB_ACCOUNTS, MB_OTHER_LOCATION,
  OWNER_A, OWNER_B, MANAGER_A, MASTER, adminState,
} from '../../../_test-fixtures'
import { MAX_CONNECTED_MAILBOXES_PER_LOCATION } from '../../../_helpers'
import { verifyState, STATE_COOKIE, STATE_TTL_MS } from '@/lib/mail/oauth-providers'

const TEST_KEY = Buffer.alloc(32, 13).toString('base64')
const CRON_SECRET = 'a-test-cron-secret'
const CLIENT_SECRET = 'the-microsoft-client-secret'

const onPostmark = (m) => ({ ...m, ingress: 'postmark', egress: 'postmark' })

let db
function world(extra = {}) {
  db = makeDb(adminState({
    mailboxes: [onPostmark(MB_STUDIO), onPostmark(MB_ACCOUNTS), onPostmark(MB_OTHER_LOCATION)],
    ...extra,
  }))
  createServerClient.mockImplementation(() => db)
  return db
}

const propsFor = (mailboxId) => ({ params: { id: LOC_A, mailboxId } })

const req = (provider = 'microsoft') => new Request(
  `http://x/api/locations/${LOC_A}/email/mailboxes/m/oauth/start${provider === null ? '' : `?provider=${encodeURIComponent(provider)}`}`
)

/** Run the route. JSON refusals are parsed; redirects are left as responses. */
async function start(mailboxId = MB_STUDIO.id, provider = 'microsoft') {
  const res = await GET(req(provider), propsFor(mailboxId))
  const isRedirect = res.status >= 300 && res.status < 400
  return { res, body: isRedirect ? null : await res.json() }
}

/** The Location header, parsed. */
const location = (res) => new URL(res.headers.get('location'))

/** The state cookie the response sets, if any. */
function stateCookie(res) {
  const raw = res.headers.getSetCookie?.() || []
  const line = raw.find(c => c.startsWith(`${STATE_COOKIE}=`))
  return line || null
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.MAILBOX_SECRET_KEY = TEST_KEY
  process.env.CRON_SECRET = CRON_SECRET
  process.env.NEXT_PUBLIC_APP_URL = 'https://crm.repset.ie'
  process.env.MAILBOX_OAUTH_MICROSOFT_CLIENT_ID = 'the-client-id'
  process.env.MAILBOX_OAUTH_MICROSOFT_CLIENT_SECRET = CLIENT_SECRET
  getCurrentUser.mockResolvedValue(OWNER_A)
  world()
})

afterEach(() => {
  delete process.env.MAILBOX_SECRET_KEY
  delete process.env.CRON_SECRET
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.MAILBOX_OAUTH_MICROSOFT_CLIENT_ID
  delete process.env.MAILBOX_OAUTH_MICROSOFT_CLIENT_SECRET
})

describe('the gate — master or owner at THIS studio, nothing less', () => {
  it('401s when unauthenticated, and mints no state', async () => {
    getCurrentUser.mockResolvedValue(null)
    const { res } = await start()
    expect(res.status).toBe(401)
    expect(stateCookie(res)).toBeNull()
    expect(writesTo(db)).toEqual([])
  })

  // 🔴 The hole this closes: a manager binding a Microsoft account to
  // `accounts@` and, in doing so, handing themselves the studio's billing
  // correspondence. They hold `email_inbox`; they are not elevated.
  it('REFUSES a manager who holds email_inbox but is not elevated', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const { res, body } = await start()
    expect(res.status).toBe(403)
    expect(body.error).toMatch(/owner of this studio/i)
    expect(stateCookie(res)).toBeNull()
  })

  it('refuses an owner of a different studio', async () => {
    getCurrentUser.mockResolvedValue(OWNER_B)
    const { res } = await start()
    expect(res.status).toBe(403)
    expect(stateCookie(res)).toBeNull()
  })

  it('lets a master through', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await start()).res.status).toBe(307)
  })

  // 404 not 403, or another studio's mailbox ids become enumerable one refusal
  // at a time — and with them the set of addresses that studio runs.
  it('404s — not 403 — for a mailbox belonging to another studio', async () => {
    const { res } = await start(MB_OTHER_LOCATION.id)
    expect(res.status).toBe(404)
    expect(stateCookie(res)).toBeNull()
  })

  it('404s for an id that does not exist at all — the same answer', async () => {
    expect((await start('99999999-9999-4999-8999-999999999999')).res.status).toBe(404)
  })

  // The gate runs BEFORE the provider is even resolved, so a refused caller
  // cannot use this route to discover which providers a deployment can run.
  it('refuses a manager before telling them anything about providers', async () => {
    getCurrentUser.mockResolvedValue(MANAGER_A)
    const { body } = await start(MB_STUDIO.id, 'google')
    expect(body.error).not.toMatch(/CASA/)
  })
})

describe('🔴 Google is refused here, with the reason', () => {
  it('400s and names app verification and the CASA assessment', async () => {
    const { res, body } = await start(MB_STUDIO.id, 'google')
    expect(res.status).toBe(400)
    expect(body.code).toBe('provider_unavailable')
    expect(body.error).toMatch(/verification/i)
    expect(body.error).toMatch(/CASA/)
    expect(stateCookie(res)).toBeNull()
  })

  it('refuses even when a Google client id is present in the environment', async () => {
    // The blocker is a purchase decision, not an env var. Reporting
    // `not_configured` would send an operator to ask an engineer for something
    // that cannot help.
    process.env.MAILBOX_OAUTH_GOOGLE_CLIENT_ID = 'a-google-client-id'
    process.env.MAILBOX_OAUTH_GOOGLE_CLIENT_SECRET = 'a-google-secret'
    try {
      const { body } = await start(MB_STUDIO.id, 'google')
      expect(body.code).toBe('provider_unavailable')
    } finally {
      delete process.env.MAILBOX_OAUTH_GOOGLE_CLIENT_ID
      delete process.env.MAILBOX_OAUTH_GOOGLE_CLIENT_SECRET
    }
  })

  it('points at the app-password path, which works today', async () => {
    expect((await start(MB_STUDIO.id, 'google')).body.error).toMatch(/app password/i)
  })

  it('refuses an unknown provider as 400 `unknown_provider`', async () => {
    const { res, body } = await start(MB_STUDIO.id, 'yahoo')
    expect(res.status).toBe(400)
    expect(body.code).toBe('unknown_provider')
  })

  it('refuses a missing provider parameter', async () => {
    const { res } = await GET(req(null), propsFor(MB_STUDIO.id)).then(async r => ({ res: r }))
    expect(res.status).toBe(400)
  })

  // 503, not 400 — this one is OURS to fix and should page somebody, where
  // Google's never will be.
  it('503s when the deployment has no Microsoft client id', async () => {
    delete process.env.MAILBOX_OAUTH_MICROSOFT_CLIENT_ID
    const { res, body } = await start()
    expect(res.status).toBe(503)
    expect(body.code).toBe('not_configured')
    expect(body.error).toMatch(/MAILBOX_OAUTH_MICROSOFT_CLIENT_ID/)
  })

  it('never puts the client secret in a refusal', async () => {
    delete process.env.MAILBOX_OAUTH_MICROSOFT_CLIENT_ID
    const { body } = await start()
    expect(JSON.stringify(body)).not.toContain(CLIENT_SECRET)
  })
})

describe('🔴 everything refusable is refused BEFORE the operator meets the provider', () => {
  // A refusal after consent leaves a grant standing at the provider that
  // nothing on our side refers to, and an operator who has already handed a
  // third party access to their mail being told it did not work.

  it('refuses when the mailbox encryption key is absent — no token could be stored', async () => {
    delete process.env.MAILBOX_SECRET_KEY
    const { res, body } = await start()
    expect(res.status).toBe(503)
    expect(body.error).toMatch(/encryption key is not configured/i)
    expect(stateCookie(res)).toBeNull()
  })

  it('refuses when there is no signing secret — the callback could not verify anything', async () => {
    delete process.env.CRON_SECRET
    const { res, body } = await start()
    expect(res.status).toBe(503)
    expect(body.code).toBe('not_configured')
  })

  it('refuses when the app origin is unset rather than guessing a redirect URI', async () => {
    // A guessed origin is a redirect_uri the provider refuses, reported as a
    // consent failure the operator cannot act on.
    delete process.env.NEXT_PUBLIC_APP_URL
    const { res, body } = await start()
    expect(res.status).toBe(503)
    expect(body.code).toBe('not_configured')
  })

  it('refuses a deactivated account — its mail routes nowhere', async () => {
    world({ mailboxes: [onPostmark({ ...MB_STUDIO, active: false }), onPostmark(MB_ACCOUNTS)] })
    const { res, body } = await start()
    expect(res.status).toBe(400)
    expect(body.error).toMatch(/deactivated/i)
    expect(stateCookie(res)).toBeNull()
  })

  it('refuses at the connected-mailbox cap', async () => {
    const fillers = Array.from({ length: MAX_CONNECTED_MAILBOXES_PER_LOCATION }, (_, i) => ({
      ...MB_ACCOUNTS, id: `mb-filler-${i}`, address: `filler-${i}@un1tdublin.com`,
      ingress: 'imap', egress: 'postmark',
    }))
    world({ mailboxes: [onPostmark(MB_STUDIO), ...fillers] })
    const { res, body } = await start()
    expect(res.status).toBe(400)
    expect(body.code).toBe('connected_mailbox_limit')
    expect(body.error).toMatch(/Disconnect one/i)
  })

  // 🔴 THE TRAP. This route is also how a REVOKED grant is re-authorised. A cap
  // that blocks maintenance is worse than no cap: a studio at its limit whose
  // sign-in expires could never restore it.
  it('STILL LETS AN ALREADY-CONNECTED MAILBOX SIGN IN AGAIN AT THE CAP', async () => {
    const studio = { ...MB_STUDIO, ingress: 'imap', egress: 'smtp' }
    const fillers = Array.from({ length: MAX_CONNECTED_MAILBOXES_PER_LOCATION }, (_, i) => ({
      ...MB_ACCOUNTS, id: `mb-filler-${i}`, address: `filler-${i}@un1tdublin.com`,
      ingress: 'imap', egress: 'postmark',
    }))
    world({ mailboxes: [studio, ...fillers] })
    expect((await start()).res.status).toBe(307)
  })

  it('fails OPEN when the cap cannot be counted — AT a cap it would otherwise refuse', async () => {
    // The ceiling protects poll fairness, which is a nicety; refusing a
    // legitimate connection over a transient read is a real cost to a real
    // operator. Seeded genuinely at the cap so the assertion distinguishes
    // "failed open" from "was never near the limit".
    const fillers = Array.from({ length: MAX_CONNECTED_MAILBOXES_PER_LOCATION }, (_, i) => ({
      ...MB_ACCOUNTS, id: `mb-filler-${i}`, address: `filler-${i}@un1tdublin.com`,
      ingress: 'imap', egress: 'postmark',
    }))
    world({ mailboxes: [onPostmark(MB_STUDIO), ...fillers] })
    // Proven to refuse before the read is broken — otherwise this test could
    // pass on a world that was never at the cap at all.
    expect((await start()).res.status).toBe(400)

    const original = db.from.bind(db)
    db.from = (table) => {
      const b = original(table)
      if (table !== 'email_mailboxes') return b
      const realSelect = b.select.bind(b)
      b.select = (cols, opts) => {
        const chained = realSelect(cols, opts)
        // Only the count-only probe is broken; loadMailboxOr404's own read
        // must keep working, or this would test a 404 instead.
        if (opts?.count) {
          chained.then = (res) =>
            Promise.resolve({ data: null, count: null, error: { message: 'statement timeout' } }).then(res)
        }
        return chained
      }
      return b
    }
    expect((await start()).res.status).toBe(307)
  })
})

describe('the redirect, the state and the cookie', () => {
  it('302s to Microsoft with the consent parameters', async () => {
    const { res } = await start()
    const u = location(res)
    expect(u.origin).toBe('https://login.microsoftonline.com')
    expect(u.pathname).toBe('/common/oauth2/v2.0/authorize')
    expect(u.searchParams.get('client_id')).toBe('the-client-id')
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('prompt')).toBe('consent')
  })

  it('registers the ONE static redirect URI, with no tenant in the path', async () => {
    const u = location(await start().then(r => r.res))
    expect(u.searchParams.get('redirect_uri')).toBe('https://crm.repset.ie/api/email/oauth/callback')
  })

  it('pre-fills the account picker with the mailbox address', async () => {
    const u = location((await start()).res)
    expect(u.searchParams.get('login_hint')).toBe(MB_STUDIO.address)
  })

  // 🔴 THIS URL LANDS IN BROWSER HISTORY AND IN MICROSOFT'S LOGS.
  it('never carries the client secret or the encryption key', async () => {
    const u = location((await start()).res)
    expect(u.toString()).not.toContain(CLIENT_SECRET)
    expect(u.toString()).not.toContain(TEST_KEY)
    expect(u.toString()).not.toContain(CRON_SECRET)
  })

  it('signs a state naming this location, this mailbox, this provider and this person', async () => {
    const { res } = await start()
    const state = location(res).searchParams.get('state')
    const payload = verifyState(state, CRON_SECRET)
    expect(payload).toMatchObject({
      locationId: LOC_A,
      mailboxId: MB_STUDIO.id,
      provider: 'microsoft',
      profileId: OWNER_A.id,
    })
    expect(typeof payload.ts).toBe('number')
    expect(typeof payload.nonce).toBe('string')
  })

  // Without a signature the callback would trust a query parameter naming a
  // mailbox — a mint for capabilities against any id somebody could guess.
  it('produces a state that does NOT verify under a different key', async () => {
    const state = location((await start()).res).searchParams.get('state')
    expect(verifyState(state, 'some-other-secret')).toBeNull()
  })

  it('mirrors the state into an httpOnly, lax, path-wide cookie on the same clock', async () => {
    const { res } = await start()
    const cookie = stateCookie(res)
    const state = location(res).searchParams.get('state')
    expect(cookie).toContain(`${STATE_COOKIE}=${state}`)
    expect(cookie).toMatch(/HttpOnly/i)
    // lax, not strict: strict would drop the cookie on the provider's
    // top-level GET back and break every flow.
    expect(cookie).toMatch(/SameSite=lax/i)
    expect(cookie).toMatch(new RegExp(`Max-Age=${Math.floor(STATE_TTL_MS / 1000)}`))
    expect(cookie).toMatch(/Path=\//)
  })

  it('mints a DIFFERENT state on every start, so one flow cannot be replayed as another', async () => {
    const a = location((await start()).res).searchParams.get('state')
    const b = location((await start()).res).searchParams.get('state')
    expect(a).not.toBe(b)
    expect(verifyState(a, CRON_SECRET).nonce).not.toBe(verifyState(b, CRON_SECRET).nonce)
  })

  it('writes nothing at all — it is a redirect, not a mutation', async () => {
    await start()
    expect(writesTo(db)).toEqual([])
  })

  it('accepts a provider key in any case', async () => {
    expect((await start(MB_STUDIO.id, 'MICROSOFT')).res.status).toBe(307)
  })
})

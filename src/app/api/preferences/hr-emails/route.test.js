// HRPREF-AUTH.1 — the HR-email preference endpoint must authenticate.
//
// It used to take `?cid=<contact_id>` and nothing else, with its own header
// comment calling that an accepted trade-off. It is not: a contact id is an
// identifier, not a credential. Ids leak through URLs, CSV exports, log lines
// and support threads, and anyone holding one could read a stranger's HR
// preference state and switch it off.
//
// Two accepted credentials now:
//   • `?token=<contact_preferences.unsubscribe_token>` — the same per-contact
//     capability every sibling public preference endpoint uses. All new HR
//     emails carry this.
//   • `?cid=<contact_id>&sid=<heart_rate_session_id>` — the LEGACY pair, which
//     every already-delivered HR email carries. Accepted only when the session
//     resolves AND belongs to that contact, which is what turns it from a bare
//     identifier into a capability: knowing somebody's contact id tells you
//     nothing about their session ids.
//
// A bare `cid` with no `sid` is refused. That is the hole closing.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({
  peekRateLimit: vi.fn(async () => ({ allowed: true, remaining: 20, resetAt: new Date(), retryAfterSec: 60 })),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 60, resetAt: new Date(), retryAfterSec: 60 })),
  getClientIp: vi.fn(() => '203.0.113.7'),
}))

import { createServerClient } from '@/lib/supabase'
import { peekRateLimit, checkRateLimit } from '@/lib/rate-limit'
import { GET } from './route.js'

const TOKEN = '9f1c7c0e-0000-4000-8000-0000000000aa'
const CONTACT = 'c0000000-0000-4000-8000-00000000000c'
const OTHER_CONTACT = 'd0000000-0000-4000-8000-00000000000d'
const SESSION = '50000000-0000-4000-8000-000000000055'

// Chainable recorder. Records every write so a test can assert that a REFUSED
// request wrote nothing to contacts — the property that actually matters.
function makeDb({ pref = null, session = null, contact = null } = {}) {
  const writes = { contacts: [], unsubscribe_refusals: [] }

  const rowFor = (table, filters) => {
    if (table === 'contact_preferences') {
      return pref && filters.unsubscribe_token === pref.unsubscribe_token ? pref : null
    }
    if (table === 'heart_rate_sessions') {
      return session && filters.id === session.id ? session : null
    }
    if (table === 'contacts') {
      return contact && filters.id === contact.id ? contact : null
    }
    return null
  }

  const db = {
    from(table) {
      const state = { filters: {}, op: 'select' }
      const api = {
        select() { return api },
        eq(col, val) { state.filters[col] = val; return api },
        maybeSingle: async () => ({ data: rowFor(table, state.filters), error: null }),
        single: async () => {
          const row = rowFor(table, state.filters)
          return row ? { data: row, error: null } : { data: null, error: { message: 'not found' } }
        },
        update(patch) { state.op = 'update'; state.patch = patch; return api },
        insert(rows) {
          writes[table] = writes[table] || []
          writes[table].push(...[].concat(rows))
          return Promise.resolve({ error: null })
        },
        then(resolve, reject) {
          if (state.op === 'update') {
            writes[table] = writes[table] || []
            writes[table].push({ patch: state.patch, filters: state.filters })
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject)
        },
      }
      return api
    },
  }
  return { db, writes }
}

const call = (qs) => GET(new Request(`https://crm.example/api/preferences/hr-emails?${qs}`))

const optedIn = { id: CONTACT, email: 'sarah@test.com', hr_post_class_emails_enabled: true }
const prefRow = { id: 'pref-1', contact_id: CONTACT, unsubscribe_token: TOKEN }
const sessionRow = { id: SESSION, contact_id: CONTACT }

beforeEach(() => {
  vi.clearAllMocks()
  peekRateLimit.mockResolvedValue({ allowed: true, remaining: 20, resetAt: new Date(), retryAfterSec: 60 })
  checkRateLimit.mockResolvedValue({ allowed: true, remaining: 60, resetAt: new Date(), retryAfterSec: 60 })
})

// ── the hole ────────────────────────────────────────────────────────

describe('a bare contact id is no longer a credential', () => {
  it('refuses ?cid= on its own and writes nothing', async () => {
    const { db, writes } = makeDb({ pref: prefRow, session: sessionRow, contact: optedIn })
    createServerClient.mockReturnValue(db)

    const res = await call(`scope=hr&cid=${CONTACT}`)

    expect(res.status).toBe(404)
    expect(writes.contacts).toHaveLength(0)
  })

  it('records the refusal so a probe is visible, not silent', async () => {
    const { db, writes } = makeDb({ pref: prefRow, session: sessionRow, contact: optedIn })
    createServerClient.mockReturnValue(db)

    await call(`scope=hr&cid=${CONTACT}`)

    expect(writes.unsubscribe_refusals).toHaveLength(1)
    expect(writes.unsubscribe_refusals[0]).toMatchObject({
      endpoint: 'hr-emails',
      reason: 'invalid_token',
    })
    // Never the raw credential — only its fingerprint (mig 522).
    expect(JSON.stringify(writes.unsubscribe_refusals[0])).not.toContain(CONTACT)
  })

  it('refuses a cid paired with a session belonging to somebody else', async () => {
    const { db, writes } = makeDb({
      pref: prefRow,
      session: { id: SESSION, contact_id: OTHER_CONTACT },
      contact: optedIn,
    })
    createServerClient.mockReturnValue(db)

    const res = await call(`scope=hr&cid=${CONTACT}&sid=${SESSION}`)

    expect(res.status).toBe(404)
    expect(writes.contacts).toHaveLength(0)
  })
})

// ── the token path (what every new email carries) ────────────────────

describe('token path', () => {
  it('flips the flag off for the token holder', async () => {
    const { db, writes } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)

    const res = await call(`scope=hr&token=${TOKEN}`)

    expect(res.status).toBe(200)
    expect(writes.contacts).toHaveLength(1)
    expect(writes.contacts[0].patch).toEqual({ hr_post_class_emails_enabled: false })
    expect(writes.contacts[0].filters.id).toBe(CONTACT)
  })

  it('is a no-op success when already unsubscribed (providers re-fetch links)', async () => {
    const { db, writes } = makeDb({
      pref: prefRow,
      contact: { ...optedIn, hr_post_class_emails_enabled: false },
    })
    createServerClient.mockReturnValue(db)

    const res = await call(`scope=hr&token=${TOKEN}`)

    expect(res.status).toBe(200)
    expect(writes.contacts).toHaveLength(0)
  })

  it('404s an unresolvable token and charges the per-IP enumeration budget', async () => {
    const { db, writes } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)

    const res = await call('scope=hr&token=11111111-0000-4000-8000-000000000000')

    expect(res.status).toBe(404)
    expect(writes.contacts).toHaveLength(0)
    // checkRateLimit is how penaliseInvalidToken spends the budget.
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.anything(), 'hr-emails:invalid:203.0.113.7', expect.anything())
  })

  it('rejects a non-UUID token without touching the database', async () => {
    const { db, writes } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)

    const res = await call('scope=hr&token=not-a-uuid')

    expect(res.status).toBe(404)
    expect(writes.contacts).toHaveLength(0)
  })
})

// ── the legacy pair (what the 2,000+ already-delivered emails carry) ──

describe('legacy cid+sid pair', () => {
  it('still works, so links already sitting in inboxes keep working', async () => {
    const { db, writes } = makeDb({ session: sessionRow, contact: optedIn })
    createServerClient.mockReturnValue(db)

    const res = await call(`scope=hr&cid=${CONTACT}&sid=${SESSION}`)

    expect(res.status).toBe(200)
    expect(writes.contacts).toHaveLength(1)
    expect(writes.contacts[0].patch).toEqual({ hr_post_class_emails_enabled: false })
  })

  it('404s when the session id does not resolve at all', async () => {
    const { db, writes } = makeDb({ contact: optedIn })
    createServerClient.mockReturnValue(db)

    const res = await call(`scope=hr&cid=${CONTACT}&sid=${SESSION}`)

    expect(res.status).toBe(404)
    expect(writes.contacts).toHaveLength(0)
  })
})

// ── abuse budgets, reusing the #1353 guard ───────────────────────────

describe('rate limiting', () => {
  it('429s once the per-IP invalid-token budget is spent, before any lookup', async () => {
    const { db, writes } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)
    peekRateLimit.mockResolvedValue({
      allowed: false, remaining: 0, resetAt: new Date(Date.now() + 60_000), retryAfterSec: 60,
    })

    const res = await call(`scope=hr&token=${TOKEN}`)

    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(writes.contacts).toHaveLength(0)
    expect(writes.unsubscribe_refusals[0]).toMatchObject({ reason: 'ip_enumeration_budget' })
  })

  it('429s a single credential looping, keyed on the credential not the IP', async () => {
    const { db, writes } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)
    checkRateLimit.mockResolvedValue({
      allowed: false, remaining: 0, resetAt: new Date(Date.now() + 60_000), retryAfterSec: 60,
    })

    const res = await call(`scope=hr&token=${TOKEN}`)

    expect(res.status).toBe(429)
    expect(writes.contacts).toHaveLength(0)
    expect(writes.unsubscribe_refusals[0]).toMatchObject({ reason: 'token_flood' })
    // Per-token bucket carries no IP component, so a shared mail-provider
    // proxy can never trip it for everybody behind it.
    const key = checkRateLimit.mock.calls.at(-1)[1]
    expect(key).toMatch(/^hr-emails:token:[0-9a-f]{32}$/)
    expect(key).not.toContain('203.0.113.7')
  })
})

// ── shape ────────────────────────────────────────────────────────────

describe('request shape', () => {
  it('400s an unknown scope', async () => {
    const { db } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)
    const res = await call(`scope=nonsense&token=${TOKEN}`)
    expect(res.status).toBe(400)
  })

  it('400s a link carrying no credential at all', async () => {
    const { db, writes } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)
    const res = await call('scope=hr')
    expect(res.status).toBe(400)
    expect(writes.contacts).toHaveLength(0)
  })

  it('serves HTML, because a human clicked this from their inbox', async () => {
    const { db } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)
    const res = await call(`scope=hr&token=${TOKEN}`)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('unsubscribed')
  })
})

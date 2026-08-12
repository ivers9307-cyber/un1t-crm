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
//
// GETMUT.1 — and the opt-out no longer happens on the GET. Following the URL
// (a mail-provider link scanner, a security appliance, a browser prefetch) used
// to unsubscribe the person without them ever clicking. GET now resolves and
// budgets the credential exactly as before and renders a confirmation form;
// POST is what writes. The confirm page is deliberately built from the
// credential alone so it can never become an oracle over the flag.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({
  peekRateLimit: vi.fn(async () => ({ allowed: true, remaining: 20, resetAt: new Date(), retryAfterSec: 60 })),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 60, resetAt: new Date(), retryAfterSec: 60 })),
  getClientIp: vi.fn(() => '203.0.113.7'),
}))

import { createServerClient } from '@/lib/supabase'
import { peekRateLimit, checkRateLimit } from '@/lib/rate-limit'
import { GET, POST } from './route.js'

const TOKEN = '9f1c7c0e-0000-4000-8000-0000000000aa'
const CONTACT = 'c0000000-0000-4000-8000-00000000000c'
const OTHER_CONTACT = 'd0000000-0000-4000-8000-00000000000d'
const SESSION = '50000000-0000-4000-8000-000000000055'

// Chainable recorder. Records every write so a test can assert that a REFUSED
// request — or any GET at all — wrote nothing to contacts, the property that
// actually matters.
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

const url = (qs) => `https://crm.example/api/preferences/hr-emails?${qs}`
const get = (qs) => GET(new Request(url(qs)))
const post = (qs) => POST(new Request(url(qs), { method: 'POST' }))

const optedIn = { id: CONTACT, email: 'sarah@test.com', hr_post_class_emails_enabled: true }
const prefRow = { id: 'pref-1', contact_id: CONTACT, unsubscribe_token: TOKEN }
const sessionRow = { id: SESSION, contact_id: CONTACT }

beforeEach(() => {
  vi.clearAllMocks()
  peekRateLimit.mockResolvedValue({ allowed: true, remaining: 20, resetAt: new Date(), retryAfterSec: 60 })
  checkRateLimit.mockResolvedValue({ allowed: true, remaining: 60, resetAt: new Date(), retryAfterSec: 60 })
})

// ── GETMUT.1: following the link must not change consent ─────────────

describe('GETMUT.1 — GET confirms, POST acts', () => {
  it('a valid GET writes nothing to contacts, however scannable the link is', async () => {
    const { db, writes } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)

    const res = await get(`scope=hr&token=${TOKEN}`)

    expect(res.status).toBe(200)
    expect(writes.contacts).toHaveLength(0)
  })

  it('renders a form that POSTs back with the same credential', async () => {
    const { db } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)

    const body = await (await get(`scope=hr&token=${TOKEN}`)).text()

    expect(body).toContain('method="post"')
    expect(body).toContain(`token=${TOKEN}`)
    expect(body).toContain('scope=hr')
    // Nothing has happened yet, and the page has to say so.
    expect(body).not.toContain("You're unsubscribed")
  })

  it('carries the LEGACY pair through to the form action', async () => {
    const { db } = makeDb({ session: sessionRow, contact: optedIn })
    createServerClient.mockReturnValue(db)

    const body = await (await get(`scope=hr&cid=${CONTACT}&sid=${SESSION}`)).text()

    expect(body).toContain(`cid=${CONTACT}`)
    expect(body).toContain(`sid=${SESSION}`)
  })

  it('the POST that follows the form does the opt-out', async () => {
    const { db, writes } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)

    const res = await post(`scope=hr&token=${TOKEN}`)

    expect(res.status).toBe(200)
    expect(writes.contacts).toHaveLength(1)
    expect(writes.contacts[0].patch).toEqual({ hr_post_class_emails_enabled: false })
  })
})

// ── the confirm page must not be an oracle ───────────────────────────

describe('the confirm page leaks nothing about the contact', () => {
  const bodyFor = async (fixture) => {
    const { db } = makeDb(fixture)
    createServerClient.mockReturnValue(db)
    return (await get(`scope=hr&token=${TOKEN}`)).text()
  }

  it('is byte-identical for still-on, already-off, and a contact that is gone', async () => {
    const stillOn = await bodyFor({ pref: prefRow, contact: optedIn })
    const alreadyOff = await bodyFor({
      pref: prefRow, contact: { ...optedIn, hr_post_class_emails_enabled: false },
    })
    const missing = await bodyFor({ pref: prefRow, contact: null })

    expect(alreadyOff).toBe(stillOn)
    expect(missing).toBe(stillOn)
  })

  it('does not read the contacts row at all, which is what guarantees that', async () => {
    const tables = []
    const { db } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue({ from: (t) => { tables.push(t); return db.from(t) } })

    await get(`scope=hr&token=${TOKEN}`)

    expect(tables).not.toContain('contacts')
  })
})

// ── the hole ────────────────────────────────────────────────────────

describe('a bare contact id is no longer a credential', () => {
  it('refuses ?cid= on its own and writes nothing', async () => {
    const { db, writes } = makeDb({ pref: prefRow, session: sessionRow, contact: optedIn })
    createServerClient.mockReturnValue(db)

    const res = await post(`scope=hr&cid=${CONTACT}`)

    expect(res.status).toBe(404)
    expect(writes.contacts).toHaveLength(0)
  })

  it('refuses a bare ?cid= on GET too, and still records the refusal', async () => {
    const { db, writes } = makeDb({ pref: prefRow, session: sessionRow, contact: optedIn })
    createServerClient.mockReturnValue(db)

    const res = await get(`scope=hr&cid=${CONTACT}`)

    expect(res.status).toBe(404)
    expect(writes.contacts).toHaveLength(0)
    // Security accounting on a GET is fine and necessary — it is the
    // enumeration that happens there. Consent is what may not move.
    expect(writes.unsubscribe_refusals).toHaveLength(1)
  })

  it('records the refusal so a probe is visible, not silent', async () => {
    const { db, writes } = makeDb({ pref: prefRow, session: sessionRow, contact: optedIn })
    createServerClient.mockReturnValue(db)

    await post(`scope=hr&cid=${CONTACT}`)

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

    const res = await post(`scope=hr&cid=${CONTACT}&sid=${SESSION}`)

    expect(res.status).toBe(404)
    expect(writes.contacts).toHaveLength(0)
  })
})

// ── the token path (what every new email carries) ────────────────────

describe('token path', () => {
  it('flips the flag off for the token holder', async () => {
    const { db, writes } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)

    const res = await post(`scope=hr&token=${TOKEN}`)

    expect(res.status).toBe(200)
    expect(writes.contacts).toHaveLength(1)
    expect(writes.contacts[0].patch).toEqual({ hr_post_class_emails_enabled: false })
    expect(writes.contacts[0].filters.id).toBe(CONTACT)
  })

  it('is a no-op success when already unsubscribed (two emails, one person)', async () => {
    const { db, writes } = makeDb({
      pref: prefRow,
      contact: { ...optedIn, hr_post_class_emails_enabled: false },
    })
    createServerClient.mockReturnValue(db)

    const res = await post(`scope=hr&token=${TOKEN}`)

    expect(res.status).toBe(200)
    expect(writes.contacts).toHaveLength(0)
  })

  it('is a success when the contact row is gone (merged or deleted)', async () => {
    const { db, writes } = makeDb({ pref: prefRow, contact: null })
    createServerClient.mockReturnValue(db)

    const res = await post(`scope=hr&token=${TOKEN}`)

    expect(res.status).toBe(200)
    expect(writes.contacts).toHaveLength(0)
  })

  it('404s an unresolvable token and charges the per-IP enumeration budget', async () => {
    const { db, writes } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)

    const res = await post('scope=hr&token=11111111-0000-4000-8000-000000000000')

    expect(res.status).toBe(404)
    expect(writes.contacts).toHaveLength(0)
    // checkRateLimit is how penaliseInvalidToken spends the budget.
    expect(checkRateLimit).toHaveBeenCalledWith(
      expect.anything(), 'hr-emails:invalid:203.0.113.7', expect.anything())
  })

  it('rejects a non-UUID token without touching the database', async () => {
    const { db, writes } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)

    const res = await post('scope=hr&token=not-a-uuid')

    expect(res.status).toBe(404)
    expect(writes.contacts).toHaveLength(0)
  })
})

// ── the legacy pair (what the 2,000+ already-delivered emails carry) ──

describe('legacy cid+sid pair', () => {
  it('still works, so links already sitting in inboxes keep working', async () => {
    const { db, writes } = makeDb({ session: sessionRow, contact: optedIn })
    createServerClient.mockReturnValue(db)

    const res = await post(`scope=hr&cid=${CONTACT}&sid=${SESSION}`)

    expect(res.status).toBe(200)
    expect(writes.contacts).toHaveLength(1)
    expect(writes.contacts[0].patch).toEqual({ hr_post_class_emails_enabled: false })
  })

  it('404s when the session id does not resolve at all', async () => {
    const { db, writes } = makeDb({ contact: optedIn })
    createServerClient.mockReturnValue(db)

    const res = await post(`scope=hr&cid=${CONTACT}&sid=${SESSION}`)

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

    const res = await post(`scope=hr&token=${TOKEN}`)

    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(writes.contacts).toHaveLength(0)
    expect(writes.unsubscribe_refusals[0]).toMatchObject({ reason: 'ip_enumeration_budget' })
  })

  it('429s the GET on the same budget — both methods are accounted', async () => {
    const { db, writes } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)
    peekRateLimit.mockResolvedValue({
      allowed: false, remaining: 0, resetAt: new Date(Date.now() + 60_000), retryAfterSec: 60,
    })

    const res = await get(`scope=hr&token=${TOKEN}`)

    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect(writes.unsubscribe_refusals[0]).toMatchObject({ reason: 'ip_enumeration_budget' })
  })

  it('429s a single credential looping, keyed on the credential not the IP', async () => {
    const { db, writes } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)
    checkRateLimit.mockResolvedValue({
      allowed: false, remaining: 0, resetAt: new Date(Date.now() + 60_000), retryAfterSec: 60,
    })

    const res = await post(`scope=hr&token=${TOKEN}`)

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
    expect((await get(`scope=nonsense&token=${TOKEN}`)).status).toBe(400)
    expect((await post(`scope=nonsense&token=${TOKEN}`)).status).toBe(400)
  })

  it('400s a link carrying no credential at all', async () => {
    const { db, writes } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)
    const res = await get('scope=hr')
    expect(res.status).toBe(400)
    expect(writes.contacts).toHaveLength(0)
  })

  it('serves HTML, because a human clicked this from their inbox', async () => {
    const { db } = makeDb({ pref: prefRow, contact: optedIn })
    createServerClient.mockReturnValue(db)
    const res = await post(`scope=hr&token=${TOKEN}`)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('unsubscribed')
  })
})

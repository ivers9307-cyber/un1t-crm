// UNSUB-RL.1 — one-click unsubscribe must not be refused because somebody
// else unsubscribed first.
//
// THE DEFECT
// The route opened with `checkRateLimit(db, \`unsubscribe:${ip}\`, { max: 10,
// windowMs: 15 * 60_000 })`. RFC 8058 one-click POSTs are sent by the
// recipient's MAIL PROVIDER, not by the recipient's browser: Gmail sends them
// from a shared proxy pool, so N people unsubscribing from one campaign can
// all arrive on one source IP. The 11th got a 429 and the route returned
// before touching contact_preferences — the opt-out was simply lost, silently,
// with nothing written anywhere. Gmail/Yahoo bulk-sender rules and GDPR/PECR
// both require these to be honoured. Measured live: 9 one-click unsubscribes
// in a single 15-minute window on 2026-08-05, against a limit of 10.
//
// THE FIX
// A valid token IS the credential, and it names exactly one contact. So the
// per-IP budget now applies only to callers whose token did NOT resolve
// (the enumeration population), and a resolved token gets a generous
// per-token budget that no shared proxy can reach. Every refusal is recorded.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getRequestOrigin: vi.fn(() => 'https://crm.example') }))
vi.mock('@/lib/rate-limit', () => ({
  peekRateLimit: vi.fn(async () => ({ allowed: true, remaining: 20, resetAt: new Date(0), retryAfterSec: 60 })),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 60, resetAt: new Date(0), retryAfterSec: 60 })),
  getClientIp: vi.fn(() => '203.0.113.9'),
  rateLimitResponse: vi.fn(() => new Response(JSON.stringify({ success: false, error: 'rate limited' }), {
    status: 429, headers: { 'content-type': 'application/json' },
  })),
}))

import { createServerClient } from '@/lib/supabase'
import { peekRateLimit, checkRateLimit } from '@/lib/rate-limit'
import { POST } from './[token]/route'
import { tokenFingerprint } from '@/lib/consent-token-guard'

const TOKEN = '9f1c7c0e-0000-4000-8000-000000000001'

function makeDb({ pref = null, locRow = null } = {}) {
  const writes = {
    contact_preferences: [], contact_location_preferences: [],
    contacts: [], consent_log: [], unsubscribe_refusals: [],
  }
  const db = {
    from(table) {
      const api = {
        select() { return api },
        eq() { return api },
        single: async () => (
          table === 'contact_preferences' && pref
            ? { data: pref, error: null }
            : { data: null, error: { message: 'no rows' } }
        ),
        maybeSingle: async () => ({ data: table === 'contact_location_preferences' ? locRow : null, error: null }),
        update(row) { writes[table]?.push(row); return api },
        insert(rows) { writes[table]?.push(...[].concat(rows)); return Promise.resolve({ error: null }) },
      }
      return api
    },
    rpc: async () => ({ error: null }),
  }
  return { db, writes }
}

const req = (url, body) => new Request(url, { method: 'POST', body: body ? JSON.stringify(body) : undefined })
const props = { params: Promise.resolve({ token: TOKEN }) }

const OPTED_IN = { id: 'p1', contact_id: 'c1', email_marketing: true, contacts: { id: 'c1', location_id: 'loc-1' } }

beforeEach(() => vi.clearAllMocks())

describe('the per-IP budget no longer touches a valid opt-out', () => {
  it('never spends per-IP budget on a request whose token resolves', async () => {
    const { db } = makeDb({ pref: OPTED_IN })
    createServerClient.mockReturnValue(db)

    await POST(req(`https://crm.example/api/unsubscribe/${TOKEN}`), props)

    // The IP bucket is PEEKED, not incremented. Ten Gmail-proxied opt-outs
    // for ten different people leave the IP budget exactly where it started.
    expect(peekRateLimit).toHaveBeenCalledTimes(1)
    expect(peekRateLimit.mock.calls[0][1]).toBe('unsubscribe:invalid:203.0.113.9')
    const ipIncrements = checkRateLimit.mock.calls.filter(([, key]) => key.includes('203.0.113.9'))
    expect(ipIncrements).toHaveLength(0)
  })

  it('budgets a resolved token on the TOKEN, keyed by fingerprint', async () => {
    const { db } = makeDb({ pref: OPTED_IN })
    createServerClient.mockReturnValue(db)

    await POST(req(`https://crm.example/api/unsubscribe/${TOKEN}`), props)

    expect(checkRateLimit).toHaveBeenCalledTimes(1)
    const key = checkRateLimit.mock.calls[0][1]
    expect(key).toBe(`unsubscribe:token:${tokenFingerprint(TOKEN)}`)
    expect(key).not.toContain(TOKEN)
  })

  it('the classic regression: many valid opt-outs from ONE proxy IP all land', async () => {
    // This is the whole bug. Pre-fix, the 11th of these returned 429 and wrote
    // nothing. peekRateLimit is left allowing throughout because nothing here
    // ever spends invalid-token budget — which is precisely the property that
    // makes a Gmail proxy safe.
    for (let i = 0; i < 25; i++) {
      const { db, writes } = makeDb({ pref: { ...OPTED_IN, contact_id: `c${i}` } })
      createServerClient.mockReturnValue(db)

      const res = await POST(req(`https://crm.example/api/unsubscribe/${TOKEN}`), props)

      expect(res.status).toBe(200)
      expect(writes.contact_preferences).toHaveLength(1)
      expect(writes.contact_preferences[0]).toMatchObject({ email_marketing: false })
    }
    // 25 opt-outs, zero invalid-token budget spent.
    expect(checkRateLimit.mock.calls.every(([, key]) => key.startsWith('unsubscribe:token:'))).toBe(true)
  })
})

describe('a malformed token costs nothing at all', () => {
  it('is rejected on shape, with no database lookup', async () => {
    const { db } = makeDb({ pref: OPTED_IN })
    const fromSpy = vi.spyOn(db, 'from')
    createServerClient.mockReturnValue(db)

    const res = await POST(
      req('https://crm.example/api/unsubscribe/not-a-uuid'),
      { params: Promise.resolve({ token: 'not-a-uuid' }) },
    )

    expect(res.status).toBe(404)
    // The only table touched is the refusal record — never contact_preferences.
    expect(fromSpy.mock.calls.map(([t]) => t)).toEqual(['unsubscribe_refusals'])
  })
})

describe('the abuse surface the old limiter covered is still covered', () => {
  it('an unresolvable token spends per-IP budget', async () => {
    const { db } = makeDb({ pref: null })
    createServerClient.mockReturnValue(db)

    const res = await POST(req(`https://crm.example/api/unsubscribe/${TOKEN}`), props)

    expect(res.status).toBe(404)
    const penalty = checkRateLimit.mock.calls.find(([, key]) => key === 'unsubscribe:invalid:203.0.113.9')
    expect(penalty).toBeTruthy()
  })

  it('refuses outright once an IP has burned its invalid-token budget', async () => {
    peekRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(0), retryAfterSec: 60 })
    const { db } = makeDb({ pref: null })
    createServerClient.mockReturnValue(db)

    const res = await POST(req(`https://crm.example/api/unsubscribe/${TOKEN}`), props)
    expect(res.status).toBe(429)
  })

  it('caps a mail client looping on ONE token, without touching anyone else', async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(0), retryAfterSec: 60 })
    const { db, writes } = makeDb({ pref: OPTED_IN })
    createServerClient.mockReturnValue(db)

    const res = await POST(req(`https://crm.example/api/unsubscribe/${TOKEN}`), props)
    expect(res.status).toBe(429)
    expect(writes.contact_preferences).toHaveLength(0)
  })
})

describe('a repeat opt-out is a no-op success, not a failure', () => {
  it('returns 200 when every requested channel is already off', async () => {
    const { db, writes } = makeDb({
      pref: { id: 'p1', contact_id: 'c1', email_marketing: false, contacts: { id: 'c1' } },
    })
    createServerClient.mockReturnValue(db)

    const res = await POST(req(`https://crm.example/api/unsubscribe/${TOKEN}`), props)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.already_unsubscribed).toBe(true)
    expect(writes.contact_preferences).toHaveLength(0)
    expect(writes.consent_log).toHaveLength(0)
  })
})

describe('every refused opt-out leaves a trace', () => {
  it('records the IP-budget refusal — the one case that can still drop a valid opt-out', async () => {
    peekRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(0), retryAfterSec: 60 })
    const { db, writes } = makeDb({ pref: OPTED_IN })
    createServerClient.mockReturnValue(db)

    const res = await POST(req(`https://crm.example/api/unsubscribe/${TOKEN}`), props)

    expect(res.status).toBe(429)
    expect(writes.unsubscribe_refusals).toHaveLength(1)
    expect(writes.unsubscribe_refusals[0]).toMatchObject({
      endpoint: 'unsubscribe',
      reason: 'ip_enumeration_budget',
      ip_address: '203.0.113.9',
    })
    // The fingerprint is what makes it recoverable by hand: it joins back to
    // exactly one contact_preferences row without storing a live token.
    expect(writes.unsubscribe_refusals[0].token_fingerprint).toBe(tokenFingerprint(TOKEN))
  })

  it('records an invalid token, with a fingerprint and never the token itself', async () => {
    const { db, writes } = makeDb({ pref: null })
    createServerClient.mockReturnValue(db)

    await POST(req(`https://crm.example/api/unsubscribe/${TOKEN}`), props)

    expect(writes.unsubscribe_refusals).toHaveLength(1)
    expect(writes.unsubscribe_refusals[0]).toMatchObject({ reason: 'invalid_token' })
    expect(writes.unsubscribe_refusals[0].token_fingerprint).toBe(tokenFingerprint(TOKEN))
    expect(JSON.stringify(writes.unsubscribe_refusals[0])).not.toContain(TOKEN)
  })

  it('records a per-token refusal WITH the contact id, so the operator knows whose opt-out was dropped', async () => {
    checkRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(0), retryAfterSec: 60 })
    const { db, writes } = makeDb({ pref: OPTED_IN })
    createServerClient.mockReturnValue(db)

    await POST(req(`https://crm.example/api/unsubscribe/${TOKEN}?c=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`), props)

    expect(writes.unsubscribe_refusals).toHaveLength(1)
    expect(writes.unsubscribe_refusals[0]).toMatchObject({
      reason: 'token_flood',
      contact_id: 'c1',
      campaign_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    })
  })

  it('records nothing at all on the happy path', async () => {
    const { db, writes } = makeDb({ pref: OPTED_IN })
    createServerClient.mockReturnValue(db)
    await POST(req(`https://crm.example/api/unsubscribe/${TOKEN}`), props)
    expect(writes.unsubscribe_refusals).toHaveLength(0)
  })
})

describe('a garbage ?l= must not 500 somebody out of their opt-out', () => {
  it('falls back to the global opt-out instead of raising on the uuid cast', async () => {
    const { db, writes } = makeDb({ pref: OPTED_IN })
    createServerClient.mockReturnValue(db)

    const res = await POST(req(`https://crm.example/api/unsubscribe/${TOKEN}?l=not-a-uuid`), props)

    expect(res.status).toBe(200)
    // Global row, not the location row: unscoped is the direction that cannot
    // leave someone subscribed against their wishes.
    expect(writes.contact_preferences).toHaveLength(1)
    expect(writes.contact_location_preferences).toHaveLength(0)
    expect(writes.consent_log[0].location_id).toBeNull()
  })
})

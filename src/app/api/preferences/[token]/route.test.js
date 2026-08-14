// PMSUPP.1 — the preference centre is the OTHER surface whose consent writes
// never reached Postmark. Opting out here must suppress the address at
// Postmark; opting back in must lift OUR suppression and nothing else.
//
// Both calls are fire-and-forget side effects on a path whose primary write
// has already succeeded (CLAUDE.md), which is what the "Postmark is down"
// tests pin: the person's preference is durable in our database, so the
// response is 200 success whatever Postmark did.
//
// The HardBounce rule itself lives one layer down, in
// src/lib/postmark-suppressions.js — a resubscribe click may never reactivate
// a dead mailbox (EMAILREP.4 / NOENGSUP.1 hold the same line on the database
// side). Here we only assert that the route asks, and that the answer cannot
// hurt the customer's own change.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/consent-propagation', () => ({ propagateOptOut: vi.fn(async () => {}) }))
vi.mock('@/lib/postmark-suppressions', () => ({
  suppressAtPostmark: vi.fn(async () => ({ ok: 1, failed: [] })),
  unsuppressAtPostmark: vi.fn(async () => ({ ok: 1, failed: [], skipped: [] })),
}))
vi.mock('@/lib/rate-limit', async () => {
  const actual = await vi.importActual('@/lib/rate-limit')
  return { ...actual, getClientIp: () => '203.0.113.9' }
})
vi.mock('@/lib/consent-token-guard', async () => {
  const actual = await vi.importActual('@/lib/consent-token-guard')
  return {
    ...actual,
    guardBeforeTokenLookup: vi.fn(async () => ({ allowed: true })),
    guardResolvedToken: vi.fn(async () => ({ allowed: true })),
    penaliseInvalidToken: vi.fn(async () => {}),
    recordRefusedOptOut: vi.fn(async () => {}),
  }
})

import { PUT } from './route'
import { createServerClient } from '@/lib/supabase'
import { suppressAtPostmark, unsuppressAtPostmark } from '@/lib/postmark-suppressions'

const TOKEN = '11111111-2222-3333-4444-555555555555'
const LOCATION = 'a0000000-0000-0000-0000-000000000001'

const PREF = {
  id: 'pref-1',
  contact_id: 'contact-1',
  email_marketing: true,
  email_administrative: true,
  whatsapp_marketing: true,
  whatsapp_administrative: true,
  sms_marketing: true,
  sms_administrative: true,
  contacts: { id: 'contact-1', name: 'Ada', email: 'Ada@Example.com', email_status: 'active', wa_phone: '353860000000' },
}

// Chainable, thenable double (supabase-js builders are thenables, not
// Promises), recording every statement the route issues.
function makeDb({ pref = PREF, locRow = null, writeError = null } = {}) {
  const statements = []
  const from = (table) => {
    const state = { table, op: 'select', filters: {}, payload: null }
    statements.push(state)
    const builder = {
      select: (cols) => { state.op = 'select'; state.columns = cols; return builder },
      insert: (rows) => { state.op = 'insert'; state.payload = rows; return builder },
      update: (patch) => { state.op = 'update'; state.payload = patch; return builder },
      eq: (col, val) => { state.filters[col] = val; return builder },
      single: () => builder,
      maybeSingle: () => builder,
      then: (resolve, reject) => Promise.resolve(result(state)).then(resolve, reject),
    }
    return builder
  }
  const result = (state) => {
    if (state.table === 'contact_preferences' && state.op === 'select') {
      return pref ? { data: pref, error: null } : { data: null, error: { message: 'not found' } }
    }
    if (state.table === 'contact_location_preferences' && state.op === 'select') {
      return { data: locRow, error: null }
    }
    if (state.op === 'update') return { data: null, error: writeError }
    return { data: null, error: null }
  }
  return { from: vi.fn(from), rpc: vi.fn(async () => ({ data: null, error: null })), statements }
}

const req = (body) => ({
  url: `https://crm.test/api/preferences/${TOKEN}`,
  headers: { get: () => null },
  json: async () => body,
})

const call = (body) => PUT(req(body), { params: Promise.resolve({ token: TOKEN }) })

beforeEach(() => {
  vi.clearAllMocks()
  suppressAtPostmark.mockResolvedValue({ ok: 1, failed: [] })
  unsuppressAtPostmark.mockResolvedValue({ ok: 1, failed: [], skipped: [] })
})

describe('PUT /api/preferences/[token] — Postmark suppression (PMSUPP.1)', () => {
  it('suppresses at Postmark when email_marketing flips to false', async () => {
    createServerClient.mockReturnValue(makeDb())
    const res = await call({ email_marketing: false })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
    expect(suppressAtPostmark).toHaveBeenCalledWith('Ada@Example.com')
    expect(unsuppressAtPostmark).not.toHaveBeenCalled()
  })

  it('lifts the suppression when email_marketing flips to true', async () => {
    createServerClient.mockReturnValue(makeDb({ pref: { ...PREF, email_marketing: false } }))
    const res = await call({ email_marketing: true })
    expect(res.status).toBe(200)
    expect(unsuppressAtPostmark).toHaveBeenCalledWith('Ada@Example.com')
    expect(suppressAtPostmark).not.toHaveBeenCalled()
  })

  it('does nothing at Postmark when email_marketing did not change', async () => {
    createServerClient.mockReturnValue(makeDb())
    const res = await call({ sms_marketing: false })
    expect(await res.json()).toMatchObject({ success: true })
    expect(suppressAtPostmark).not.toHaveBeenCalled()
    expect(unsuppressAtPostmark).not.toHaveBeenCalled()
  })

  it('does NOT suppress on a LOCATION-SCOPED opt-out — the suppression is server-wide', async () => {
    // LOCCOMMS.4 again: a Postmark suppression is per (server, stream), so
    // pushing one when somebody leaves ONE list would silently stop the mail
    // they still want from the others.
    createServerClient.mockReturnValue(makeDb({ locRow: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true } }))
    const res = await call({ locationId: LOCATION, email_marketing: false })
    expect(await res.json()).toMatchObject({ success: true })
    expect(suppressAtPostmark).not.toHaveBeenCalled()
  })

  it('DOES lift on a location-scoped opt-IN — a server-wide suppression would block the mail they just asked for', async () => {
    createServerClient.mockReturnValue(makeDb({ locRow: { email_marketing: false, sms_marketing: true, whatsapp_marketing: true } }))
    const res = await call({ locationId: LOCATION, email_marketing: true })
    expect(await res.json()).toMatchObject({ success: true })
    expect(unsuppressAtPostmark).toHaveBeenCalledWith('Ada@Example.com')
  })

  it('still confirms the opt-in when Postmark refuses to lift a hard-bounce suppression', async () => {
    // The lift is declined one layer down (deleting a HardBounce suppression
    // is "reactivating the associated bounce"). The person's consent is still
    // recorded — they simply stay unmailable until the address recovers, which
    // is the same answer email_status already gives them.
    createServerClient.mockReturnValue(makeDb({ pref: { ...PREF, email_marketing: false } }))
    unsuppressAtPostmark.mockResolvedValue({ ok: 0, failed: [], skipped: [{ email: 'Ada@Example.com', reason: 'HardBounce' }] })
    const res = await call({ email_marketing: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
  })

  it('still returns 200 success when Postmark rejects the suppression', async () => {
    createServerClient.mockReturnValue(makeDb())
    suppressAtPostmark.mockResolvedValue({ ok: 0, failed: [{ email: 'Ada@Example.com', message: 'HTTP 503' }] })
    const res = await call({ email_marketing: false })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
  })

  it('still returns 200 success when the suppression call throws', async () => {
    createServerClient.mockReturnValue(makeDb())
    suppressAtPostmark.mockRejectedValue(new Error('boom'))
    const res = await call({ email_marketing: false })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
  })

  it('still returns 200 success when the un-suppression call throws', async () => {
    createServerClient.mockReturnValue(makeDb({ pref: { ...PREF, email_marketing: false } }))
    unsuppressAtPostmark.mockRejectedValue(new Error('boom'))
    const res = await call({ email_marketing: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
  })

  it('touches Postmark not at all when the preference write itself failed', async () => {
    createServerClient.mockReturnValue(makeDb({ writeError: { message: 'db down' } }))
    const res = await call({ email_marketing: false })
    expect(res.status).toBe(500)
    expect(suppressAtPostmark).not.toHaveBeenCalled()
    expect(unsuppressAtPostmark).not.toHaveBeenCalled()
  })
})

// PMSUPP.1 — the one-click unsubscribe must ALSO suppress the address at
// Postmark, and a Postmark failure must never cost somebody their opt-out.
//
// THE ASYMMETRY THIS ROUTE SITS IN
// Postmark's own mail-client Unsubscribe button suppresses at Postmark and
// webhooks us. This route wrote only to our database, so for every opt-out
// taken here our database was the SINGLE gate — and mig 544 is the proof that
// a single gate fails silently (eleven contacts logged as opted out while the
// column the sender reads still said mailable). The suppression call below is
// the second, independent refusal.
//
// It is a fire-and-forget side effect on a path whose primary write has
// already succeeded (CLAUDE.md), which is what the "Postmark is down" test
// pins: the person is unsubscribed in our database, so the response is 200
// success regardless of what Postmark did.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/consent-propagation', () => ({ propagateOptOut: vi.fn(async () => {}) }))
vi.mock('@/lib/postmark-suppressions', () => ({ suppressAtPostmark: vi.fn(async () => ({ ok: 1, failed: [] })) }))
vi.mock('@/lib/postmark-server-for-location', () => ({ serverTokenForLocation: vi.fn(async () => null) }))
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

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { suppressAtPostmark } from '@/lib/postmark-suppressions'
import { serverTokenForLocation } from '@/lib/postmark-server-for-location'

const TOKEN = '11111111-2222-3333-4444-555555555555'
const LOCATION = 'a0000000-0000-0000-0000-000000000001'

const PREF = {
  id: 'pref-1',
  contact_id: 'contact-1',
  email_marketing: true,
  sms_marketing: true,
  whatsapp_marketing: true,
  contacts: { id: 'contact-1', name: 'Ada', email: 'Ada@Example.com', location_id: LOCATION, wa_phone: '353860000000' },
}

// ── minimal supabase double ─────────────────────────────────────────
// Chainable, thenable (supabase-js builders are thenables, not Promises), and
// records every statement so a test can assert what the route actually wrote.
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

const req = ({ url = `https://crm.test/api/unsubscribe/${TOKEN}`, body = '' } = {}) => ({
  url,
  headers: { get: () => null },
  text: async () => body,
})

const call = (opts, token = TOKEN) => POST(req(opts), { params: Promise.resolve({ token }) })

beforeEach(() => {
  vi.clearAllMocks()
  suppressAtPostmark.mockResolvedValue({ ok: 1, failed: [] })
  serverTokenForLocation.mockResolvedValue(null)
})

describe('POST /api/unsubscribe/[token] — Postmark suppression (PMSUPP.1)', () => {
  it('suppresses the address at Postmark when email_marketing actually flips off', async () => {
    createServerClient.mockReturnValue(makeDb())
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
    expect(suppressAtPostmark).toHaveBeenCalledWith('Ada@Example.com', { serverToken: null })
  })

  // W1.E4 — a tenant on its own Postmark server is suppressed THERE, where its
  // mail actually goes out; the server is resolved from the contact's home
  // location (→ org → live tenant_email_domains row).
  it('suppresses on the TENANT server when the contact\'s org has a live one', async () => {
    serverTokenForLocation.mockResolvedValue('tenant-tok')
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await call()
    expect(res.status).toBe(200)
    expect(serverTokenForLocation).toHaveBeenCalledWith(db, LOCATION)
    expect(suppressAtPostmark).toHaveBeenCalledWith('Ada@Example.com', { serverToken: 'tenant-tok' })
  })

  it('does NOT suppress when nothing flipped — a repeat click is not a new opt-out', async () => {
    createServerClient.mockReturnValue(makeDb({ pref: { ...PREF, email_marketing: false } }))
    const res = await call()
    expect(await res.json()).toMatchObject({ success: true, already_unsubscribed: true })
    expect(suppressAtPostmark).not.toHaveBeenCalled()
  })

  it('does NOT suppress on a non-email opt-out', async () => {
    createServerClient.mockReturnValue(makeDb())
    const res = await call({ body: JSON.stringify({ channels: ['sms_marketing'] }) })
    expect(await res.json()).toMatchObject({ success: true })
    expect(suppressAtPostmark).not.toHaveBeenCalled()
  })

  it('does NOT suppress on a LOCATION-SCOPED opt-out — the suppression is server-wide', async () => {
    // LOCCOMMS.4: leaving one location's list must not remove the person from
    // another's. A Postmark suppression is per (server, stream), so pushing one
    // here would silently block the locations they are still opted in to.
    createServerClient.mockReturnValue(makeDb({ locRow: { email_marketing: true, sms_marketing: true, whatsapp_marketing: true } }))
    const res = await call({ url: `https://crm.test/api/unsubscribe/${TOKEN}?l=${LOCATION}` })
    expect(await res.json()).toMatchObject({ success: true })
    expect(suppressAtPostmark).not.toHaveBeenCalled()
  })

  it('still returns 200 success when Postmark REJECTS the suppression', async () => {
    createServerClient.mockReturnValue(makeDb())
    suppressAtPostmark.mockResolvedValue({ ok: 0, failed: [{ email: 'Ada@Example.com', message: 'HTTP 503' }] })
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, unsubscribed_channels: ['email_marketing'] })
  })

  it('still returns 200 success when the suppression call THROWS', async () => {
    // The lib is best-effort by contract and must never throw — but the route
    // must survive it if it ever does. A Postmark outage cannot cost somebody
    // their opt-out.
    createServerClient.mockReturnValue(makeDb())
    suppressAtPostmark.mockRejectedValue(new Error('boom'))
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
  })

  it('does NOT suppress when the preference write itself failed', async () => {
    createServerClient.mockReturnValue(makeDb({ writeError: { message: 'db down' } }))
    const res = await call()
    expect(res.status).toBe(500)
    expect(suppressAtPostmark).not.toHaveBeenCalled()
  })
})

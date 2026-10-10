// Route-level tests for the Revolut Merchant webhook receiver — the
// highest-consequence handler in the app (it flips a car's deposit to PAID
// off an inbound HTTP call). Revolut sends ORDER_AUTHORISED then
// ORDER_COMPLETED, and retries any delivery on a non-2xx, so the contract
// that matters is: **a re-delivery is a no-op and a terminal state is never
// reset**. These tests pin that contract.
//
// Two layers:
//   1. depositUpdateForOrder() — the pure state→updates mapping, incl. the
//      idempotency crown-jewel (a repeat ORDER_COMPLETED must not re-stamp
//      deposit_paid_at).
//   2. POST() — the orchestration guards: bad signature → 401; dedup short-
//      circuit, unknown order, and getOrder failure all → 200 with NO write;
//      transient states ignored; the terminal write is correct.
//
// The DB is a tiny in-memory mock that records every .update() so we can
// assert "no write happened" / "this exact patch happened". Everything else
// the handler reaches (receipt SMS, orders/events sync, sequences) is mocked
// to a no-op so a single test exercises only the path under assertion.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/revolut', () => ({ verifyWebhookSignature: vi.fn(), getOrder: vi.fn() }))
vi.mock('@/lib/orders', () => ({ syncOrderFromCarDeposit: vi.fn(async () => {}) }))
vi.mock('@/lib/contact-events', () => ({
  emitEvent: vi.fn(async () => {}),
  EVENT_TYPES: { ORDER_COMPLETED: 'order.completed', ORDER_FAILED: 'order.failed', ORDER_ABANDONED: 'order.abandoned' },
}))
vi.mock('@/lib/sequences', () => ({ triggerSequencesForOrderStatus: vi.fn(async () => {}) }))
vi.mock('@/lib/webhook-events', () => ({
  recordWebhookEvent: vi.fn(async () => ({ seen: false })),
  WEBHOOK_PROVIDERS: { REVOLUT: 'revolut' },
}))

import { POST, depositUpdateForOrder } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { verifyWebhookSignature, getOrder } from '@/lib/revolut'
import { recordWebhookEvent } from '@/lib/webhook-events'

// ── In-memory DB mock — records every update for assertions ──────────
function makeDb({ car = null, contact = null } = {}) {
  const updates = []
  function from(table) {
    const b = { _op: 'select', _payload: null }
    b.select = () => b
    b.update = (payload) => { b._op = 'update'; b._payload = payload; return b }
    b.insert = () => b
    b.eq = () => b
    b.ilike = () => b
    b.maybeSingle = () => Promise.resolve({ data: table === 'cars' ? car : contact })
    b.then = (resolve) => {
      if (b._op === 'update') updates.push({ table, payload: b._payload })
      return resolve({ data: null, error: null })
    }
    return b
  }
  return { from, _updates: updates }
}

function makeRequest({
  body = JSON.stringify({ event: 'ORDER_COMPLETED', order_id: 'ord-1' }),
  sig = 'v1=sig',
  ts = '12345',
} = {}) {
  const headers = { 'revolut-signature': sig, 'revolut-request-timestamp': ts }
  return {
    text: async () => body,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  }
}

const CAR = {
  id: 'car-1', location_id: 'loc-1', deposit_token: 'tok',
  deposit_status: 'sent', deposit_paid_at: null,
  deposit_amount: 500, deposit_paid_amount: null, deposit_receipt_sent_at: null,
  buyer_phone: '+353871234567', buyer_name: 'Sarah', buyer_email: null,
  make: 'Tesla', model: 'Model 3', irish_reg: '241-D-1',
  locations: { id: 'loc-1', name: 'CCF' },
}

beforeEach(() => {
  vi.clearAllMocks()
  verifyWebhookSignature.mockReturnValue(true)
  recordWebhookEvent.mockResolvedValue({ seen: false })
})

// ── Pure: depositUpdateForOrder ──────────────────────────────────────
describe('depositUpdateForOrder (pure state → updates)', () => {
  const NOW = new Date('2026-06-03T10:00:00Z')

  it('completed + never paid → status paid, stamps paid_at + paid_amount (minor→major)', () => {
    const { state, updates } = depositUpdateForOrder({ order: { state: 'completed', amount: 50000 }, car: { deposit_paid_at: null }, now: NOW })
    expect(state).toBe('completed')
    expect(updates).toEqual({ deposit_status: 'paid', deposit_paid_at: NOW.toISOString(), deposit_paid_amount: 500 })
  })

  it('IDEMPOTENCY: completed + already paid → does NOT re-stamp deposit_paid_at', () => {
    const { updates } = depositUpdateForOrder({ order: { state: 'completed', amount: 50000 }, car: { deposit_paid_at: '2026-01-01T00:00:00Z' }, now: NOW })
    expect(updates.deposit_status).toBe('paid')
    expect('deposit_paid_at' in updates).toBe(false)
    expect(updates.deposit_paid_amount).toBe(500)
  })

  it('completed with non-numeric amount → omits deposit_paid_amount', () => {
    const { updates } = depositUpdateForOrder({ order: { state: 'completed' }, car: { deposit_paid_at: null }, now: NOW })
    expect('deposit_paid_amount' in updates).toBe(false)
    expect(updates.deposit_status).toBe('paid')
  })

  it('cancelled / failed → status only', () => {
    expect(depositUpdateForOrder({ order: { state: 'cancelled' }, car: {} }).updates).toEqual({ deposit_status: 'cancelled' })
    expect(depositUpdateForOrder({ order: { state: 'FAILED' }, car: {} }).updates).toEqual({ deposit_status: 'failed' })
  })

  it('transient states (pending / processing / authorised) → updates null (caller skips)', () => {
    for (const s of ['pending', 'processing', 'authorised', 'weird', '']) {
      expect(depositUpdateForOrder({ order: { state: s }, car: {} }).updates).toBeNull()
    }
  })
})

// ── Handler: POST orchestration + idempotency guards ─────────────────
describe('POST /api/webhooks/revolut', () => {
  it('rejects an invalid signature with 401 and never touches the DB', async () => {
    verifyWebhookSignature.mockReturnValue(false)
    const res = await POST(makeRequest())
    expect(res.status).toBe(401)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('returns 200 for an empty body (verification ping) without a DB client', async () => {
    const res = await POST(makeRequest({ body: '' }))
    expect(res.status).toBe(200)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('returns 200 when order_id/event are missing, before creating a DB client', async () => {
    const res = await POST(makeRequest({ body: JSON.stringify({ event: 'ORDER_COMPLETED' }) }))
    expect(res.status).toBe(200)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('DEDUP: a re-delivered event short-circuits to 200 with no write', async () => {
    recordWebhookEvent.mockResolvedValue({ seen: true })
    const db = makeDb({ car: CAR })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.deduped).toBe(true)
    expect(db._updates).toHaveLength(0)
    expect(getOrder).not.toHaveBeenCalled()
  })

  it('unknown order (no matching car) → 200 and no write', async () => {
    const db = makeDb({ car: null })
    createServerClient.mockReturnValue(db)
    const res = await POST(makeRequest())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.skipped).toBe('unknown_order')
    expect(db._updates).toHaveLength(0)
    expect(getOrder).not.toHaveBeenCalled()
  })

  it('getOrder failure → 200 and no write (lets Revolut retry)', async () => {
    const db = makeDb({ car: CAR })
    createServerClient.mockReturnValue(db)
    getOrder.mockRejectedValue(new Error('revolut down'))
    const res = await POST(makeRequest())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.skipped).toBe('getorder_failed')
    expect(db._updates).toHaveLength(0)
  })

  it('transient state (authorised) → 200 ignored, no write', async () => {
    const db = makeDb({ car: CAR })
    createServerClient.mockReturnValue(db)
    getOrder.mockResolvedValue({ state: 'authorised' })
    const res = await POST(makeRequest())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ignored_state).toBe('authorised')
    expect(db._updates).toHaveLength(0)
  })

  it('completed (fresh) → writes paid + paid_at + paid_amount', async () => {
    const db = makeDb({ car: CAR })
    createServerClient.mockReturnValue(db)
    getOrder.mockResolvedValue({ state: 'completed', amount: 50000 })
    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    expect(db._updates).toHaveLength(1)
    const patch = db._updates[0].payload
    expect(patch.deposit_status).toBe('paid')
    expect(patch.deposit_paid_amount).toBe(500)
    expect(typeof patch.deposit_paid_at).toBe('string')
  })

  it('IDEMPOTENCY: completed re-delivery on an already-paid car never re-stamps paid_at', async () => {
    const db = makeDb({ car: { ...CAR, deposit_paid_at: '2026-01-01T00:00:00Z' } })
    createServerClient.mockReturnValue(db)
    getOrder.mockResolvedValue({ state: 'completed', amount: 50000 })
    const res = await POST(makeRequest())
    expect(res.status).toBe(200)
    expect(db._updates).toHaveLength(1)
    const patch = db._updates[0].payload
    expect(patch.deposit_status).toBe('paid')
    expect('deposit_paid_at' in patch).toBe(false) // original timestamp preserved
  })
})

// ── W0.6b — the buyer's contact is resolved inside the CAR'S ORGANISATION ──
//
// contacts_email_org_unique (mig 712) is per organisation, so one address can
// be a contact at several tenants. The buyer lookup was an estate-wide
// `.ilike(email).maybeSingle()`: a second holder → PGRST116 → "no contact"
// (no sequence enrolment), and a lone holder at ANOTHER tenant was enrolled
// in THIS tenant's order_* sequence. The lookup now carries
// `.in('location_id', orgLocationIdsFor(car.location_id))` and picks the
// car's own studio first (pickContact). cars.location_id is NOT NULL (mig
// 025), so there is always a scope.
import { ilikeMatches } from '@/lib/like-escape.test-helpers'
import { triggerSequencesForOrderStatus } from '@/lib/sequences'
import { emitEvent } from '@/lib/contact-events'

function makeOrgDb({ car, locations = [], contacts = [] }) {
  const contactLookups = []
  function from(table) {
    const b = { _op: 'select', _filters: [], _limit: null, _payload: null }
    const rows = () => {
      let out = table === 'cars' ? (car ? [car] : []) : table === 'locations' ? locations : table === 'contacts' ? contacts : []
      for (const [kind, col, val] of b._filters) {
        if (kind === 'eq') out = out.filter((r) => r[col] === val)
        if (kind === 'neq') out = out.filter((r) => r[col] !== val)
        if (kind === 'in') out = out.filter((r) => val.includes(r[col]))
        if (kind === 'ilike') out = out.filter((r) => ilikeMatches(val, r[col]))
      }
      if (typeof b._limit === 'number') out = out.slice(0, b._limit)
      return out
    }
    const settle = (shape) => {
      if (b._op === 'update') return Promise.resolve({ data: null, error: null })
      if (table === 'contacts') contactLookups.push({ filters: b._filters, limit: b._limit })
      const out = rows()
      if (shape === 'single') {
        return out.length > 1
          ? Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'multiple rows' } })
          : Promise.resolve({ data: out[0] || null, error: null })
      }
      return Promise.resolve({ data: out, error: null })
    }
    b.select = () => b
    b.update = (payload) => { b._op = 'update'; b._payload = payload; return b }
    b.eq = (col, val) => { b._filters.push(['eq', col, val]); return b }
    b.neq = (col, val) => { b._filters.push(['neq', col, val]); return b }
    b.in = (col, val) => { b._filters.push(['in', col, val]); return b }
    b.ilike = (col, val) => { b._filters.push(['ilike', col, val]); return b }
    b.limit = (n) => { b._limit = n; return b }
    b.maybeSingle = () => settle('single')
    b.then = (resolve, reject) => settle('list').then(resolve, reject)
    return b
  }
  return { from, _contactLookups: contactLookups }
}

describe('POST — the buyer contact is matched inside the car\'s organisation (W0.6b)', () => {
  const LOC_CCF = 'loc-ccf'
  const LOC_CCF_2 = 'loc-ccf-2'
  const LOC_UN1T = 'loc-un1t'
  const LOCATIONS = [
    { id: LOC_CCF, organization_id: 'org-ccf' },
    { id: LOC_CCF_2, organization_id: 'org-ccf' },
    { id: LOC_UN1T, organization_id: 'org-un1t' },
  ]
  const BUYER_CAR = { ...CAR, deposit_revolut_order_id: 'ord-1', location_id: LOC_CCF, buyer_email: 'Buyer@Example.com', locations: { id: LOC_CCF, name: 'CCF' } }
  const AT_CCF = { id: 'c-ccf', location_id: LOC_CCF, email: 'buyer@example.com', created_at: '2026-02-01T00:00:00Z' }
  const AT_CCF_2 = { id: 'c-ccf-2', location_id: LOC_CCF_2, email: 'buyer@example.com', created_at: '2025-01-01T00:00:00Z' }
  const AT_UN1T = { id: 'c-un1t', location_id: LOC_UN1T, email: 'buyer@example.com', created_at: '2024-01-01T00:00:00Z' }

  beforeEach(() => {
    verifyWebhookSignature.mockReturnValue(true)
    recordWebhookEvent.mockResolvedValue({ seen: false })
    getOrder.mockResolvedValue({ state: 'completed', amount: 50000 })
  })

  it('enrols the contact at the car\'s own studio, through a location-scoped lookup', async () => {
    const db = makeOrgDb({ car: BUYER_CAR, locations: LOCATIONS, contacts: [AT_UN1T, AT_CCF] })
    createServerClient.mockReturnValue(db)

    expect((await POST(makeRequest())).status).toBe(200)

    expect(triggerSequencesForOrderStatus).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'c-ccf', locationId: LOC_CCF }))
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'c-ccf' }))
    const lookup = db._contactLookups.find((l) => l.filters.some(([k, c]) => k === 'ilike' && c === 'email'))
    expect(lookup.filters).toContainEqual(['in', 'location_id', expect.arrayContaining([LOC_CCF, LOC_CCF_2])])
    expect(lookup.filters.find(([k, c]) => k === 'in' && c === 'location_id')[2]).not.toContain(LOC_UN1T)
  })

  it('a sibling studio of the same organisation is still a match', async () => {
    const db = makeOrgDb({ car: BUYER_CAR, locations: LOCATIONS, contacts: [AT_CCF_2] })
    createServerClient.mockReturnValue(db)

    await POST(makeRequest())

    expect(triggerSequencesForOrderStatus).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'c-ccf-2' }))
  })

  it('never enrols another organisation\'s contact, even as the only holder', async () => {
    const db = makeOrgDb({ car: BUYER_CAR, locations: LOCATIONS, contacts: [AT_UN1T] })
    createServerClient.mockReturnValue(db)

    expect((await POST(makeRequest())).status).toBe(200)

    expect(triggerSequencesForOrderStatus).not.toHaveBeenCalled()
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ contactId: null, contactEmail: 'Buyer@Example.com' }))
  })

  it('two holders in the organisation no longer cancel each other out (no PGRST116 → nobody)', async () => {
    const db = makeOrgDb({ car: BUYER_CAR, locations: LOCATIONS, contacts: [AT_CCF_2, AT_CCF] })
    createServerClient.mockReturnValue(db)

    await POST(makeRequest())

    // The car's own studio beats the older sibling row.
    expect(triggerSequencesForOrderStatus).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'c-ccf' }))
  })

  it('a failed sibling read narrows to the car\'s studio, never the estate', async () => {
    const db = makeOrgDb({ car: BUYER_CAR, locations: [], contacts: [AT_UN1T, AT_CCF_2] })
    createServerClient.mockReturnValue(db)

    await POST(makeRequest())

    expect(triggerSequencesForOrderStatus).not.toHaveBeenCalled()
    const lookup = db._contactLookups.find((l) => l.filters.some(([k, c]) => k === 'ilike' && c === 'email'))
    expect(lookup.filters).toContainEqual(['in', 'location_id', [LOC_CCF]])
  })
})

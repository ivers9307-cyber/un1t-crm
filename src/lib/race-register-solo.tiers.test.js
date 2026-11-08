// TIERS.1 — Mia's solo booking door prices the tier like the public route:
// a paid tier is quoted at the tier price (requires_payment carries it), a
// free entry stamps the tier it took, and a failed tier read never books.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from './event-waitlist.test-helpers'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('./member-validation', async (importOriginal) => ({
  ...(await importOriginal()),
  validateTeamRoster: vi.fn(async ({ members }) => members.map((m) => ({ name: m.name, email: m.email, is_member: false, member_contact_id: null, status: 'not_found' }))),
}))
vi.mock('./race-payments', () => ({ createRacePayment: vi.fn(async () => ({ payment: { id: 'p1' }, checkout: { free: true } })) }))
vi.mock('./race-confirmations', () => ({ sendRaceConfirmations: vi.fn() }))

const { registerSoloEventEntry } = await import('./race-register-solo.js')

const early = { id: 'early', name: 'Early bird', price_cents: 2500, capacity: 20 }
const race = {
  id: 'e1', location_id: 'L1', name: 'Mobility', slug: 'mob', race_date: '2026-12-05', kind: 'workshop', capacity_mode: 'people',
  active: true, status: 'published', registration_opens_at: null, registration_closes_at: null,
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 3500, members_only: false, payment_currency: 'EUR',
  waves: [{ id: 'w1', start_time: '10:00:00', capacity: null, label: null }],
  pricing_tiers: [early],
}
const contact = { id: 'c1', name: 'Aoife Byrne', email: 'aoife@example.test', phone: '+3531' }

let tierReadError = null
beforeEach(() => { tierReadError = null })

function db() {
  return fakeDb((q) => {
    if (q.table === 'race_registrations' && q.ops.some((o) => o[0] === 'not' && o[1] === 'pricing_tier_id')) {
      return tierReadError ? { data: null, error: tierReadError } : { data: [], error: null }
    }
    if (q.table === 'race_registrations' && q.action === 'insert') return { data: { id: 'r1', registered_at: '2026-11-15T12:00:00Z' }, error: null }
    if (q.table === 'teams' && q.action === 'select') return { data: null, error: null }
    if (q.table === 'teams' && q.action === 'insert') return { data: { id: 't1' }, error: null }
    return { data: null, error: null }
  })
}

describe('registerSoloEventEntry — tiers', () => {
  it('quotes the tier total for requires_payment, not the base', async () => {
    const r = await registerSoloEventEntry(db(), { race, waveId: null, contact })
    expect(r).toMatchObject({ ok: false, reason: 'requires_payment', totalCents: 2500 })
  })
  it('a free tier books and stamps the tier id on the entry', async () => {
    const d = db()
    const r = await registerSoloEventEntry(d, { race: { ...race, non_member_fee_cents: 3500, pricing_tiers: [{ ...early, price_cents: 0 }] }, waveId: null, contact })
    expect(r).toMatchObject({ ok: true, registrationId: 'r1' })
    const ins = d.queries.find((q) => q.table === 'race_registrations' && q.action === 'insert')
    expect(ins.payload.pricing_tier_id).toBe('early')
  })
  it('a failed tier read never books: pricing_unavailable', async () => {
    tierReadError = { message: 'timeout' }
    const d = db()
    const r = await registerSoloEventEntry(d, { race, waveId: null, contact })
    expect(r).toMatchObject({ ok: false, reason: 'pricing_unavailable' })
    expect(d.queries.some((q) => q.action === 'insert')).toBe(false)
  })
})

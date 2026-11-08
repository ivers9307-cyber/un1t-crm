// TIERS.1 — the public register route prices the tier: the charge is the
// tier price, the entry is stamped with the tier id, the response names it,
// and a failed tier read answers 503 with nothing inserted.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

const W1 = 'f0000000-0000-4000-8000-0000000000f1'
let db
let race
let tierReadError = null
let soldRows = []
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })), getClientIp: vi.fn(() => '1.2.3.4'), rateLimitResponse: vi.fn() }))
vi.mock('@/lib/race-payments', () => ({
  createRacePayment: vi.fn(async ({ pricing }) => ({ payment: { id: 'p1', status: 'pending', amount_cents: pricing.total_cents }, checkout: { free: pricing.total_cents === 0, token: 'tok', url: 'https://pay.test/x' } })),
  refreshRacePaymentFromProvider: vi.fn(),
}))
vi.mock('@/lib/race-confirmations', () => ({ sendRaceConfirmations: vi.fn() }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: vi.fn(async () => 'c1') }))
vi.mock('@/lib/sequences', () => ({ triggerSequencesForRaceRegistered: vi.fn() }))
vi.mock('@/lib/marketing-consent', () => ({ applyFormMarketingConsent: vi.fn() }))
vi.mock('@/lib/contact-tags', () => ({ writeContactTags: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/location-branding', () => ({ getLocationOrgBrandName: vi.fn(async () => 'UN1T') }))
vi.mock('@/lib/event-waitlist', () => ({
  claimWaitlistOnRegistration: vi.fn(async () => ({ claimed: false, reason: 'invalid_token' })),
  claimWaitlistByEmail: vi.fn(async () => ({ claimed: false, reason: 'not_on_list' })),
}))

const { createRacePayment } = await import('@/lib/race-payments')
const { POST } = await import('./route.js')

const early = { id: 'early', name: 'Early bird', price_cents: 2500, capacity: 20 }
const RACE = {
  id: 'e1', location_id: 'L1', name: 'Mobility', slug: 'mob', race_date: '2026-12-05', kind: 'workshop', capacity_mode: 'people',
  allowed_team_sizes: [1, 2, 3, 4], find_team: null, registration_opens_at: null, registration_closes_at: null, active: true, status: 'published',
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 3500, members_only: false, payment_currency: 'EUR',
  create_in_glofox: false, host_id: null, entry_policy: null, pricing_tiers: [early],
  waves: [{ id: W1, start_time: '10:00:00', capacity: null, label: null }],
}
const isTierRead = (q) => q.table === 'race_registrations' && q.ops.some((o) => o[0] === 'not' && o[1] === 'pricing_tier_id')

function registerDb() {
  return fakeDb((q) => {
    if (q.table === 'race_events') return { data: race, error: null }
    if (q.table === 'teams') {
      if (q.action === 'select') return { data: null, error: null }
      if (q.action === 'insert') return { data: { id: 't-new' }, error: null }
      return { data: null, error: null }
    }
    if (q.table === 'race_payments') return { data: null, error: null }
    if (q.table === 'race_registrations') {
      if (isTierRead(q)) return tierReadError ? { data: null, error: tierReadError } : { data: soldRows, error: null }
      if (q.action === 'insert') return { data: { id: 'reg1', registered_at: '2026-11-15T12:00:00Z', wave_id: W1, contact_id: 'c1' }, error: null }
      if (q.ops.some((o) => o[0] === 'select' && o[2]?.head)) return { data: null, count: 0, error: null }
      return { data: [], error: null }
    }
    return { data: null, error: null }
  })
}
const BODY = { team_name: 'Aoife', team_size: 1, wave_id: W1, captain_name: 'Aoife Byrne', captain_email: 'aoife@example.test', captain_phone: '0870000000', members: [] }
const post = (body) => POST(
  new Request('https://crm.test/api/public/events/mob/register', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ slug: 'mob' }) },
)

beforeEach(() => {
  vi.clearAllMocks()
  race = RACE
  tierReadError = null
  soldRows = []
  db = registerDb()
})

describe('register route: pricing tiers', () => {
  it('charges the tier price, stamps the tier on the entry and names it in the response', async () => {
    const res = await post(BODY)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.data.pricing).toMatchObject({ total_cents: 2500, non_member_fee_cents: 2500, tier: { id: 'early', name: 'Early bird' } })
    expect(createRacePayment.mock.calls[0][0].pricing.total_cents).toBe(2500)
    const ins = db.queries.find((q) => q.table === 'race_registrations' && q.action === 'insert')
    expect(ins.payload.pricing_tier_id).toBe('early')
  })
  it('a sold-out tier falls through to the base price, with no tier stamped', async () => {
    soldRows = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, status: 'confirmed', registered_at: '2026-11-01T00:00:00Z', pricing_tier_id: 'early', team: { size: 1 } }))
    const res = await post(BODY)
    const json = await res.json()
    expect(json.data.pricing).toMatchObject({ total_cents: 3500, tier: null })
    expect(db.queries.find((q) => q.table === 'race_registrations' && q.action === 'insert').payload.pricing_tier_id).toBeNull()
  })
  it('a failed tier read is 503 pricing_unavailable and inserts nothing', async () => {
    tierReadError = { message: 'timeout' }
    const res = await post(BODY)
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('pricing_unavailable')
    // The team row may exist (it is found-or-created before pricing, as for
    // every other refusal after that point); no ENTRY is written.
    expect(db.queries.some((q) => q.table === 'race_registrations' && q.action === 'insert')).toBe(false)
    expect(db.queries.some((q) => q.table === 'team_members' && q.action === 'insert')).toBe(false)
  })
  it('an event without tiers never reads the sold count', async () => {
    race = { ...RACE, pricing_tiers: null }
    await post(BODY)
    expect(db.queries.some(isTierRead)).toBe(false)
  })
})

// TIERS.1 — the public event payload carries a `pricing` block (current tier,
// what follows, the group price) and NEVER the raw tier list, a sold count, a
// capacity or a spots-left figure. A failed sold-count read degrades to the
// base price, never a failed page.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })), getClientIp: vi.fn(() => '1.2.3.4'), rateLimitResponse: vi.fn() }))
vi.mock('@/lib/location-branding', () => ({ getOrgBrandName: vi.fn().mockResolvedValue('UN1T Dublin') }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))

const { GET } = await import('./route.js')

const early = { id: 'early', name: 'Early bird', price_cents: 2500, capacity: 20 }
const group = { id: 'group', name: 'Groups', price_cents: 2800, min_people: 3 }
const race = (over = {}) => ({
  id: 'ev1', name: 'Mobility', slug: 'mob', description: null, race_date: '2026-12-05', kind: 'workshop', capacity_mode: 'people',
  registration_opens_at: null, registration_closes_at: null, allowed_team_sizes: [1, 2, 3, 4], location_id: 'LOC1',
  venue_name: 'Studio 1', venue_address: null, member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 3500,
  members_only: false, payment_currency: 'EUR', hero_image_url: null, accent_hex: null, active: true, status: 'published',
  charity_enabled: false, charity: null, find_team: null, host_id: null, pricing_tiers: [early, group],
  waves: [{ id: 'w1', start_time: '10:00:00', capacity: null, label: null, display_order: 0 }],
  locations: { id: 'LOC1', name: 'UN1T Stillorgan', address: '1 Road', timezone: 'Europe/Dublin', is_host_anchor: false, organization_id: 'org-1' },
  host: null,
  ...over,
})
const isTierRead = (q) => q.table === 'race_registrations' && q.ops.some((o) => o[0] === 'not' && o[1] === 'pricing_tier_id')
let soldRows = []
let tierReadError = null
function makeDb(row) {
  return fakeDb((q) => {
    if (q.table === 'race_events') return { data: row, error: null }
    if (isTierRead(q)) return tierReadError ? { data: null, error: tierReadError } : { data: soldRows, error: null }
    return { data: [], error: null, count: 0 }
  })
}
const get = () => GET(new Request('http://x/api/public/events/mob'), { params: Promise.resolve({ slug: 'mob' }) })

beforeEach(() => { vi.clearAllMocks(); soldRows = []; tierReadError = null })

describe('GET /api/public/events/[slug] — pricing tiers', () => {
  it('carries the current tier, the next price and the group price, never the tier list or a count', async () => {
    db = makeDb(race())
    const body = await (await get()).json()
    expect(body.data.pricing).toEqual({
      base_cents: 3500,
      current: { id: 'early', name: 'Early bird', price_cents: 2500, ends_at: null, limited: true },
      next: null,
      group: { min_people: 3, price_cents: 2800 },
    })
    expect(body.data).not.toHaveProperty('pricing_tiers')
    expect(JSON.stringify(body)).not.toMatch(/"sold|spots_left|"capacity"/)
  })
  it('a sold-out early bird is not current', async () => {
    soldRows = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, status: 'confirmed', registered_at: '2026-11-01T00:00:00Z', pricing_tier_id: 'early', team: { size: 1 } }))
    db = makeDb(race())
    const body = await (await get()).json()
    expect(body.data.pricing.current).toBeNull()
  })
  it('a failed sold read shows the base price and still answers the page', async () => {
    tierReadError = { message: 'timeout' }
    db = makeDb(race())
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.pricing).toEqual({ base_cents: 3500, current: null, next: null, group: null })
  })
  it('an event without tiers reads no sold count and reports base only', async () => {
    db = makeDb(race({ pricing_tiers: null }))
    const body = await (await get()).json()
    expect(body.data.pricing).toEqual({ base_cents: 3500, current: null, next: null, group: null })
    expect(db.queries.some(isTierRead)).toBe(false)
  })
})

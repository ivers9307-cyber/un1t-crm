// EVENT-COPY.1 — the PUBLIC surface, which is where this defect has the most
// traffic.
//
// The comms modules stopped rendering the ops-only anchor label ("<host> (host
// events)") to customers, but /event/[slug] and /embed/event/[slug] render it
// through RaceSignupWidget, which does `race.venue_name || location?.name` and
// CANNOT judge the row — it is a client component and this endpoint is all it
// sees. A staff-created host event with no venue name would put an internal
// bookkeeping string on a public page.
//
// Fixed server-side rather than in the widget on purpose: this is a public
// endpoint, so the internal label should not be in the RESPONSE, never mind on
// the page.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: vi.fn(() => '1.2.3.4'),
  rateLimitResponse: vi.fn(),
}))

const createServerClient = vi.fn()
vi.mock('@/lib/supabase', () => ({ createServerClient: (...a) => createServerClient(...a) }))

vi.mock('@/lib/location-branding', () => ({
  getOrgBrandName: vi.fn().mockResolvedValue('UN1T Dublin'),
}))

import { GET } from './route.js'

const ANCHOR = {
  id: 'ANCHOR',
  name: 'Pride Training Club (host events)',
  address: null,
  timezone: 'Europe/Dublin',
  is_host_anchor: true,
}
const STILLORGAN = {
  id: 'LOC1',
  name: 'UN1T Stillorgan',
  address: '1 Somewhere Road',
  timezone: 'Europe/Dublin',
  is_host_anchor: false,
  organization_id: 'org-1',
}

function makeDb(race) {
  return {
    from(table) {
      const b = {}
      for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b
      b.single = async () => ({ data: race, error: null })
      b.maybeSingle = async () => ({ data: null, error: null })
      b.insert = async () => ({ error: null })
      if (table === 'race_registrations') {
        b.limit = async () => ({ data: [], error: null })
        b.select = () => b
      }
      return b
    },
  }
}

function makeRace(overrides = {}) {
  return {
    id: 'ev1', name: 'Hyrox Sim', slug: 'hyrox', description: null,
    race_date: '2026-09-20', kind: 'race', capacity_mode: 'teams',
    registration_opens_at: null, registration_closes_at: null,
    allowed_team_sizes: [1], location_id: 'ANCHOR',
    venue_name: null, venue_address: null,
    member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 1000,
    members_only: false, payment_currency: 'EUR',
    hero_image_url: null, accent_hex: null, active: true, status: 'published',
    host_id: 'H', host_status: 'approved',
    waves: [],
    locations: { ...ANCHOR },
    ...overrides,
  }
}

const props = { params: Promise.resolve({ slug: 'hyrox' }) }
const req = new Request('http://x/api/public/events/hyrox')

beforeEach(() => vi.clearAllMocks())

describe('GET /api/public/events/[slug] — the anchor label never leaves the building', () => {
  it('THE DEFECT: a host event with no venue name does not expose "(host events)"', async () => {
    createServerClient.mockImplementation(() => makeDb(makeRace()))

    const res = await GET(req, props)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(JSON.stringify(body)).not.toContain('(host events)')
    // An omitted venue beats an internal string — the widget renders null as
    // "no venue line", which is the honest answer when we genuinely have none.
    expect(body.data.venue_name).toBeNull()
    expect(body.data.locations.name).toBeNull()
    expect(body.data.locations.address).toBeNull()
  })

  it('keeps the real venue name when the host supplied one', async () => {
    createServerClient.mockImplementation(() => makeDb(makeRace({ venue_name: 'The Church Gym' })))

    const body = await (await GET(req, props)).json()

    expect(body.data.venue_name).toBe('The Church Gym')
    expect(JSON.stringify(body)).not.toContain('(host events)')
  })

  it('leaves a REAL location completely alone — name, address and all', async () => {
    createServerClient.mockImplementation(() =>
      makeDb(makeRace({ location_id: 'LOC1', host_id: null, locations: { ...STILLORGAN } })))

    const body = await (await GET(req, props)).json()

    expect(body.data.venue_name).toBe('UN1T Stillorgan')
    expect(body.data.locations.name).toBe('UN1T Stillorgan')
    expect(body.data.locations.address).toBe('1 Somewhere Road')
  })

  it('never leaks the internal is_host_anchor flag to a public caller', async () => {
    createServerClient.mockImplementation(() =>
      makeDb(makeRace({ location_id: 'LOC1', host_id: null, locations: { ...STILLORGAN } })))

    const body = await (await GET(req, props)).json()

    expect(body.data.locations).not.toHaveProperty('is_host_anchor')
  })

  // HOST-CONSENT.1 — the org brand name for the two-consent sentence comes
  // from getOrgBrandName (operator-editable org_settings.company_name), not
  // organizations.name. host_name/organization_name land on `data`, and
  // organization_id + the raw host object never leave the response.
  it('surfaces host_name + the operator-editable org brand, and strips organization_id/host', async () => {
    createServerClient.mockImplementation(() =>
      makeDb(makeRace({
        location_id: 'LOC1',
        host_id: 'H',
        locations: { ...STILLORGAN },
        host: { name: 'Pride Training Club' },
      })))

    const body = await (await GET(req, props)).json()

    expect(body.data.host_name).toBe('Pride Training Club')
    expect(body.data.organization_name).toBe('UN1T Dublin')
    expect(body.data.locations).not.toHaveProperty('organization_id')
    expect(body.data).not.toHaveProperty('host')
  })
})

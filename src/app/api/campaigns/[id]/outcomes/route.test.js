// GAPS-P2 — the outcome route.
//
// The load-bearing assertions here are not "does it return numbers". They are:
//   • the tenant guard runs BEFORE any outcome data is read (404, never 403);
//   • the control cohort is always present, because a bare attributed number
//     is a correlation dressed as a result;
//   • the window is echoed back, because two runs of this join disagreed
//     purely on window choice — a number without its window is not a
//     measurement;
//   • an out-of-range window falls back rather than reaching the database.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const STILLORGAN = 'a0000000-0000-0000-0000-000000000001'
const OTHER_LOC = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'
const CAMPAIGN = 'c0000000-0000-0000-0000-0000000000c1'

let rpcCalls = []
let campaignRow = { id: CAMPAIGN, location_id: STILLORGAN }
let rpcRows = []
let rpcError = null

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1' })),
  assertLocationAccessOr404: vi.fn((_user, locationId) =>
    locationId === STILLORGAN
      ? null
      : new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
  ),
}))

vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: campaignRow, error: campaignRow ? null : { message: 'no rows' } }) }),
      }),
    }),
    rpc: async (fn, args) => {
      rpcCalls.push([fn, args])
      return { data: rpcRows, error: rpcError }
    },
  }),
}))

import { GET, parseWindowDays, buildOutcomeComparison } from './route.js'

const req = (qs = '') => new Request(`http://localhost/api/campaigns/${CAMPAIGN}/outcomes${qs}`)
const props = { params: { id: CAMPAIGN } }

// The real Nutrable numbers, measured live: the clicked cohort registered for
// events at 11.1% vs 0%, but attended classes at 11.1% vs 9.2%.
const REAL_ROWS = [
  { cohort: 'clicked', contacts: 45, event_registrations: 5, class_attendances: 5, purchases: 0, purchase_cents: 0 },
  { cohort: 'not_opened', contacts: 348, event_registrations: 0, class_attendances: 32, purchases: 0, purchase_cents: 0 },
]

beforeEach(() => {
  rpcCalls = []
  campaignRow = { id: CAMPAIGN, location_id: STILLORGAN }
  rpcRows = REAL_ROWS
  rpcError = null
})

describe('GET /api/campaigns/[id]/outcomes (GAPS-P2)', () => {
  it('returns both cohorts, so an attributed number is never shown alone', async () => {
    const res = await GET(req(), props)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.data.clicked.contacts).toBe(45)
    expect(json.data.not_opened.contacts).toBe(348)
  })

  it('computes the rates that make the control meaningful', async () => {
    const { data } = await (await GET(req(), props)).json()
    // A real effect: 11.1% vs 0%.
    expect(data.clicked.rates.event_registrations).toBeCloseTo(5 / 45, 5)
    expect(data.not_opened.rates.event_registrations).toBe(0)
    // Noise: 11.1% vs 9.2% — members attend classes anyway.
    expect(data.clicked.rates.class_attendances).toBeCloseTo(5 / 45, 5)
    expect(data.not_opened.rates.class_attendances).toBeCloseTo(32 / 348, 5)
  })

  it('echoes the window it used', async () => {
    const { data } = await (await GET(req('?window_days=14'), props)).json()
    expect(data.window_days).toBe(14)
    expect(rpcCalls[0]).toEqual(['campaign_outcome_stats', { p_campaign_id: CAMPAIGN, p_window_days: 14 }])
  })

  it('defaults the window to 7 days', async () => {
    const { data } = await (await GET(req(), props)).json()
    expect(data.window_days).toBe(7)
  })

  it('falls back on a nonsense or out-of-range window instead of passing it through', async () => {
    for (const qs of ['?window_days=0', '?window_days=999', '?window_days=abc', '?window_days=7.5']) {
      rpcCalls = []
      const { data } = await (await GET(req(qs), props)).json()
      expect(data.window_days).toBe(7)
      expect(rpcCalls[0][1].p_window_days).toBe(7)
    }
  })

  it('404s a campaign at another location, and reads NO outcome data', async () => {
    campaignRow = { id: CAMPAIGN, location_id: OTHER_LOC }
    const res = await GET(req(), props)
    expect(res.status).toBe(404)
    expect(rpcCalls).toEqual([])
  })

  it('404s a missing campaign the same way (ids are not enumerable)', async () => {
    campaignRow = null
    const res = await GET(req(), props)
    expect(res.status).toBe(404)
    expect(rpcCalls).toEqual([])
  })

  it('does not leak the database error when the RPC fails', async () => {
    rpcError = { message: 'relation "secret" does not exist' }
    const res = await GET(req(), props)
    const json = await res.json()
    expect(res.status).toBe(500)
    expect(JSON.stringify(json)).not.toMatch(/relation|secret/)
  })

  it('never returns contact ids — aggregates only', async () => {
    const json = await (await GET(req(), props)).json()
    expect(JSON.stringify(json)).not.toMatch(/contact_id/)
  })
})

describe('buildOutcomeComparison', () => {
  it('yields null rates rather than dividing by zero on an empty cohort', () => {
    const out = buildOutcomeComparison([{ cohort: 'clicked', contacts: 0 }], 7)
    expect(out.clicked.contacts).toBe(0)
    expect(out.clicked.rates.event_registrations).toBeNull()
  })

  it('fills in a cohort the RPC omitted entirely', () => {
    const out = buildOutcomeComparison([{ cohort: 'clicked', contacts: 3, event_registrations: 1 }], 7)
    expect(out.not_opened.contacts).toBe(0)
    expect(out.not_opened.event_registrations).toBe(0)
  })
})

describe('parseWindowDays', () => {
  it('accepts the documented range and rejects everything else', () => {
    expect(parseWindowDays('1')).toBe(1)
    expect(parseWindowDays('90')).toBe(90)
    expect(parseWindowDays('91')).toBe(7)
    expect(parseWindowDays(null)).toBe(7)
  })
})

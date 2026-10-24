// CHARITY.4 — the public event read carries a resolved `charity` block.
// Absent when the event is not enabled; the raw settings never leave the
// server; totals keys appear only when the operator shows the total; a failed
// totals read omits them rather than 500ing the page.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: vi.fn(() => '1.2.3.4'),
  rateLimitResponse: vi.fn(),
}))
vi.mock('@/lib/location-branding', () => ({
  getOrgBrandName: vi.fn().mockResolvedValue('UN1T Dublin'),
}))
const logWarn = vi.fn()
vi.mock('@/lib/log', () => ({ logWarn: (...a) => logWarn(...a), logError: vi.fn() }))

const createServerClient = vi.fn()
vi.mock('@/lib/supabase', () => ({ createServerClient: (...a) => createServerClient(...a) }))

import { GET } from './route.js'

// Every query chain is a thenable that resolves to the table's canned result.
function makeDb(race, results = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const b = {}
      const result = results[table] || { data: [], error: null, count: 0 }
      for (const m of ['select', 'eq', 'order', 'limit', 'range']) {
        b[m] = (...args) => { calls.push({ table, m, args }); return b }
      }
      b.single = async () => ({ data: race, error: null })
      b.maybeSingle = async () => ({ data: null, error: null })
      b.insert = async () => ({ error: null })
      b.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
      return b
    },
  }
}

function makeRace(overrides = {}) {
  return {
    id: 'ev1', name: 'Hyrox Sim', slug: 'hyrox', description: null,
    race_date: '2026-09-20', kind: 'race', capacity_mode: 'teams',
    registration_opens_at: null, registration_closes_at: null,
    allowed_team_sizes: [1], location_id: 'LOC1',
    venue_name: 'Gym', venue_address: null,
    member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 1000,
    members_only: false, payment_currency: 'EUR',
    hero_image_url: null, accent_hex: null, active: true, status: 'published',
    host_id: null, host_status: null,
    waves: [],
    locations: { id: 'LOC1', name: 'UN1T Stillorgan', address: 'x', timezone: 'Europe/Dublin', is_host_anchor: false, organization_id: 'org-1' },
    charity_enabled: false,
    charity: null,
    ...overrides,
  }
}

const DONATIONS = [
  { amount_cents: 2500, match_multiplier: 2, status: 'paid' },
  { amount_cents: 1000, match_multiplier: 1, status: 'paid' },
]
const ENTRIES = [{ amount_cents: 5000, status: 'completed' }]

const props = { params: Promise.resolve({ slug: 'hyrox' }) }
const req = new Request('http://x/api/public/events/hyrox')
const get = async (race, results) => {
  const db = makeDb(race, results)
  createServerClient.mockImplementation(() => db)
  const res = await GET(req, props)
  return { res, body: await res.json(), db }
}

beforeEach(() => vi.clearAllMocks())

describe('GET /api/public/events/[slug] — charity block', () => {
  it('omits charity entirely, and never reads donations, when the event is not enabled', async () => {
    const { res, body, db } = await get(makeRace({ charity_enabled: false, charity: { name: 'Pieta' } }))
    expect(res.status).toBe(200)
    expect('charity' in body.data).toBe(false)
    expect(body.data).not.toHaveProperty('charity_enabled')
    expect(db.calls.some((c) => c.table === 'donations' || c.table === 'race_payments')).toBe(false)
  })

  it('emits the resolved block with matched totals and never leaks the raw settings', async () => {
    const { body, db } = await get(
      makeRace({
        charity_enabled: true,
        charity: { name: 'Pieta', match_multiplier: 2, include_entries: true, receipt_subject: 'PRIVATE', receipt_intro: 'PRIVATE' },
      }),
      {
        donations: { data: DONATIONS, error: null },
        race_payments: { data: ENTRIES, error: null },
        race_registrations: { data: null, error: null, count: 7 },
      },
    )
    const c = body.data.charity
    expect(c).toMatchObject({ enabled: true, name: 'Pieta', match_multiplier: 2, show_total: true })
    expect(c.raised_cents).toBe(16000) // donations 5000+1000 matched = 6000, entries 5000x2 = 10000
    expect(c.donation_count).toBe(2)
    expect(c.team_count).toBe(7)
    expect(c).not.toHaveProperty('entries_matched_cents')
    expect(c).not.toHaveProperty('include_entries')
    expect(c).not.toHaveProperty('receipt_subject')
    expect(c).not.toHaveProperty('receipt_intro')
    expect(body.data).not.toHaveProperty('charity_enabled')
    expect(JSON.stringify(body)).not.toContain('PRIVATE')
    // reads are scoped to this event and capped
    expect(db.calls).toContainEqual({ table: 'donations', m: 'eq', args: ['race_event_id', 'ev1'] })
    expect(db.calls).toContainEqual({ table: 'donations', m: 'eq', args: ['location_id', 'LOC1'] })
    expect(db.calls).toContainEqual({ table: 'donations', m: 'eq', args: ['status', 'paid'] })
    expect(db.calls).toContainEqual({ table: 'donations', m: 'range', args: [0, 999] })
    expect(db.calls).toContainEqual({ table: 'race_payments', m: 'eq', args: ['status', 'completed'] })
    expect(db.calls).toContainEqual({ table: 'race_payments', m: 'range', args: [0, 999] })
  })

  it('leaves entries out of the total, and does not read them, when include_entries is off', async () => {
    const { body, db } = await get(
      makeRace({ charity_enabled: true, charity: { match_multiplier: 2, include_entries: false } }),
      {
        donations: { data: DONATIONS, error: null },
        race_payments: { data: ENTRIES, error: null },
        race_registrations: { data: null, error: null, count: 3 },
      },
    )
    expect(body.data.charity.raised_cents).toBe(6000)
    expect(db.calls.some((c) => c.table === 'race_payments')).toBe(false)
  })

  it('has no totals keys when show_total is off, and skips the totals reads', async () => {
    const { body, db } = await get(
      makeRace({ charity_enabled: true, charity: { show_total: false } }),
      { donations: { data: DONATIONS, error: null } },
    )
    expect(body.data.charity.enabled).toBe(true)
    expect(body.data.charity).not.toHaveProperty('raised_cents')
    expect(body.data.charity).not.toHaveProperty('donation_count')
    expect(body.data.charity).not.toHaveProperty('team_count')
    expect(db.calls.some((c) => c.table === 'donations' || c.table === 'race_payments')).toBe(false)
  })

  it('applies defaults when charity is null', async () => {
    const { body } = await get(
      makeRace({ charity_enabled: true, charity: null }),
      { donations: { data: [], error: null }, race_payments: { data: [], error: null }, race_registrations: { data: null, error: null, count: 0 } },
    )
    const c = body.data.charity
    expect(c.min_cents).toBe(500)
    expect(c.max_cents).toBe(500000)
    expect(c.presets_cents).toEqual([1000, 2500, 5000, 10000])
    expect(c.custom_allowed).toBe(true)
    expect(c.match_multiplier).toBe(1)
    expect(c.goal_cents).toBeNull()
    expect(c.raised_cents).toBe(0)
    expect(c.donation_count).toBe(0)
    expect(c.team_count).toBe(0)
  })

  it('omits the totals and logs, rather than 500ing, when a totals read fails', async () => {
    const { res, body } = await get(
      makeRace({ charity_enabled: true, charity: null }),
      {
        donations: { data: null, error: { message: 'boom' } },
        race_payments: { data: ENTRIES, error: null },
        race_registrations: { data: null, error: null, count: 4 },
      },
    )
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.charity.enabled).toBe(true)
    expect(body.data.charity).not.toHaveProperty('raised_cents')
    expect(body.data.charity).not.toHaveProperty('donation_count')
    expect(body.data.charity).not.toHaveProperty('team_count')
    expect(logWarn).toHaveBeenCalledWith('public-event', expect.any(String), expect.anything())
  })

  it('exposes the operator video as an embeddable { provider, embedUrl }, never the raw link (CHARITY.13)', async () => {
    const { body } = await get(
      makeRace({ charity_enabled: true, charity: { show_total: false, video_url: 'https://youtu.be/abc123' } }),
    )
    expect(body.data.charity.video).toEqual({ provider: 'youtube', embedUrl: 'https://www.youtube.com/embed/abc123' })
    expect(body.data.charity).not.toHaveProperty('video_url')
  })

  it('video is null when no link is set', async () => {
    const { body } = await get(makeRace({ charity_enabled: true, charity: { show_total: false } }))
    expect(body.data.charity.video).toBeNull()
  })

  it('an uploaded file wins over the link and carries the hero image as its poster (CHARITY.14)', async () => {
    const FILE = 'https://iyvtbjjxdggiadzwwvdj.supabase.co/storage/v1/object/public/branding/race-video/ev-1/abc.mp4'
    const { body } = await get(
      makeRace({ charity_enabled: true, hero_image_url: 'https://x/hero.png', charity: { show_total: false, video_url: 'https://youtu.be/abc123', video_file_url: FILE } }),
    )
    expect(body.data.charity.video).toEqual({ provider: 'file', src: FILE, poster: 'https://x/hero.png' })
    expect(body.data.charity).not.toHaveProperty('video_file_url')
  })
})

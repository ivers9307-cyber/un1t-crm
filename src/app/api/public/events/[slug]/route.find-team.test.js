// FINDTEAM.3 — the public event read exposes the "find me a team" option only
// when the event is a race that has switched it on, never leaks the raw
// settings, and a solo looking for a team never fills a teams-mode wave.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: vi.fn(() => '1.2.3.4'),
  rateLimitResponse: vi.fn(),
}))
vi.mock('@/lib/location-branding', () => ({
  getOrgBrandName: vi.fn().mockResolvedValue('UN1T Dublin'),
}))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))

const createServerClient = vi.fn()
vi.mock('@/lib/supabase', () => ({ createServerClient: (...a) => createServerClient(...a) }))

import { GET } from './route.js'

function makeDb(race, count = 0) {
  const calls = []
  return {
    calls,
    from(table) {
      const b = {}
      const result = { data: [], error: null, count }
      for (const m of ['select', 'eq', 'order', 'limit', 'range']) {
        b[m] = (...args) => { calls.push({ table, m, args }); return b }
      }
      b.single = async () => ({ data: race, error: null })
      b.maybeSingle = async () => ({ data: null, error: null })
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
    allowed_team_sizes: [2, 4], location_id: 'LOC1',
    venue_name: 'Gym', venue_address: null,
    member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 1000,
    members_only: false, payment_currency: 'EUR',
    hero_image_url: null, accent_hex: null, active: true, status: 'published',
    host_id: null, host_status: null,
    waves: [{ id: 'w1', start_time: '11:00:00', capacity: 10, label: null, display_order: 0 }],
    locations: { id: 'LOC1', name: 'UN1T Stillorgan', address: 'x', timezone: 'Europe/Dublin', is_host_anchor: false, organization_id: 'org-1' },
    charity_enabled: false,
    charity: null,
    find_team: null,
    ...overrides,
  }
}

const props = { params: Promise.resolve({ slug: 'hyrox' }) }
const req = new Request('http://x/api/public/events/hyrox')
const get = async (race, count) => {
  const db = makeDb(race, count)
  createServerClient.mockImplementation(() => db)
  const res = await GET(req, props)
  return { res, body: await res.json(), db }
}

beforeEach(() => vi.clearAllMocks())

describe('GET /api/public/events/[slug] — find_team', () => {
  it('emits { enabled, label, blurb } with defaults when a race has it switched on', async () => {
    const { body } = await get(makeRace({ find_team: { enabled: true } }))
    expect(body.data.find_team.enabled).toBe(true)
    expect(body.data.find_team.label).toBe('Find me a team')
    expect(body.data.find_team.blurb).toMatch(/No team/)
    expect(Object.keys(body.data.find_team).sort()).toEqual(['blurb', 'enabled', 'label'])
  })

  it('uses the operator\'s label and blurb, and leaks none of the other copy', async () => {
    const { body } = await get(makeRace({
      find_team: { enabled: true, label: 'Team me up', blurb: 'We pair solos.', confirmation_paragraph: 'PRIVATE-A', placed_subject: 'PRIVATE-B', placed_intro: 'PRIVATE-C' },
    }))
    expect(body.data.find_team).toEqual({ enabled: true, label: 'Team me up', blurb: 'We pair solos.' })
    expect(JSON.stringify(body)).not.toContain('PRIVATE')
  })

  it('is absent when not enabled (null, or enabled false), with no raw settings in the payload', async () => {
    const off = await get(makeRace({ find_team: null }))
    expect('find_team' in off.body.data).toBe(false)
    const disabled = await get(makeRace({ find_team: { enabled: false, label: 'PRIVATE' } }))
    expect('find_team' in disabled.body.data).toBe(false)
    expect(JSON.stringify(disabled.body)).not.toContain('PRIVATE')
  })

  it('is absent for a non-race kind even when the settings say enabled', async () => {
    const { body } = await get(makeRace({ kind: 'workshop', find_team: { enabled: true } }))
    expect('find_team' in body.data).toBe(false)
  })

  it('selects find_team from race_events', async () => {
    const { db } = await get(makeRace())
    const sel = db.calls.find((c) => c.table === 'race_events' && c.m === 'select')
    expect(sel.args[0]).toMatch(/\bfind_team\b/)
  })

  it('a teams-mode wave\'s is_full count ignores solos: the count query carries looking_for_team = false', async () => {
    const { body, db } = await get(makeRace(), 10)
    const regCalls = db.calls.filter((c) => c.table === 'race_registrations')
    expect(regCalls).toContainEqual({ table: 'race_registrations', m: 'eq', args: ['looking_for_team', false] })
    expect(regCalls).toContainEqual({ table: 'race_registrations', m: 'eq', args: ['status', 'confirmed'] })
    expect(body.data.waves[0].is_full).toBe(true)
  })
})

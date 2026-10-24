// FINDTEAM.3 — the register route accepts `find_team: true`: a solo entrant is
// stored as a team of one flagged looking_for_team, takes no team slot in a
// `teams`-capacity wave, and the option is refused on events that don't offer it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb, eqOf } from '@/lib/event-waitlist.test-helpers'

const W1 = 'f0000000-0000-4000-8000-0000000000f1'
let db
let race
let countInWave = 0
let waveRegs = []
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: vi.fn(() => '1.2.3.4'),
  rateLimitResponse: vi.fn(),
}))
vi.mock('@/lib/race-payments', () => ({
  createRacePayment: vi.fn(async () => ({ payment: { id: 'p1', status: 'pending' }, checkout: { free: false, token: 'tok', url: 'https://pay.test/x' } })),
  refreshRacePaymentFromProvider: vi.fn(),
}))
vi.mock('@/lib/race-confirmations', () => ({ sendRaceConfirmations: vi.fn() }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: vi.fn(async () => 'c1') }))
vi.mock('@/lib/sequences', () => ({ triggerSequencesForRaceRegistered: vi.fn() }))
vi.mock('@/lib/marketing-consent', () => ({ applyFormMarketingConsent: vi.fn() }))
vi.mock('@/lib/contact-tags', () => ({ writeContactTags: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/event-waitlist', () => ({
  claimWaitlistOnRegistration: vi.fn(async () => ({ claimed: false, reason: 'invalid_token' })),
  claimWaitlistByEmail: vi.fn(async () => ({ claimed: false, reason: 'not_on_list' })),
}))

const { POST } = await import('./route.js')

const RACE = { id: 'e1', location_id: 'L1', name: 'Hatch Relay', slug: 'hatch-oct18-1100', race_date: '2026-10-18', kind: 'race', capacity_mode: 'teams',
  allowed_team_sizes: [2, 4], find_team: { enabled: true }, registration_opens_at: null, registration_closes_at: null, active: true, status: 'published',
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 2000, members_only: false, payment_currency: 'EUR',
  create_in_glofox: false, host_id: null, waves: [{ id: W1, start_time: '11:00:00', capacity: 10, label: null }] }

const isHeadCount = (q) => q.table === 'race_registrations' && q.ops.some((o) => o[0] === 'select' && o[2]?.head)

function registerDb() {
  return fakeDb((q) => {
    if (q.table === 'race_events') return { data: race, error: null }
    if (q.table === 'teams') return q.action === 'select' ? { data: { id: 't1' }, error: null } : { data: null, error: null }
    if (q.table === 'race_registrations') {
      if (q.action === 'insert') return { data: { id: 'reg1', registered_at: '2026-10-09T12:00:00Z', wave_id: W1, contact_id: 'c1' }, error: null }
      if (isHeadCount(q)) return { data: null, count: countInWave, error: null }
      if (q.action === 'select' && q.ops.some((o) => o[0] === 'in')) return { data: waveRegs, error: null }
      return { data: null, error: null }
    }
    return { data: null, error: null }
  })
}

const SOLO = { find_team: true, wave_id: W1, captain_name: 'Sarah Byrne', captain_email: 'sarah@example.test', captain_phone: '0870000000' }
const TEAM = { team_name: 'The Crushers', team_size: 2, wave_id: W1, captain_name: 'Ann Example', captain_email: 'ann@example.test', captain_phone: '0870000000', members: [{ name: 'Dan Walsh', email: null }] }
const post = (body) => POST(
  new Request('https://crm.test/api/public/events/hatch-oct18-1100/register', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ slug: 'hatch-oct18-1100' }) },
)
const q = (table, action) => db.queries.filter((x) => x.table === table && x.action === action)

beforeEach(() => {
  vi.clearAllMocks()
  race = RACE
  countInWave = 0
  waveRegs = []
  db = registerDb()
})

describe('register route: find_team', () => {
  it('accepts a solo with no team_name or team_size and stores a team of one flagged looking_for_team', async () => {
    const res = await post(SOLO)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.data.team_name).toBe('Sarah Byrne (looking for a team)')
    // sizes [2,4] do not apply to a solo
    expect(eqOf(q('teams', 'select')[0], 'name')).toBe('Sarah Byrne (looking for a team)')
    expect(q('teams', 'update')[0].payload).toMatchObject({ size: 1 })
    expect(q('race_registrations', 'insert')[0].payload).toMatchObject({ looking_for_team: true, team_id: 't1', wave_id: W1 })
  })

  it('ignores a team_name / team_size sent alongside find_team', async () => {
    const res = await post({ ...SOLO, team_name: 'Sneaky', team_size: 4 })
    expect(res.status).toBe(200)
    expect((await res.json()).data.team_name).toBe('Sarah Byrne (looking for a team)')
    expect(q('teams', 'update')[0].payload).toMatchObject({ size: 1 })
  })

  it('refuses a solo that names extra members', async () => {
    const res = await post({ ...SOLO, members: [{ name: 'Dan Walsh', email: null }] })
    expect(res.status).toBe(400)
    expect((await res.json()).success).toBe(false)
    expect(q('race_registrations', 'insert')).toHaveLength(0)
  })

  it('refuses find_team on a non-race event with find_team_unavailable', async () => {
    race = { ...RACE, kind: 'workshop' }
    const res = await post(SOLO)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('find_team_unavailable')
    expect(q('race_registrations', 'insert')).toHaveLength(0)
  })

  it('refuses find_team on an event that has not switched it on with find_team_disabled', async () => {
    race = { ...RACE, find_team: null }
    const res = await post(SOLO)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('find_team_disabled')
    race = { ...RACE, find_team: { enabled: false } }
    expect((await post(SOLO)).status).toBe(400)
    expect(q('race_registrations', 'insert')).toHaveLength(0)
  })

  it('still requires wave_id for a solo', async () => {
    const { wave_id: _w, ...noWave } = SOLO
    const res = await post(noWave)
    expect(res.status).toBe(400)
    expect(q('race_registrations', 'insert')).toHaveLength(0)
  })

  it('a full teams-mode wave still accepts a solo, and the solo never reads the team count', async () => {
    countInWave = 10
    const res = await post(SOLO)
    expect(res.status).toBe(200)
    expect(db.queries.some(isHeadCount)).toBe(false)
  })

  it('a non-solo registration counts confirmed TEAMS only: the count carries looking_for_team = false', async () => {
    const res = await post(TEAM)
    expect(res.status).toBe(200)
    const counts = db.queries.filter(isHeadCount)
    expect(counts).toHaveLength(1)
    expect(counts[0].ops).toContainEqual(['eq', 'looking_for_team', false])
    expect(counts[0].ops).toContainEqual(['eq', 'status', 'confirmed'])
    expect(q('race_registrations', 'insert')[0].payload).toMatchObject({ looking_for_team: false })
  })

  it('a full teams-mode wave still refuses a real team', async () => {
    countInWave = 10
    const res = await post(TEAM)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('wave_full')
  })

  it('people mode checks a solo as one person: full refuses, room accepts', async () => {
    race = { ...RACE, capacity_mode: 'people' }
    waveRegs = [{ status: 'confirmed', team: { size: 10 } }]
    const full = await post(SOLO)
    expect(full.status).toBe(409)
    expect((await full.json()).code).toBe('wave_full')
    waveRegs = [{ status: 'confirmed', team: { size: 9 } }]
    db = registerDb()
    expect((await post(SOLO)).status).toBe(200)
  })
})

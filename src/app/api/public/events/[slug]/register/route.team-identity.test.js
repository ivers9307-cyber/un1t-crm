// EVENTTEAM.1 — the public signup never rewrites a team it does not own.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb, eqOf } from '@/lib/event-waitlist.test-helpers'

const W1 = 'f0000000-0000-4000-8000-0000000000f1'
let db
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
  claimWaitlistOnRegistration: vi.fn(async () => ({ claimed: true, waitlistId: 'wl1' })),
  claimWaitlistByEmail: vi.fn(async () => ({ claimed: false, reason: 'not_on_list' })),
}))

const { POST } = await import('./route.js')

const RACE = { id: 'e1', location_id: 'L1', name: 'Hatch Relay', slug: 'hatch-oct18-1100', race_date: '2026-10-18', kind: 'race', capacity_mode: 'teams',
  allowed_team_sizes: [1], registration_opens_at: null, registration_closes_at: null, active: true, status: 'published',
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 2000, members_only: false, payment_currency: 'EUR',
  create_in_glofox: false, host_id: null, waves: [{ id: W1, start_time: '11:00:00', capacity: 10, label: null }] }

// The studio already holds a team called "Rockets" captained by someone else
// (c-other), confirmed at this event. The caller (c1) types the same name.
function registerDb({ captain = 'c-other', elsewhere = false } = {}) {
  return fakeDb((q) => {
    if (q.table === 'race_events') return { data: RACE, error: null }
    if (q.table === 'teams') {
      if (q.action === 'select') {
        const name = eqOf(q, 'name')
        return { data: name === 'Rockets' ? { id: 't1', captain_contact_id: captain } : null, error: null }
      }
      if (q.action === 'insert') return { data: { id: 't-new' }, error: null }
      return { data: null, error: null }
    }
    if (q.table === 'race_registrations') {
      if (q.action === 'insert') return { data: { id: 'reg1', registered_at: '2026-10-09T12:00:00Z', wave_id: W1, contact_id: 'c1' }, error: null }
      if (q.ops.some((o) => o[0] === 'select' && o[2]?.head)) return { data: null, count: 0, error: null }
      if (q.ops.some((o) => o[0] === 'neq')) return { data: elsewhere ? [{ id: 'r-other' }] : [], error: null }
      if (eqOf(q, 'team_id') === 't1') return { data: { id: 'r-paid', status: 'confirmed', active_payment_id: null }, error: null }
      return { data: null, error: null }
    }
    return { data: null, error: null }
  })
}

const BODY = { team_name: 'Rockets', team_size: 1, wave_id: W1, captain_name: 'Ann Example', captain_email: 'ann@example.test', captain_phone: '0870000000', members: [] }
const post = (body) => POST(
  new Request('https://crm.test/api/public/events/hatch-oct18-1100/register', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ slug: 'hatch-oct18-1100' }) },
)
const touched = (id) => db.queries.filter((q) =>
  (q.table === 'teams' && q.action !== 'select' && q.action !== 'insert' && eqOf(q, 'id') === id)
  || (q.table === 'team_members' && eqOf(q, 'team_id') === id)
  || (q.table === 'race_registrations' && q.action === 'delete' && eqOf(q, 'id') === 'r-paid'))

beforeEach(() => { vi.clearAllMocks() })

describe('register route: a typed team name never takes over a team (EVENTTEAM.1)', () => {
  it("another captain's paid team keeps its captain, size and roster; the caller books a fresh team", async () => {
    db = registerDb()
    const res = await post(BODY)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.team_id).toBe('t-new')
    expect(json.data.team_name).toBe('Rockets 2')
    expect(touched('t1')).toHaveLength(0)
  })

  it("the captain's own team entered at another event is left alone too", async () => {
    db = registerDb({ captain: 'c1', elsewhere: true })
    const res = await post(BODY)
    expect(res.status).toBe(200)
    expect((await res.json()).data.team_id).toBe('t-new')
    expect(touched('t1')).toHaveLength(0)
  })

  it("the captain's own confirmed team here is refused 409 with nothing written to it", async () => {
    db = registerDb({ captain: 'c1' })
    const res = await post(BODY)
    expect(res.status).toBe(409)
    expect(touched('t1')).toHaveLength(0)
  })
})

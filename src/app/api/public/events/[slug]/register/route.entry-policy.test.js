// ENTRYPOLICY.1 — the register route under the unpaid hold:
//   • the people-mode capacity gate stops counting a pending entry older
//     than the event's unpaid_hold_hours (holdsPlace), nothing is deleted;
//   • a captain's re-book of a LAPSED pending entry never resumes its
//     checkout: the row is cleared and a fresh registration made, as a dead
//     checkout is today; a payment that completed meanwhile still confirms it;
//   • a solo's own lapsed pending row is cleared the same way.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb, eqOf } from '@/lib/event-waitlist.test-helpers'

const W1 = 'f0000000-0000-4000-8000-0000000000f1'
let db
let race
let waveRegs = []
let ownSolos = []
let teamReg = null
let payment = null
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: vi.fn(() => '1.2.3.4'),
  rateLimitResponse: vi.fn(),
}))
vi.mock('@/lib/race-payments', () => ({
  createRacePayment: vi.fn(async () => ({ payment: { id: 'p1', status: 'pending' }, checkout: { free: false, token: 'tok', url: 'https://pay.test/x' } })),
  refreshRacePaymentFromProvider: vi.fn(async (_db, pay) => pay),
}))
vi.mock('@/lib/race-confirmations', () => ({ sendRaceConfirmations: vi.fn() }))
vi.mock('@/lib/race-contact-linking', () => ({ findOrCreateRaceContact: vi.fn(async () => 'c1') }))
vi.mock('@/lib/sequences', () => ({ triggerSequencesForRaceRegistered: vi.fn() }))
vi.mock('@/lib/marketing-consent', () => ({ applyFormMarketingConsent: vi.fn() }))
vi.mock('@/lib/contact-tags', () => ({ writeContactTags: vi.fn() }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/member-validation', async (importOriginal) => ({
  ...(await importOriginal()),
  validateTeamRoster: vi.fn(async ({ members }) => members.map((m) => ({ name: m.name, email: m.email, is_member: false, member_contact_id: null, status: 'not_found' }))),
}))
vi.mock('@/lib/location-branding', () => ({ getLocationOrgBrandName: vi.fn(async () => 'UN1T') }))
vi.mock('@/lib/event-waitlist', () => ({
  claimWaitlistOnRegistration: vi.fn(async () => ({ claimed: false, reason: 'invalid_token' })),
  claimWaitlistByEmail: vi.fn(async () => ({ claimed: false, reason: 'not_on_list' })),
}))

const { POST } = await import('./route.js')
const { refreshRacePaymentFromProvider } = await import('@/lib/race-payments')

const NOW = '2026-10-24T12:00:00Z'
const RACE = { id: 'e1', location_id: 'L1', name: 'Hatch Relay', slug: 'hatch-nov07-0900', race_date: '2026-11-07', kind: 'race', capacity_mode: 'people',
  allowed_team_sizes: [1, 2, 4], find_team: { enabled: true }, entry_policy: null, registration_opens_at: null, registration_closes_at: null, active: true, status: 'published',
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 2000, members_only: false, payment_currency: 'EUR',
  create_in_glofox: false, host_id: null, waves: [{ id: W1, start_time: '09:00:00', capacity: 4, label: null }] }

const isHeadCount = (q) => q.table === 'race_registrations' && q.ops.some((o) => o[0] === 'select' && o[2]?.head)

function registerDb() {
  return fakeDb((q) => {
    if (q.table === 'race_events') return { data: race, error: null }
    if (q.table === 'teams') return q.action === 'insert' ? { data: { id: 't-new' }, error: null } : { data: { id: 't1' }, error: null }
    if (q.table === 'race_payments') return { data: payment, error: null }
    if (q.table === 'race_registrations') {
      if (q.action === 'insert') return { data: { id: 'reg-new', registered_at: NOW, wave_id: W1, contact_id: 'c1' }, error: null }
      if (isHeadCount(q)) return { data: null, count: 0, error: null }
      if (q.action === 'select' && eqOf(q, 'looking_for_team') === true) return { data: ownSolos, error: null }
      if (q.action === 'select' && eqOf(q, 'team_id')) return { data: teamReg, error: null }
      if (q.action === 'select' && q.ops.some((o) => o[0] === 'in')) return { data: waveRegs, error: null }
      return { data: null, error: null }
    }
    return { data: null, error: null }
  })
}

const TEAM = { team_name: 'The Crushers', team_size: 2, wave_id: W1, captain_name: 'Ann Example', captain_email: 'ann@example.test', captain_phone: '0870000000', members: [{ name: 'Dan Walsh', email: null }] }
const SOLO = { find_team: true, wave_id: W1, captain_name: 'Sarah Byrne', captain_email: 'sarah@example.test', captain_phone: '0870000000' }
const post = (body) => POST(
  new Request('https://crm.test/api/public/events/hatch-nov07-0900/register', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ slug: 'hatch-nov07-0900' }) },
)
const q = (table, action) => db.queries.filter((x) => x.table === table && x.action === action)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  race = RACE
  waveRegs = []
  ownSolos = []
  teamReg = null
  payment = null
  db = registerDb()
})

describe('register route: the unpaid hold on capacity (people mode)', () => {
  it('a pending entry inside the 48 h hold still holds its places: a group that would not fit is refused', async () => {
    waveRegs = [{ status: 'pending_payment', registered_at: '2026-10-24T11:00:00Z', team: { size: 3 } }]
    const res = await post(TEAM)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('wave_full')
    const gate = db.queries.find((x) => x.table === 'race_registrations' && x.ops.some((o) => o[0] === 'in' && o[1] === 'status'))
    expect(gate.ops[0][1]).toContain('registered_at')
  })
  it('a pending entry older than the hold no longer counts: the group fits, and nothing is deleted', async () => {
    waveRegs = [{ status: 'pending_payment', registered_at: '2026-10-20T11:00:00Z', team: { size: 3 } }]
    expect((await post(TEAM)).status).toBe(200)
    expect(q('race_registrations', 'delete')).toHaveLength(0)
  })
  it("the hold is the event's own: a 240 h hold keeps that entry counting", async () => {
    race = { ...RACE, entry_policy: { unpaid_hold_hours: 240 } }
    db = registerDb()
    waveRegs = [{ status: 'pending_payment', registered_at: '2026-10-20T11:00:00Z', team: { size: 3 } }]
    expect((await post(TEAM)).status).toBe(409)
  })
  it('a confirmed entry counts however old', async () => {
    waveRegs = [{ status: 'confirmed', registered_at: '2025-01-01T00:00:00Z', team: { size: 3 } }]
    expect((await post(TEAM)).status).toBe(409)
  })
})

describe('register route: a lapsed pending entry is never resumed', () => {
  it("a captain's re-book of a lapsed pending row clears it and books afresh, even though the checkout is still open at the provider", async () => {
    teamReg = { id: 'old', status: 'pending_payment', active_payment_id: 'p0', registered_at: '2026-10-20T11:00:00Z' }
    payment = { id: 'p0', status: 'pending' }
    const res = await post(TEAM)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.data.payment?.resumed).toBeUndefined()
    const dels = q('race_registrations', 'delete')
    expect(dels).toHaveLength(1)
    expect(eqOf(dels[0], 'id')).toBe('old')
    expect(q('race_registrations', 'insert')).toHaveLength(1)
  })
  it('a pending row inside the hold with a live checkout is still resumed', async () => {
    teamReg = { id: 'old', status: 'pending_payment', active_payment_id: 'p0', registered_at: '2026-10-24T11:00:00Z' }
    payment = { id: 'p0', status: 'pending' }
    const json = await (await post(TEAM)).json()
    expect(json.data).toMatchObject({ registration_id: 'old', payment: { id: 'p0', resumed: true } })
    expect(q('race_registrations', 'delete')).toHaveLength(0)
  })
  it('a lapsed row whose payment completed meanwhile is confirmed, so the re-book is 409 already_registered (the provider is still asked)', async () => {
    teamReg = { id: 'old', status: 'pending_payment', active_payment_id: 'p0', registered_at: '2026-10-20T11:00:00Z' }
    payment = { id: 'p0', status: 'pending' }
    refreshRacePaymentFromProvider.mockResolvedValueOnce({ id: 'p0', status: 'completed' })
    const res = await post(TEAM)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('already_registered')
    expect(q('race_registrations', 'delete')).toHaveLength(0)
  })
  it("a solo's own lapsed pending row is cleared and the solo books afresh", async () => {
    ownSolos = [{ id: 'solo1', status: 'pending_payment', active_payment_id: 'p0', registered_at: '2026-10-20T11:00:00Z', team_id: 't-old', team: { name: 'x' } }]
    payment = { id: 'p0', status: 'pending' }
    const res = await post(SOLO)
    expect(res.status).toBe(200)
    expect((await res.json()).data.payment?.resumed).toBeUndefined()
    const dels = q('race_registrations', 'delete')
    expect(dels).toHaveLength(1)
    expect(eqOf(dels[0], 'id')).toBe('solo1')
    expect(q('race_registrations', 'insert')).toHaveLength(1)
  })
})

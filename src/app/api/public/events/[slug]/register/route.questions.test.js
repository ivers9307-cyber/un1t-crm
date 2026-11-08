// QUESTIONS.1 — the register route validates the body's answers against the
// event's questions, stores entry answers on the registration and person
// answers on each team_members row, and refuses a missing required answer
// with field-level issues.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

const W1 = 'f0000000-0000-4000-8000-0000000000f1'
let db
let race
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })), getClientIp: vi.fn(() => '1.2.3.4'), rateLimitResponse: vi.fn() }))
vi.mock('@/lib/race-payments', () => ({
  createRacePayment: vi.fn(async ({ pricing }) => ({ payment: { id: 'p1', status: 'completed', amount_cents: pricing.total_cents }, checkout: { free: true } })),
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

const { POST } = await import('./route.js')

const diet = { id: 'q-diet', label: 'Dietary needs', type: 'text', required: false, per: 'person' }
const level = { id: 'q-level', label: 'Experience', type: 'choice', options: ['Beginner', 'Advanced'], required: true, per: 'person' }
const photos = { id: 'q-photos', label: 'OK to be photographed?', type: 'yes_no', required: true, per: 'entry' }
const RACE = {
  id: 'e1', location_id: 'L1', name: 'Mobility', slug: 'mob', race_date: '2026-12-05', kind: 'workshop', capacity_mode: 'people',
  allowed_team_sizes: [1, 2], find_team: { enabled: true }, registration_opens_at: null, registration_closes_at: null, active: true, status: 'published',
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: null, members_only: false, payment_currency: 'EUR',
  create_in_glofox: false, host_id: null, entry_policy: null, pricing_tiers: null, registration_questions: [diet, level, photos],
  waves: [{ id: W1, start_time: '10:00:00', capacity: null, label: null }],
}
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
      if (q.action === 'insert') return { data: { id: 'reg1', registered_at: '2026-11-15T12:00:00Z', wave_id: W1, contact_id: 'c1' }, error: null }
      if (q.ops.some((o) => o[0] === 'select' && o[2]?.head)) return { data: null, count: 0, error: null }
      return { data: [], error: null }
    }
    return { data: null, error: null }
  })
}
const TEAM = { team_name: 'Aoife & Dan', team_size: 2, wave_id: W1, captain_name: 'Aoife Byrne', captain_email: 'aoife@example.test', captain_phone: '0870000000', members: [{ name: 'Dan Walsh', email: null }] }
const post = (body) => POST(
  new Request('https://crm.test/api/public/events/mob/register', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ slug: 'mob' }) },
)
const inserted = (table) => db.queries.find((q) => q.table === table && q.action === 'insert')

beforeEach(() => { vi.clearAllMocks(); race = RACE; db = registerDb() })

describe('register route: registration questions', () => {
  it('stores entry answers on the registration and person answers on each member row', async () => {
    const res = await post({ ...TEAM, answers: { entry: { 'q-photos': 'yes' }, people: [{ 'q-diet': ' vegan ', 'q-level': 'Beginner' }, { 'q-level': 'Advanced' }] } })
    expect(res.status).toBe(200)
    expect(inserted('race_registrations').payload.answers).toEqual({ 'q-photos': true })
    const members = inserted('team_members').payload
    expect(members.map((m) => m.answers)).toEqual([{ 'q-diet': 'vegan', 'q-level': 'Beginner' }, { 'q-level': 'Advanced' }])
  })
  it('a required person answer missing for one member is 400 invalid_answers naming that field, and nothing is inserted', async () => {
    const res = await post({ ...TEAM, answers: { entry: { 'q-photos': true }, people: [{ 'q-level': 'Beginner' }, {}] } })
    expect(res.status).toBe(400)
    const j = await res.json()
    expect(j.code).toBe('invalid_answers')
    expect(j.issues).toEqual([{ path: 'member_1_q-level', message: 'Experience is required for person 2' }])
    expect(inserted('race_registrations')).toBeUndefined()
    expect(inserted('team_members')).toBeUndefined()
  })
  it('a find-a-team solo answers the person questions for one person', async () => {
    race = { ...RACE, kind: 'race' } // "Find me a team" is offered on races only
    const res = await post({ find_team: true, wave_id: W1, captain_name: 'Sarah Byrne', captain_email: 'sarah@example.test', captain_phone: '0870000000', answers: { entry: { 'q-photos': false }, people: [{ 'q-level': 'Beginner' }] } })
    expect(res.status).toBe(200)
    expect(inserted('team_members').payload.map((m) => m.answers)).toEqual([{ 'q-level': 'Beginner' }])
    expect(inserted('race_registrations').payload.answers).toEqual({ 'q-photos': false })
  })
  it('an event without questions stores null answers whatever the body sends', async () => {
    race = { ...RACE, registration_questions: null }
    const res = await post({ ...TEAM, answers: { entry: { stray: 1 }, people: [{ x: 1 }, { y: 2 }] } })
    expect(res.status).toBe(200)
    expect(inserted('race_registrations').payload.answers).toBeNull()
    expect(inserted('team_members').payload.every((m) => m.answers === null)).toBe(true)
  })
})

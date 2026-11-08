// HOSTSTATS.1 — the register route stores the sanitised attribution the
// signup arrived with (null when none was sent), on both insert paths.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

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

const W1 = 'f0000000-0000-4000-8000-0000000000f1'
const HC = '80000000-0000-4000-8000-000000000001'
const RACE = {
  id: 'e1', location_id: 'L1', name: 'Mobility', slug: 'mob', race_date: '2026-12-05', kind: 'workshop', capacity_mode: 'people',
  allowed_team_sizes: [1, 2], find_team: null, registration_opens_at: null, registration_closes_at: null, active: true, status: 'published',
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: null, members_only: false, payment_currency: 'EUR',
  create_in_glofox: false, host_id: null, entry_policy: null, pricing_tiers: null, registration_questions: null,
  waves: [{ id: W1, start_time: '10:00:00', capacity: null, label: null }],
}
function registerDb() {
  return fakeDb((q) => {
    if (q.table === 'race_events') return { data: race, error: null }
    if (q.table === 'teams') {
      if (q.action === 'insert') return { data: { id: 't-new' }, error: null }
      return { data: null, error: null }
    }
    if (q.table === 'race_payments') return { data: null, error: null }
    if (q.table === 'host_campaigns') return { data: q.ops.some((o) => o[0] === 'eq' && o[1] === 'host_id' && o[2] === 'h1') ? { id: HC } : null, error: null }
    if (q.table === 'race_registrations') {
      if (q.action === 'insert') return { data: { id: 'reg1', registered_at: '2026-11-15T12:00:00Z', wave_id: W1, contact_id: 'c1' }, error: null }
      if (q.ops.some((o) => o[0] === 'select' && o[2]?.head)) return { data: null, count: 0, error: null }
      if (q.ops.some((o) => o[0] === 'eq' && o[1] === 'contact_id')) return { data: null, error: null }
      return { data: [], error: null }
    }
    return { data: null, error: null }
  })
}
const SOLO = { team_name: 'Aoife', team_size: 1, wave_id: W1, captain_name: 'Aoife Byrne', captain_email: 'aoife@example.test', captain_phone: '0870000000', members: [] }
const post = (body) => POST(
  new Request('https://crm.test/api/public/events/mob/register', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ slug: 'mob' }) },
)
const inserted = () => db.queries.find((q) => q.table === 'race_registrations' && q.action === 'insert')

beforeEach(() => { vi.clearAllMocks(); race = RACE; db = registerDb() })

describe('register route: attribution', () => {
  it('stores the sanitised attribution on the registration (hc proven against the event host)', async () => {
    race = { ...RACE, host_id: 'h1' }
    const res = await post({ ...SOLO, attribution: { session_id: 'sess-000001', hc: HC, utm_source: 'Instagram', referrer: 'https://l.instagram.com/', junk: 'x'.repeat(9000) } })
    expect(res.status).toBe(200)
    expect(inserted().payload.attribution).toEqual({
      session_id: 'sess-000001', host_campaign_id: HC, referrer_host: 'l.instagram.com',
      utm_source: 'Instagram', utm_medium: null, utm_campaign: null, utm_content: null, source: 'host_email',
    })
  })
  it('no attribution sent → null stored', async () => {
    expect((await post(SOLO)).status).toBe(200)
    expect(inserted().payload.attribution).toBeNull()
    db = registerDb()
    expect((await post({ ...SOLO, attribution: null })).status).toBe(200)
    expect(inserted().payload.attribution).toBeNull()
  })
  it('an hc that is not a campaign of the event host is dropped and the source falls through', async () => {
    const res = await post({ ...SOLO, attribution: { session_id: 'sess-000001', hc: HC, utm_source: 'instagram' } })
    expect(res.status).toBe(200)
    expect(inserted().payload.attribution).toMatchObject({ host_campaign_id: null, source: 'instagram' })
  })
  it('a lead_gen form stores it too', async () => {
    race = { ...RACE, kind: 'lead_gen', race_date: null, waves: [] }
    const res = await post({ captain_name: 'Aoife Byrne', captain_email: 'aoife@example.test', captain_phone: '0870000000', attribution: { session_id: 'sess-000001', utm_source: 'facebook' } })
    expect(res.status).toBe(200)
    expect(inserted().payload.attribution).toMatchObject({ source: 'facebook', session_id: 'sess-000001' })
  })
})

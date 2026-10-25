// EVENT-WAITLIST.1 — the register route marks a waitlist row claimed when the
// booking came through an offer link (body.waitlist_token), after the
// registration exists; a claim that does not take never changes the answer.
// Everything around the claim is stubbed: this pins the hand-off only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeDb } from '@/lib/event-waitlist.test-helpers'

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

const { claimWaitlistOnRegistration, claimWaitlistByEmail } = await import('@/lib/event-waitlist')
const { logWarn } = await import('@/lib/log')
const { POST } = await import('./route.js')

const RACE = { id: 'e1', location_id: 'L1', name: 'Hatch Relay', slug: 'hatch-oct18-1100', race_date: '2026-10-18', kind: 'race', capacity_mode: 'teams',
  allowed_team_sizes: [1], registration_opens_at: null, registration_closes_at: null, active: true, status: 'published',
  member_pricing_enabled: false, member_fee_cents: null, non_member_fee_cents: 2000, members_only: false, payment_currency: 'EUR',
  create_in_glofox: false, host_id: null, waves: [{ id: W1, start_time: '11:00:00', capacity: 10, label: null }] }

function registerDb() {
  return fakeDb((q) => {
    if (q.table === 'race_events') return { data: RACE, error: null }
    if (q.table === 'teams') return q.action === 'select' ? { data: { id: 't1' }, error: null } : { data: null, error: null }
    if (q.table === 'race_registrations') {
      if (q.action === 'insert') return { data: { id: 'reg1', registered_at: '2026-10-09T12:00:00Z', wave_id: W1, contact_id: 'c1' }, error: null }
      if (q.ops.some((o) => o[0] === 'select' && o[2]?.head)) return { data: null, count: 0, error: null }
      return { data: null, error: null }
    }
    return { data: null, error: null }
  })
}

const BODY = { team_name: 'Ann Example', team_size: 1, wave_id: W1, captain_name: 'Ann Example', captain_email: 'ann@example.test', captain_phone: '0870000000', members: [] }
const post = (body) => POST(
  new Request('https://crm.test/api/public/events/hatch-oct18-1100/register', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ slug: 'hatch-oct18-1100' }) },
)

beforeEach(() => {
  vi.clearAllMocks()
  db = registerDb()
  claimWaitlistOnRegistration.mockResolvedValue({ claimed: true, waitlistId: 'wl1' })
  claimWaitlistByEmail.mockResolvedValue({ claimed: false, reason: 'not_on_list' })
})

describe('register route: waitlist_token', () => {
  it('claims the waitlist row for the new registration of THIS event', async () => {
    const res = await post({ ...BODY, waitlist_token: 'tok.sig' })
    expect(res.status).toBe(200)
    expect(claimWaitlistOnRegistration).toHaveBeenCalledWith(db, { token: 'tok.sig', registrationId: 'reg1', raceEventId: 'e1' })
  })

  it('no token, no token claim', async () => {
    expect((await post(BODY)).status).toBe(200)
    expect(claimWaitlistOnRegistration).not.toHaveBeenCalled()
  })

  it('with or without a token, the lead email\'s waitlist row on this event is claimed', async () => {
    expect((await post({ ...BODY, captain_email: 'Ann@Example.test' })).status).toBe(200)
    expect(claimWaitlistByEmail).toHaveBeenCalledWith(db, { raceEventId: 'e1', email: 'ann@example.test', registrationId: 'reg1' })
  })

  it('not on the list is silent; any other claim-by-email failure is logged, never changes the answer', async () => {
    await post(BODY)
    expect(logWarn).not.toHaveBeenCalledWith('race-register', 'waitlist claim by email not recorded', expect.anything())
    claimWaitlistByEmail.mockResolvedValueOnce({ claimed: false, reason: 'write_failed' })
    const res = await post(BODY)
    expect(res.status).toBe(200)
    expect(logWarn).toHaveBeenCalledWith('race-register', 'waitlist claim by email not recorded', expect.objectContaining({ reason: 'write_failed' }))
  })

  it('a claim that does not take is logged and never changes the answer', async () => {
    claimWaitlistOnRegistration.mockResolvedValue({ claimed: false, reason: 'invalid_token' })
    const res = await post({ ...BODY, waitlist_token: 'junk' })
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(logWarn).toHaveBeenCalledWith('race-register', 'waitlist claim not recorded', expect.objectContaining({ reason: 'invalid_token' }))
  })
})

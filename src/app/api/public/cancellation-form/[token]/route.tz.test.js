// route.tz.test.js — TZ.5. The cancellation form's "today" (the GET's date
// bounds, the POST's validation) is the link location's day. Dublin unchanged;
// a failed location read still answers, on DEFAULT_TZ, with a warning.
process.env.TZ = 'America/Los_Angeles' // neither zone under test
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => dbMock) }))
vi.mock('@/lib/cancellation-form/links', () => ({
  resolveLink: vi.fn(), markOpened: vi.fn(), claimLink: vi.fn(async () => true), unclaimLink: vi.fn(), attachRequest: vi.fn(),
}))
vi.mock('@/lib/consent-token-guard', () => ({
  guardBeforeTokenLookup: vi.fn(async () => ({ allowed: true })),
  penaliseInvalidToken: vi.fn(async () => ({ allowed: true })),
  guardResolvedToken: vi.fn(async () => ({ allowed: true })),
}))
vi.mock('@/lib/rate-limit', () => ({
  getClientIp: () => '1.2.3.4',
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  rateLimitResponse: () => new Response('{}', { status: 429 }),
}))
vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'Studio', logoUrl: null })) }))
vi.mock('@/lib/agent/approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))
vi.mock('@/lib/log', async (orig) => ({ ...(await orig()), logWarn: vi.fn() }))

const { GET, POST } = await import('./route')
const { resolveLink } = await import('@/lib/cancellation-form/links')
const { logWarn } = await import('@/lib/log')

let dbMock
let locationAnswer
const LINK = { id: 'l-1', location_id: 'loc-1', contact_id: 'c-1', channel: 'email', conversation_id: null, used_at: null, request_id: null }
const CONTACT = { id: 'c-1', first_name: 'Sam', name: 'Sam Example', location_id: 'loc-1', glofox_membership_plan: 'Unlimited' }

beforeEach(() => {
  vi.clearAllMocks()
  // 02:00Z on the 6th = 22:00 EDT on the 5th in New York, 03:00 IST on the 6th in Dublin.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-06T02:00:00Z'))
  resolveLink.mockResolvedValue({ link: LINK, contact: CONTACT })
  dbMock = {
    from: (table) => {
      const c = {
        select() { return c }, eq() { return c },
        maybeSingle: () => Promise.resolve(table === 'locations' ? locationAnswer : { data: null, error: null }),
        insert() { return c },
        single: () => Promise.resolve({ data: { id: 'req-1' }, error: null }),
      }
      return c
    },
  }
})
afterEach(() => { vi.useRealTimers() })

const params = { params: Promise.resolve({ token: 'tok.sig' }) }
const get = async () => (await (await GET(new Request('http://x/api/public/cancellation-form/tok.sig'), params)).json()).data
const post = (body) => POST(new Request('http://x/api/public/cancellation-form/tok.sig', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), params)
const loc = (timezone) => ({ data: { name: 'Studio', settings: { customer_agent: { cancellation_form: { notice_days: 30 } } }, timezone }, error: null })
const pauseFromThe5th = { choice: 'pause', start_date: '2026-09-05', end_date: '2026-09-20' }

describe('TZ.5 Europe/Dublin is unchanged', () => {
  it('a Dublin (or NULL) studio\'s today is the Dublin day', async () => {
    locationAnswer = loc('Europe/Dublin')
    expect((await get()).options).toMatchObject({ today: '2026-09-06', min_end_date: '2026-10-06' })
    locationAnswer = loc(null)
    expect((await get()).options.today).toBe('2026-09-06')
  })
  it('a pause starting on the Dublin yesterday is refused, as before', async () => {
    locationAnswer = loc('Europe/Dublin')
    const res = await post(pauseFromThe5th)
    expect(res.status).toBe(400)
    expect((await res.json()).field).toBe('start_date')
  })
})

describe('TZ.5 America/New_York follows New York', () => {
  it('the GET bounds start from the New York day', async () => {
    locationAnswer = loc('America/New_York')
    expect((await get()).options).toMatchObject({ today: '2026-09-05', min_end_date: '2026-10-05' })
  })
  it('a pause starting today (New York) is accepted', async () => {
    locationAnswer = loc('America/New_York')
    const res = await post(pauseFromThe5th)
    expect(res.status).toBe(200)
  })
  it('across the NY fall-back the day still flips at New York midnight', async () => {
    vi.setSystemTime(new Date('2026-11-02T04:30:00Z')) // 23:30 EST on the 1st
    locationAnswer = loc('America/New_York')
    expect((await get()).options.today).toBe('2026-11-01')
    vi.setSystemTime(new Date('2026-11-02T05:00:00Z')) // 00:00 EST on the 2nd
    expect((await get()).options.today).toBe('2026-11-02')
  })
  it('an unreadable location still answers: default copy, DEFAULT_TZ, a warning', async () => {
    locationAnswer = { data: null, error: { message: 'statement timeout' } }
    expect((await get()).options.today).toBe('2026-09-06')
    expect(logWarn).toHaveBeenCalledWith('cancellation-form', expect.any(String), expect.objectContaining({ locationId: 'loc-1' }))
  })
})

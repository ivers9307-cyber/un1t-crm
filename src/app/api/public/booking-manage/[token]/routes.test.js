// BOOKINGSELF.1 — the four /api/public/booking-manage/[token] routes against
// a filter-aware in-memory db. The token is the only credential: any bad,
// expired, forged or entry-kind token is a 404 with no read. The real rules
// (src/lib/booking-self-service.js) run; only the limiter, the client and the
// confirmation send are stubbed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'

let tables
const reads = []
vi.mock('@/lib/supabase', () => ({
  createServerClient: vi.fn(() => {
    const db = makeFakeDb(tables)
    return { from: (t) => { reads.push(t); return db.from(t) } }
  }),
}))
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 9, resetAt: new Date(), retryAfterSec: 1 })),
}))
vi.mock('@/lib/booking-confirmations', async (importOriginal) => ({
  ...(await importOriginal()),
  sendBookingConfirmation: vi.fn(async () => ({ sent: ['email'], skipped: [], failed: [] })),
}))

const { checkRateLimit } = await import('@/lib/rate-limit')
const { sendBookingConfirmation } = await import('@/lib/booking-confirmations')
const { signBookingManageToken } = await import('@/lib/booking-manage-tokens')
const { signEntryManageToken } = await import('@/lib/entry-manage-tokens')
const { GET } = await import('./route.js')
const { GET: SLOTS } = await import('./slots/route.js')
const { POST: CANCEL } = await import('./cancel/route.js')
const { POST: RESCHEDULE } = await import('./reschedule/route.js')

const SECRET = 'svc-key'
const BK = 'b0000000-0000-0000-0000-000000000001'
const WEEK = { start: '09:00', end: '12:00' }
const ET = {
  id: 'et1', name: 'Free Consultation', active: true, duration_minutes: 30, buffer_minutes: 0, max_advance_days: 10, location_id: 'L1',
  availability: { mon: WEEK, tue: WEEK, wed: WEEK, thu: WEEK, fri: WEEK },
  locations: { id: 'L1', name: 'UN1T Stillorgan', address: '1 Main St', timezone: 'Europe/Dublin' },
}
const row = (over = {}) => ({
  id: BK, status: 'confirmed', contact_id: 'c1', location_id: 'L1', customer_name: 'Sam Member',
  customer_email: 'sam@example.com', customer_phone: '+353870000000',
  booking_date: '2026-10-20', start_time: '10:00:00', end_time: '10:30:00', event_type_id: 'et1', event_types: ET, ...over,
})
const tokenFor = (id = BK) => signBookingManageToken({ bookingId: id }, SECRET)
const props = (token = tokenFor()) => ({ params: Promise.resolve({ token }) })
const get = (path = '') => new Request(`http://localhost/api/public/booking-manage/x${path}`, { headers: { 'x-forwarded-for': '1.2.3.4' } })
const post = (body = {}) => new Request('http://localhost/api/public/booking-manage/x/y', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify(body),
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T08:00:00Z')) // Thu 15 Oct, 09:00 in Dublin
  vi.clearAllMocks()
  reads.length = 0
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SECRET)
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://crm.test')
  tables = { bookings: [row()], blocked_times: [], booking_reminder_sends: [{ booking_id: BK, reminder_id: 'r1' }], activities: [] }
})
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers() })

const BAD_TOKENS = [
  ['garbage', 'not-a-token'],
  ['a forged signature', `${signBookingManageToken({ bookingId: BK }, SECRET).split('.')[0]}.AAAA`],
  ['another secret', signBookingManageToken({ bookingId: BK }, 'other')],
  ['an expired token', signBookingManageToken({ bookingId: BK }, SECRET, { nowMs: Date.parse('2026-10-15T08:00:00Z') - 91 * 24 * 3600 * 1000 })],
  ['an entry-manage token for the same id', signEntryManageToken({ registrationId: BK }, SECRET)],
]

describe('every booking-manage route — the token', () => {
  for (const [name, call] of [
    ['GET', (t) => GET(get(), props(t))],
    ['slots', (t) => SLOTS(get('/slots?date=2026-10-21'), props(t))],
    ['cancel', (t) => CANCEL(post(), props(t))],
    ['reschedule', (t) => RESCHEDULE(post({ booking_date: '2026-10-21', start_time: '10:00' }), props(t))],
  ]) {
    it.each(BAD_TOKENS)(`${name}: %s is a 404 with no booking read`, async (_w, token) => {
      const res = await call(token)
      expect(res.status).toBe(404)
      expect((await res.json()).error).toBe('not_found')
      expect(reads).not.toContain('bookings')
      expect(tables.bookings[0].status).toBe('confirmed')
    })
  }

  it('a valid token for a booking that no longer exists is a 404', async () => {
    tables.bookings = []
    expect((await GET(get(), props())).status).toBe(404)
  })
})

describe('GET /api/public/booking-manage/[token]', () => {
  it('shows the booking in the studio zone with the days it can move to; no email or phone', async () => {
    const res = await GET(get(), props())
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toMatchObject({
      event_name: 'Free Consultation', studio_name: 'UN1T Stillorgan', timezone: 'Europe/Dublin',
      booking_date: '2026-10-20', start_time: '10:00', can_cancel: true, can_reschedule: true, blocked_reason: null,
    })
    expect(JSON.stringify(data)).not.toMatch(/sam@example|\+353/)
    expect(data.available_days.map((d) => d.date)).toContain('2026-10-20')
    expect(data.available_days.map((d) => d.date)).not.toContain('2026-10-17') // Saturday
    expect(checkRateLimit.mock.calls[0][1]).toBe('booking-manage:1.2.3.4')
  })

  it('inside two hours: nothing allowed, with the contact-the-studio sentence', async () => {
    vi.setSystemTime(new Date('2026-10-20T07:30:00Z')) // 08:30 Dublin, start 10:00
    const { data } = await (await GET(get(), props())).json()
    expect(data).toMatchObject({ can_cancel: false, can_reschedule: false, available_days: [] })
    expect(data.blocked_reason).toBe('This booking can no longer be changed online. Please contact UN1T Stillorgan.')
  })
})

describe('GET /slots', () => {
  it('lists the free times, the holder\'s own slot included', async () => {
    const { data } = await (await SLOTS(get('/slots?date=2026-10-20'), props())).json()
    expect(data.slots.map((s) => s.start)).toContain('10:00')
  })
  it('a bad date is a 400', async () => {
    expect((await SLOTS(get('/slots?date=tomorrow'), props())).status).toBe(400)
  })
  it('a cancelled booking gets the refusal, not times', async () => {
    tables.bookings[0].status = 'cancelled'
    const res = await SLOTS(get('/slots?date=2026-10-20'), props())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('cancelled')
  })
})

describe('POST /cancel', () => {
  it('cancels a confirmed booking more than two hours out', async () => {
    const res = await CANCEL(post(), props())
    expect(res.status).toBe(200)
    expect(tables.bookings[0].status).toBe('cancelled')
    expect(checkRateLimit.mock.calls[0][1]).toBe('booking-manage-write:1.2.3.4')
    expect(sendBookingConfirmation).not.toHaveBeenCalled()
  })
  it('refuses inside two hours (409), and an already cancelled booking', async () => {
    vi.setSystemTime(new Date('2026-10-20T07:00:00Z'))
    let res = await CANCEL(post(), props())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('not_changeable')
    expect(tables.bookings[0].status).toBe('confirmed')
    vi.setSystemTime(new Date('2026-10-15T08:00:00Z'))
    tables.bookings[0].status = 'cancelled'
    res = await CANCEL(post(), props())
    expect((await res.json()).error).toBe('cancelled')
  })
})

describe('POST /reschedule', () => {
  it('moves the booking, clears its reminder sends and re-sends the confirmation', async () => {
    const res = await RESCHEDULE(post({ booking_date: '2026-10-21', start_time: '11:30' }), props())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ rescheduled: true, booking: { booking_date: '2026-10-21', start_time: '11:30', end_time: '12:00' }, confirmation_sent: true })
    expect(tables.bookings[0]).toMatchObject({ booking_date: '2026-10-21', start_time: '11:30', end_time: '12:00' })
    expect(tables.booking_reminder_sends).toEqual([])
    expect(tables.activities).toHaveLength(1)
    expect(sendBookingConfirmation).toHaveBeenCalledWith(expect.anything(), BK)
  })

  it('re-judges the slot server-side: outside the window, beyond max_advance_days and a weekend are refused', async () => {
    for (const body of [
      { booking_date: '2026-10-21', start_time: '12:00' },
      { booking_date: '2026-10-30', start_time: '10:00' },
      { booking_date: '2026-10-17', start_time: '10:00' },
    ]) {
      const res = await RESCHEDULE(post(body), props())
      expect(res.status).toBe(409)
      expect((await res.json()).error).toBe('slot_unavailable')
    }
    expect(tables.bookings[0].booking_date).toBe('2026-10-20')
  })

  it('refuses inside two hours of the CURRENT start and on an inactive type', async () => {
    vi.setSystemTime(new Date('2026-10-20T07:30:00Z'))
    expect((await RESCHEDULE(post({ booking_date: '2026-10-21', start_time: '10:00' }), props())).status).toBe(409)
    vi.setSystemTime(new Date('2026-10-15T08:00:00Z'))
    tables.bookings[0].event_types = { ...ET, active: false }
    const res = await RESCHEDULE(post({ booking_date: '2026-10-21', start_time: '10:00' }), props())
    expect((await res.json()).error).toBe('reschedule_unavailable')
    expect(tables.bookings[0].booking_date).toBe('2026-10-20')
  })

  it('a malformed body is a 400 and moves nothing', async () => {
    expect((await RESCHEDULE(post({ booking_date: 'soon' }), props())).status).toBe(400)
    expect(tables.bookings[0].booking_date).toBe('2026-10-20')
  })
})

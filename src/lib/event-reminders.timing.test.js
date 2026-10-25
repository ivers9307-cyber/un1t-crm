// BOOKINGSELF.1 — booking reminders fire on time. The runner used to read the
// studio wall clock as UTC inside a ±1h tolerance (up to an hour early or
// late). Now: start = the wall clock in the event type's studio zone, and a
// reminder is due when now >= start - minutes_before and now < start. Pinned
// in Europe/Dublin and America/New_York, each across its autumn DST change.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'

const sendTransactionalEmail = vi.fn(async () => ({ ok: true }))
vi.mock('@/lib/postmark', async (importOriginal) => ({
  ...(await importOriginal()),
  sendTransactionalEmail: (...a) => sendTransactionalEmail(...a),
}))
vi.mock('@/lib/wallet-enforcement', () => ({ logTransactionalWalletState: vi.fn() }))
vi.mock('@/lib/location-branding', () => ({
  getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T', shortName: 'UN1T', locationName: 'Stillorgan' })),
}))
vi.mock('@/lib/tenant-host', () => ({ resolveCustomerBaseUrl: vi.fn(async () => 'https://gym.test') }))

const { runEventReminderSends, reminderIsDue, reminderDateRange, MIN_REMINDER_LEAD_MS } = await import('./event-reminders.js')
const { resetLocationZoneCache } = await import('@/lib/location-time')
const { verifyBookingManageToken } = await import('@/lib/booking-manage-tokens')

const SECRET = 'svc-key'
const at = (iso) => Date.parse(iso)

function fixture({ zone = 'Europe/Dublin', reminders = [1440], bookings = [], sends = [] } = {}) {
  return {
    locations: [{ id: 'L1', timezone: zone }],
    event_type_reminders: reminders.map((mb) => ({
      id: `r${mb}`, active: true, minutes_before: mb, channels: ['email'], email_template_id: 'tpl', email_subject: null,
      event_types: { id: 'et1', name: 'Consultation', location_id: 'L1' },
    })),
    bookings: bookings.map((b, i) => ({
      id: `bk${i + 1}`, event_type_id: 'et1', status: 'confirmed', contact_id: null, skip_reminder: false,
      customer_name: 'Sam Member', customer_email: 'sam@example.com', customer_phone: null, contacts: null, ...b,
    })),
    booking_reminder_sends: [...sends],
    email_templates: [{ id: 'tpl', subject: 'See you {{event_time}}', html_content: '<a href="{{manage_url}}">Change</a>' }],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetLocationZoneCache()
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SECRET)
})

describe('reminderIsDue (pure)', () => {
  const start = at('2026-10-20T09:00:00Z')
  it('opens exactly minutes_before ahead and closes at the start', () => {
    expect(reminderIsDue(start, 120, start - 120 * 60_000 - 1)).toBe(false)
    expect(reminderIsDue(start, 120, start - 120 * 60_000)).toBe(true)
    expect(reminderIsDue(start, 120, start - 1)).toBe(true)
    expect(reminderIsDue(start, 120, start)).toBe(false)
  })
  it('a 0-minute reminder still gets the last cron tick before the start', () => {
    expect(reminderIsDue(start, 0, start - MIN_REMINDER_LEAD_MS)).toBe(true)
    expect(reminderIsDue(start, 0, start - MIN_REMINDER_LEAD_MS - 1)).toBe(false)
  })
  it('an unreadable start is never due', () => {
    expect(reminderIsDue(null, 60, start)).toBe(false)
  })
  it('the date pre-filter covers the studio dates of [now, now + lead], a day wider each side', () => {
    expect(reminderDateRange(at('2026-10-19T23:30:00Z'), 1440, 'Europe/Dublin')).toEqual({ lo: '2026-10-19', hi: '2026-10-22' })
    expect(reminderDateRange(at('2026-10-20T02:00:00Z'), 60, 'America/New_York')).toEqual({ lo: '2026-10-18', hi: '2026-10-20' })
  })
})

describe('runEventReminderSends — Europe/Dublin', () => {
  it('summer time (IST): a 24h reminder for 10:00 on 20 Oct goes at 09:00Z on 19 Oct, not before', async () => {
    const tables = fixture({ bookings: [{ booking_date: '2026-10-20', start_time: '10:00:00' }] })
    expect((await runEventReminderSends({ db: makeFakeDb(tables), nowMs: at('2026-10-19T08:59:00Z') })).sent).toBe(0)
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    const stats = await runEventReminderSends({ db: makeFakeDb(tables), nowMs: at('2026-10-19T09:00:00Z') })
    expect(stats.sent).toBe(1)
    expect(tables.booking_reminder_sends).toEqual([expect.objectContaining({ booking_id: 'bk1', reminder_id: 'r1440', status: 'sent' })])
    // the next tick does not send it again
    await runEventReminderSends({ db: makeFakeDb(tables), nowMs: at('2026-10-19T09:05:00Z') })
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
  })

  it('across the change (clocks back 25 Oct): 10:00 on 26 Oct is 10:00Z, so the 24h reminder is due at 10:00Z on 25 Oct', async () => {
    const tables = fixture({ bookings: [{ booking_date: '2026-10-26', start_time: '10:00:00' }] })
    expect((await runEventReminderSends({ db: makeFakeDb(tables), nowMs: at('2026-10-25T09:59:00Z') })).sent).toBe(0)
    expect((await runEventReminderSends({ db: makeFakeDb(tables), nowMs: at('2026-10-25T10:00:00Z') })).sent).toBe(1)
  })

  it('carries {{manage_url}}: a booking-manage link on the studio host for THIS booking', async () => {
    const tables = fixture({ bookings: [{ booking_date: '2026-10-20', start_time: '10:00:00' }] })
    await runEventReminderSends({ db: makeFakeDb(tables), nowMs: at('2026-10-19T09:00:00Z') })
    const { htmlBody, subject } = sendTransactionalEmail.mock.calls[0][0]
    const href = htmlBody.match(/href="([^"]+)"/)[1]
    expect(href).toMatch(/^https:\/\/gym\.test\/book\/manage\//)
    expect(verifyBookingManageToken(href.split('/').pop(), SECRET)).toEqual({ bookingId: 'bk1' })
    expect(subject).toBe('See you Tue, 20 Oct, 10:00')
  })

  it('never after the start', async () => {
    const tables = fixture({ reminders: [60], bookings: [{ booking_date: '2026-10-20', start_time: '10:00:00' }] })
    expect((await runEventReminderSends({ db: makeFakeDb(tables), nowMs: at('2026-10-20T09:00:00Z') })).sent).toBe(0)
  })

  it('a booking made inside two windows gets only the closer reminder; the stale one is recorded superseded', async () => {
    const tables = fixture({ reminders: [1440, 120], bookings: [{ booking_date: '2026-10-20', start_time: '10:00:00' }] })
    const stats = await runEventReminderSends({ db: makeFakeDb(tables), nowMs: at('2026-10-20T08:00:00Z') }) // 1h before
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1)
    expect(stats).toMatchObject({ sent: 1, skipped: 1 })
    const byReminder = Object.fromEntries(tables.booking_reminder_sends.map((r) => [r.reminder_id, r]))
    expect(byReminder.r120.status).toBe('sent')
    expect(byReminder.r1440).toMatchObject({ status: 'skipped', reason: 'superseded_by_closer_reminder' })
  })

  it('a rescheduled booking (its send rows cleared) is reminded again for the new time', async () => {
    const tables = fixture({ bookings: [{ booking_date: '2026-10-22', start_time: '10:00:00' }], sends: [] })
    expect((await runEventReminderSends({ db: makeFakeDb(tables), nowMs: at('2026-10-21T09:00:00Z') })).sent).toBe(1)
  })
})

describe('runEventReminderSends — America/New_York', () => {
  it('daylight time (EDT, UTC-4): a 2h reminder for 10:00 on 30 Oct goes at 12:00Z', async () => {
    const tables = fixture({ zone: 'America/New_York', reminders: [120], bookings: [{ booking_date: '2026-10-30', start_time: '10:00:00' }] })
    expect((await runEventReminderSends({ db: makeFakeDb(tables), nowMs: at('2026-10-30T11:59:00Z') })).sent).toBe(0)
    expect((await runEventReminderSends({ db: makeFakeDb(tables), nowMs: at('2026-10-30T12:00:00Z') })).sent).toBe(1)
  })

  it('across the change (clocks back 1 Nov): 10:00 on 2 Nov is 15:00Z, the 24h reminder due 15:00Z on 1 Nov', async () => {
    const tables = fixture({ zone: 'America/New_York', bookings: [{ booking_date: '2026-11-02', start_time: '10:00:00' }] })
    expect((await runEventReminderSends({ db: makeFakeDb(tables), nowMs: at('2026-11-01T14:59:00Z') })).sent).toBe(0)
    expect((await runEventReminderSends({ db: makeFakeDb(tables), nowMs: at('2026-11-01T15:00:00Z') })).sent).toBe(1)
  })

  it('an evening booking whose studio date is "yesterday" in UTC terms is still found', async () => {
    // 21:00 EST on 2 Nov = 02:00Z on 3 Nov; 1h reminder due 01:00Z on 3 Nov.
    const tables = fixture({ zone: 'America/New_York', reminders: [60], bookings: [{ booking_date: '2026-11-02', start_time: '21:00:00' }] })
    expect((await runEventReminderSends({ db: makeFakeDb(tables), nowMs: at('2026-11-03T01:00:00Z') })).sent).toBe(1)
  })
})

describe('runEventReminderSends — unreadable studio zone', () => {
  it('skips that reminder for the tick, logged, and sends nothing at a guessed hour', async () => {
    const tables = fixture({ bookings: [{ booking_date: '2026-10-20', start_time: '10:00:00' }] })
    const fake = makeFakeDb(tables)
    const db = {
      from(t) {
        if (t !== 'locations') return fake.from(t)
        const q = { select: () => q, in: () => q, eq: () => q, order: async () => ({ data: null, error: { message: 'down' } }), maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }
        return q
      },
    }
    const stats = await runEventReminderSends({ db, nowMs: at('2026-10-19T09:00:00Z') })
    expect(stats).toMatchObject({ sent: 0, zone_unreadable: 1 })
    expect(sendTransactionalEmail).not.toHaveBeenCalled()
    expect(tables.booking_reminder_sends).toEqual([])
  })
})

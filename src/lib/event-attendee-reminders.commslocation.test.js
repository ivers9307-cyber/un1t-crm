// runEventReminders × resolveEventCommsLocation — the daily-cron seam.
//
// BAREWRITE.1 made resolveEventCommsLocation throw on an unreadable location
// row, and this loop answered the throw with `continue`, under a comment that
// said "no claims are taken, so the next tick re-attempts the same offset".
// That comment was wrong twice over:
//
//   • /api/cron/event-reminders is a DAILY cron ("0 9 * * *" in vercel.json),
//     not a per-minute one, so "the next tick" is TOMORROW;
//   • reminders are keyed to a fixed day-offset from the event date
//     (reminderOffsetForDate: race_date === today+3 or today+1), so by
//     tomorrow this event no longer matches the offset this tick was sending.
//
// The reminder was therefore not deferred, it was DESTROYED — and for a T-1
// reminder that is the last one the attendee was ever going to get, carrying
// their check-in QR codes. All of that to avoid a sender the fallback resolves
// to the same organisation and (on every prod location pair) the same Twilio
// alpha sender.
//
// This test pins the property from the caller's side: a comms-location failure
// never costs an attendee their reminder.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendTransactionalEmail = vi.fn(async () => ({ ok: true }))
const resolveEventCommsLocation = vi.fn(async () => ({ id: 'MASTER' }))

vi.mock('@/lib/postmark', () => ({ sendTransactionalEmail: (...a) => sendTransactionalEmail(...a) }))
vi.mock('@/lib/event-comms-location', () => ({ resolveEventCommsLocation: (...a) => resolveEventCommsLocation(...a) }))
vi.mock('@/lib/customer-push', () => ({ sendCustomerPush: vi.fn(async () => ({})) }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/event-checkin-tokens', () => ({ signCheckinToken: () => 'tok' }))
vi.mock('@/lib/event-email', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, resolveEventEmail: vi.fn(async () => ({ subject: 'Reminder', htmlBody: '<p>hi</p>' })) }
})

import { runEventReminders } from './event-attendee-reminders.js'

const TODAY = '2026-09-01'
const EVENT = {
  id: 'ev1', name: 'Hyrox Sim', slug: 'hyrox', race_date: '2026-09-02', start_time: '09:30:00',
  location_id: 'ANCHOR', host_id: 'H', sending_location_id: null, kind: 'race', active: true,
  venue_name: 'The Venue', venue_address: null, accent_hex: null, hero_image_url: null,
  reminder_email_subject: null, reminder_email_intro: null, reminder_email_template_id: null,
  locations: { id: 'ANCHOR', name: 'Pride (host events)' },
}
const REGISTRATION = {
  id: 'reg1', race_event_id: 'ev1', contact_id: 'c1', status: 'confirmed',
  contact: { id: 'c1', email: 'runner@example.com', name: 'A Runner', first_name: 'A', email_status: null, contact_preferences: null },
  wave: null,
  teams: { id: 't1', name: 'Team', team_members: [{ id: 'm1', name: 'A Runner', role: 'captain' }] },
}

function makeDb() {
  return {
    from(table) {
      const b = {}
      for (const m of ['select', 'eq', 'neq', 'in', 'order']) b[m] = () => b
      b.range = async () => ({
        data: table === 'race_registrations' ? [REGISTRATION] : [],
        error: null,
      })
      b.insert = async () => ({ error: null })
      b.then = (resolve, reject) => {
        const data = table === 'race_events' ? [EVENT] : []
        return Promise.resolve({ data, error: null }).then(resolve, reject)
      }
      return b
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  sendTransactionalEmail.mockImplementation(async () => ({ ok: true }))
})

describe('runEventReminders — an unresolvable comms location', () => {
  it('REMINDER NOT LOST: a resolver THROW still sends, from the event location', async () => {
    resolveEventCommsLocation.mockRejectedValue(new Error('sending location read failed'))

    const result = await runEventReminders({ db: makeDb(), todayStr: TODAY })

    // THE REGRESSION. Under BAREWRITE.1 the loop `continue`d here, the event
    // was counted but nothing was sent, and the daily cadence meant the T-1
    // offset never came round again.
    expect(result.events).toBe(1)
    expect(result.sent).toBe(1)
    expect(sendTransactionalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'runner@example.com', locationId: 'ANCHOR' }),
    )
  })

  it('REMINDER NOT LOST: a resolver returning null (the fail-open path) sends too', async () => {
    resolveEventCommsLocation.mockResolvedValue(null)

    const result = await runEventReminders({ db: makeDb(), todayStr: TODAY })

    expect(result.sent).toBe(1)
    expect(sendTransactionalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: 'ANCHOR' }),
    )
  })

  it('still prefers the resolved comms location when the read succeeds', async () => {
    resolveEventCommsLocation.mockResolvedValue({ id: 'MASTER' })

    await runEventReminders({ db: makeDb(), todayStr: TODAY })

    expect(sendTransactionalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: 'MASTER' }),
    )
  })
})

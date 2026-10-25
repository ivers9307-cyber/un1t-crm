// TZ.6 — runEventReminders (TZ.9: each event against its own studio's day)
// skips an event whose location is not at its daily slot this tick (isDue).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendTransactionalEmail = vi.fn(async () => ({ ok: true }))
const resolveEventCommsLocation = vi.fn(async () => ({ id: 'MASTER' }))

vi.mock('@/lib/postmark', () => ({ sendTransactionalEmail: (...a) => sendTransactionalEmail(...a) }))
// PARTIAL — see race-confirmations.sendonce.test.js: a factory that lists only
// the exports used today makes a later export addition break these "REMINDER
// NOT LOST" guards, which is the one thing they must never do quietly.
vi.mock('@/lib/event-comms-location', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveEventCommsLocation: (...a) => resolveEventCommsLocation(...a),
}))
vi.mock('@/lib/customer-push', () => ({ sendCustomerPush: vi.fn(async () => ({})) }))
vi.mock('@/lib/app-url', () => ({ getAppUrl: () => 'https://crm.test' }))
vi.mock('@/lib/event-checkin-tokens', () => ({ signCheckinToken: () => 'tok' }))
vi.mock('@/lib/event-email', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, resolveEventEmail: vi.fn(async () => ({ subject: 'Reminder', htmlBody: '<p>hi</p>' })) }
})

import { runEventReminders } from './event-attendee-reminders.js'

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


const OTHER = { ...EVENT, id: 'ev2', location_id: 'NY', race_date: '2026-09-04', locations: { id: 'NY', name: 'NY', timezone: 'America/New_York' } }
function makeDb(events) {
  return {
    from(table) {
      const b = {}
      for (const m of ['select', 'eq', 'neq', 'order', 'in']) b[m] = () => b
      b.range = async () => ({ data: table === 'race_registrations' ? [REGISTRATION] : [], error: null })
      b.insert = async () => ({ error: null })
      b.then = (resolve, reject) => Promise.resolve({ data: table === 'race_events' ? events : [], error: null }).then(resolve, reject)
      return b
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('TZ.6 runEventReminders isDue: only events whose location is at its daily slot', () => {
  const nowMs = Date.parse('2026-09-01T09:00:00Z')
  const dublinEvent = { ...EVENT, locations: { ...EVENT.locations, timezone: 'Europe/Dublin' } }

  it('without isDue (as TZ.9 shipped) both events are judged', async () => {
    const result = await runEventReminders({ db: makeDb([dublinEvent, { ...OTHER, race_date: '2026-09-02' }]), nowMs })
    expect(result.events).toBe(2)
  })

  it('an event whose location is not due this tick is skipped', async () => {
    const isDue = (loc) => loc === 'ANCHOR'
    const result = await runEventReminders({ db: makeDb([dublinEvent, { ...OTHER, race_date: '2026-09-02' }]), nowMs, isDue })
    expect(result.events).toBe(1)
  })

  it('no due location sends nothing', async () => {
    expect(await runEventReminders({ db: makeDb([dublinEvent]), nowMs, isDue: () => false })).toEqual({ events: 0, sent: 0, skipped: 0 })
  })
})

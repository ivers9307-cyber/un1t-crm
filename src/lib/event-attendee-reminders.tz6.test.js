// TZ.6 — runEventReminders judges each event against ITS location's today
// (todayFor), reads the union of every due location's target dates, and skips
// an event whose location is not at its daily slot this tick.
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


const OTHER = { ...EVENT, id: 'ev2', location_id: 'NY', race_date: '2026-09-04', locations: { id: 'NY', name: 'NY' } }
function makeDb(events, seen) {
  return {
    from(table) {
      const b = {}
      for (const m of ['select', 'eq', 'neq', 'order']) b[m] = () => b
      b.in = (col, vals) => { if (table === 'race_events') seen.push([col, vals]); return b }
      b.range = async () => ({ data: table === 'race_registrations' ? [REGISTRATION] : [], error: null })
      b.insert = async () => ({ error: null })
      b.then = (resolve, reject) => Promise.resolve({ data: table === 'race_events' ? events : [], error: null }).then(resolve, reject)
      return b
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('TZ.6 runEventReminders with todayFor', () => {
  it('reads the union of target dates and sends only for events whose location is due, by its own today', async () => {
    const seen = []
    const todayFor = (loc) => ({ ANCHOR: '2026-09-01', NY: '2026-09-03' })[loc]
    const result = await runEventReminders({ db: makeDb([EVENT, OTHER], seen), todayFor, todays: ['2026-09-01', '2026-09-03'] })
    expect(seen).toEqual([['race_date', ['2026-09-04', '2026-09-02', '2026-09-06']]])
    expect(result.events).toBe(2) // ev1: 1d before 2 Sep for ANCHOR; ev2: 1d before 4 Sep for NY
  })

  it('an event whose location is not due this tick is skipped', async () => {
    const seen = []
    const result = await runEventReminders({ db: makeDb([EVENT, OTHER], seen), todayFor: (loc) => (loc === 'ANCHOR' ? '2026-09-01' : undefined), todays: ['2026-09-01'] })
    expect(seen).toEqual([['race_date', ['2026-09-04', '2026-09-02']]]) // byte-identical to the one-today read
    expect(result.events).toBe(1)
  })

  it('no due location reads nothing', async () => {
    const seen = []
    expect(await runEventReminders({ db: makeDb([EVENT], seen), todayFor: () => undefined, todays: [] })).toEqual({ events: 0, sent: 0, skipped: 0 })
    expect(seen).toEqual([])
  })
})

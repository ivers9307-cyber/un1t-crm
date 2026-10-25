// UN1TBOOK.2 / UN1TBOOK.8 — Decision 1 (2026-10-17): the CRM never sends a
// class reminder for a un1t.online booking or at a un1t.online studio; the
// un1t.online app does. The decision lives in class-booking-platform.js
// (scopeToCrmActionable on the read, crmMayActOnClassBooking on every row).
// The fake class_bookings table here IGNORES every filter and returns every
// fixture row (recording the filters it was sent), so a guard that lived only
// in the query would let the un1t rows through and fail these tests.
// A failed un1t_online locations read never costs Stillorgan its reminders
// (louder-failure rule): it is logged and the row guard alone still applies.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null, un1tBookings: false }))
// The un1t.online provider with a switchable `bookings` capability (as in the
// credit-attendance test): the reminder must not care.
vi.mock('@/lib/membership/sources/un1t-online', () => ({
  UN1T_ONLINE_UNREADABLE: 'UN1T_ONLINE_CONNECTION_UNREADABLE',
  un1tOnlineSource: {
    key: 'un1t_online',
    label: 'un1t.online',
    capabilities: { memberships: false, get bookings() { return h.un1tBookings }, credits: false, invoices: false, schedule: false },
    isConfigured: async () => ({ configured: true }),
  },
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => h.db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/customer-nudge-claim', () => ({
  readReachableContacts: vi.fn(async (_db, ids) => ({ reachable: new Set(ids), failed: 0 })),
  sendNudgeOnce: vi.fn(async () => ({ status: 'sent' })),
  nudgeFailed: () => false,
}))

import { GET } from './route.js'
import { sendNudgeOnce, readReachableContacts } from '@/lib/customer-nudge-claim'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError } from '@/lib/log'
import { MEMBERSHIP_SOURCES } from '@/lib/membership/source'
import { fakeDb, queriesOf } from '@/lib/time-off.test-helpers'
import { ESTATE_2026_10_17, STILLORGAN_ID, locationsResolver } from '@/lib/membership/locations-for-source.test-helpers'
import { mapUn1tBookingToClassBooking } from '@/lib/un1t-online-bookings'

const HATCH_ID = ESTATE_2026_10_17[1].id
const NOW = Date.parse('2026-10-17T17:00:00Z')
const STARTS = new Date(NOW + 30 * 60_000).toISOString() // the default 30 min lead

const req = () => new Request('https://x.test/api/cron/send-class-booking-reminders', { headers: { authorization: 'Bearer shh' } })
const row = (id, location_id, source_platform = 'glofox', contact_id = 'c-' + id) => ({
  id, contact_id, location_id, class_name: 'HIIT', starts_at: STARTS, source_platform,
})

// class_bookings answered by a fake that IGNORES every filter (it returns each
// fixture row, once, on the first page) but records them in q.calls / q.eq.
// Hatch carries lead times (the default 30 min is also set explicitly) so its
// rows are due: only the predicate stands between them and a push.
const HATCH_CONFIG = { categories: { class_reminder: { lead_times_minutes: [30] } } }
function dbFor(bookingRows, { un1tListError = null } = {}) {
  const estate = ESTATE_2026_10_17.map((r) => (r.id === HATCH_ID ? { ...r, timezone: 'Europe/Dublin', notification_config: HATCH_CONFIG } : r))
  const loc = locationsResolver(estate)
  return fakeDb((q) => {
    if (q.table === 'locations') {
      if (un1tListError && q.eq.membership_source === 'un1t_online') return { data: null, error: un1tListError }
      return loc(q)
    }
    if (q.table === 'class_bookings') {
      const page = q.calls.find(([op]) => op === 'range')
      if (page && page[1] > 0) return { data: [], error: null }
      return { data: bookingRows, error: null }
    }
    return { data: [], error: null }
  })
}

const bookingQuery = () => queriesOf(h.db, 'class_bookings')[0]
const remindedBookings = () => sendNudgeOnce.mock.calls.map(([, a]) => a.dedupKey.split(':')[0])

beforeEach(() => {
  vi.clearAllMocks()
  h.un1tBookings = false
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  process.env.CRON_SECRET = 'shh'
})

afterEach(() => { vi.useRealTimers() })

describe('send-class-booking-reminders — un1t.online hard-off (UN1TBOOK.8, Decision 1)', () => {
  it('with filters ignored, a due un1t_online row at Hatch is never pushed, with Hatch lead times set and capabilities.bookings forced true', async () => {
    h.un1tBookings = true
    expect(MEMBERSHIP_SOURCES.un1t_online.capabilities.bookings).toBe(true)
    h.db = dbFor([row('cb-still', STILLORGAN_ID), row('cb-hatch', HATCH_ID, 'un1t_online')])
    const out = await (await GET(req())).json()
    expect(remindedBookings()).toEqual(['cb-still'])
    expect(readReachableContacts.mock.calls[0][1]).toEqual(['c-cb-still'])
    expect(out).toMatchObject({ ok: true, sent: 1, skipped_un1t_online: 1 })
    expect(stampHeartbeat).toHaveBeenCalledWith('send-class-booking-reminders')
  })

  it('UN1TBOOK.15-18: every row the projection writes (real mapper, each status, a guest, a CRM write-through) is never pushed, filters ignored and bookings forced true', async () => {
    h.un1tBookings = true
    const event = { title: 'HIIT', starts_at: STARTS }
    const projected = [
      ['booked', 'c-hatch-1', false, 'sync'],
      ['attended', 'c-hatch-2', false, 'sync'],
      ['no_show', 'c-hatch-3', false, 'sync'],
      ['booked', null, true, 'sync'], // a guest
      ['booked', 'c-dual', false, 'crm'], // D's write-through, a dual-studio contact
    ].map(([status, contact_id, has_guest, writtenBy], i) => ({
      id: `cb-proj-${i}`,
      ...mapUn1tBookingToClassBooking(
        { un1t_id: `bk-${i}`, event_id: 'ev-1', status, contact_id, has_guest, source: 'app', credit_charged: true, remote_updated_at: null },
        { locationId: HATCH_ID, event, memberName: contact_id ? 'A Member' : null, nowIso: new Date(NOW).toISOString(), writtenBy },
      ),
    }))
    expect(projected.every((r) => r.source_platform === 'un1t_online' && r.starts_at === STARTS)).toBe(true)
    h.db = dbFor([row('cb-still', STILLORGAN_ID, 'glofox', 'c-dual'), ...projected])
    const out = await (await GET(req())).json()
    expect(remindedBookings()).toEqual(['cb-still'])
    expect(readReachableContacts.mock.calls[0][1]).toEqual(['c-dual'])
    expect(out).toMatchObject({ ok: true, sent: 1, skipped_un1t_online: projected.length })
  })

  it('a dual-studio member\'s Hatch booking (a Stillorgan contact with a push token) is never pushed', async () => {
    h.db = dbFor([row('cb-hatch', HATCH_ID, 'un1t_online', 'c-dual'), row('cb-still', STILLORGAN_ID, 'glofox', 'c-dual')])
    const out = await (await GET(req())).json()
    expect(remindedBookings()).toEqual(['cb-still'])
    expect(sendNudgeOnce.mock.calls.map(([, a]) => a.dedupKey)).toEqual(['cb-still:30'])
    expect(out).toMatchObject({ ok: true, sent: 1, skipped_un1t_online: 1 })
  })

  it('a Stillorgan glofox row in the same tick is pushed once', async () => {
    h.db = dbFor([row('cb-still', STILLORGAN_ID), row('cb-hatch', HATCH_ID, 'un1t_online'), row('cb-hatch-glofox', HATCH_ID, 'glofox')])
    const out = await (await GET(req())).json()
    expect(sendNudgeOnce).toHaveBeenCalledTimes(1)
    expect(remindedBookings()).toEqual(['cb-still'])
    expect(out).toMatchObject({ ok: true, sent: 1, skipped_un1t_online: 2 })
  })

  it('the class_bookings select names source_platform and the recorded filters include eq source_platform glofox', async () => {
    h.db = dbFor([row('cb-still', STILLORGAN_ID)])
    await GET(req())
    expect(bookingQuery().columns).toMatch(/\bsource_platform\b/)
    expect(bookingQuery().calls).toContainEqual(['eq', 'source_platform', 'glofox'])
  })

  it('a returned row without source_platform is dropped, counted in skipped_un1t_online, and logged once at error with the count', async () => {
    const noColumn = row('cb-nocol', STILLORGAN_ID)
    delete noColumn.source_platform
    h.db = dbFor([row('cb-still', STILLORGAN_ID), noColumn, row('cb-hatch', HATCH_ID, 'un1t_online')])
    const out = await (await GET(req())).json()
    expect(remindedBookings()).toEqual(['cb-still'])
    expect(out).toMatchObject({ ok: true, sent: 1, skipped_un1t_online: 2 })
    const leaked = logError.mock.calls.filter(([, msg]) => /query filter let a non-CRM row through/.test(msg))
    expect(leaked).toEqual([['cron-class-reminders', 'query filter let a non-CRM row through', { count: 2 }]])
  })

  it('a glofox-tagged booking at a un1t_online location is skipped and counted, without the leaked-filter error', async () => {
    h.db = dbFor([row('cb-still', STILLORGAN_ID), row('cb-hatch-glofox', HATCH_ID, 'glofox')])
    const out = await (await GET(req())).json()
    expect(remindedBookings()).toEqual(['cb-still'])
    expect(out).toMatchObject({ ok: true, sent: 1, skipped_un1t_online: 1 })
    expect(logError).not.toHaveBeenCalled()
  })

  it('a booking set that is all at un1t_online locations sends nothing, counts them and stamps', async () => {
    h.db = dbFor([row('cb-hatch-glofox', HATCH_ID, 'glofox')])
    const out = await (await GET(req())).json()
    expect(sendNudgeOnce).not.toHaveBeenCalled()
    expect(out).toMatchObject({ ok: true, due: 0, sent: 0, skipped_un1t_online: 1 })
    expect(stampHeartbeat).toHaveBeenCalledWith('send-class-booking-reminders')
  })

  it('a failed un1t_online locations read still reminds Stillorgan, logs an error, and keeps the row filter', async () => {
    h.db = dbFor([row('cb-still', STILLORGAN_ID), row('cb-hatch', HATCH_ID, 'un1t_online')], { un1tListError: { message: 'down' } })
    const out = await (await GET(req())).json()
    expect(bookingQuery().calls).toContainEqual(['eq', 'source_platform', 'glofox'])
    expect(remindedBookings()).toEqual(['cb-still'])
    expect(out).toMatchObject({ ok: true, sent: 1, skipped_un1t_online: 1 })
    expect(logError).toHaveBeenCalledWith('cron-class-reminders', expect.stringContaining('un1t_online'), expect.anything())
    expect(stampHeartbeat).toHaveBeenCalledWith('send-class-booking-reminders')
  })
})

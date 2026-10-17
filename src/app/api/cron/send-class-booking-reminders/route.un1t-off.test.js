// UN1TBOOK.2 — Decision 1 (2026-10-17): the CRM never sends a class reminder
// for a un1t.online booking or at a un1t.online studio; the un1t.online app
// does. Two locks, both unconditional: the booking read filters
// source_platform = 'glofox' (CRM_CLASS_MESSAGING_PLATFORM), and any row at a
// un1t_online location is dropped and counted before a reminder is chosen.
// A failed un1t_online locations read never costs Stillorgan its reminders
// (louder-failure rule): it is logged and the row filter alone still applies.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => h.db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/customer-nudge-claim', () => ({
  readReachableContacts: vi.fn(async (_db, ids) => ({ reachable: new Set(ids), failed: 0 })),
  sendNudgeOnce: vi.fn(async () => ({ status: 'sent' })),
  nudgeFailed: () => false,
}))

import { GET } from './route.js'
import { sendNudgeOnce } from '@/lib/customer-nudge-claim'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError } from '@/lib/log'
import { fakeDb, queriesOf } from '@/lib/time-off.test-helpers'
import { ESTATE_2026_10_17, STILLORGAN_ID, locationsResolver } from '@/lib/membership/locations-for-source.test-helpers'

const HATCH_ID = ESTATE_2026_10_17[1].id
const NOW = Date.parse('2026-10-17T17:00:00Z')
const STARTS = new Date(NOW + 30 * 60_000).toISOString() // the default 30 min lead

const req = () => new Request('https://x.test/api/cron/send-class-booking-reminders', { headers: { authorization: 'Bearer shh' } })
const row = (id, location_id, source_platform = 'glofox') => ({
  id, contact_id: 'c-' + id, location_id, class_name: 'HIIT', starts_at: STARTS, source_platform,
})

// class_bookings answered the way PostgREST would: the .eq filters apply, so a
// dropped source_platform filter is a wrong result, not a canned pass.
function dbFor(bookingRows, { un1tListError = null } = {}) {
  const loc = locationsResolver(ESTATE_2026_10_17)
  return fakeDb((q) => {
    if (q.table === 'locations') {
      if (un1tListError && q.eq.membership_source === 'un1t_online') return { data: null, error: un1tListError }
      return loc(q)
    }
    if (q.table === 'class_bookings') {
      const page = q.calls.find(([op]) => op === 'range')
      if (page && page[1] > 0) return { data: [], error: null }
      const data = bookingRows.filter((r) => Object.entries(q.eq).every(([k, v]) => r[k] === v))
      return { data, error: null }
    }
    return { data: [], error: null }
  })
}

const bookingQuery = () => queriesOf(h.db, 'class_bookings')[0]
const remindedBookings = () => sendNudgeOnce.mock.calls.map(([, a]) => a.dedupKey.split(':')[0])

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  process.env.CRON_SECRET = 'shh'
})

describe('send-class-booking-reminders — un1t.online hard-off (UN1TBOOK.2, Decision 1)', () => {
  it('a un1t_online booking in the window is never pushed or claimed; Stillorgan in the same tick is', async () => {
    h.db = dbFor([row('cb-still', STILLORGAN_ID), row('cb-hatch', HATCH_ID, 'un1t_online')])
    const out = await (await GET(req())).json()
    expect(bookingQuery().calls).toContainEqual(['eq', 'source_platform', 'glofox'])
    expect(sendNudgeOnce).toHaveBeenCalledTimes(1)
    expect(remindedBookings()).toEqual(['cb-still'])
    expect(out).toMatchObject({ ok: true, sent: 1, skipped_un1t_online: 0 })
    expect(stampHeartbeat).toHaveBeenCalledWith('send-class-booking-reminders')
  })

  it('a glofox-tagged booking at a un1t_online location is skipped and counted', async () => {
    h.db = dbFor([row('cb-still', STILLORGAN_ID), row('cb-hatch-glofox', HATCH_ID, 'glofox')])
    const out = await (await GET(req())).json()
    expect(remindedBookings()).toEqual(['cb-still'])
    expect(out).toMatchObject({ ok: true, sent: 1, skipped_un1t_online: 1 })
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
    expect(out).toMatchObject({ ok: true, sent: 1, skipped_un1t_online: 0 })
    expect(logError).toHaveBeenCalledWith('cron-class-reminders', expect.stringContaining('un1t_online'), expect.anything())
    expect(stampHeartbeat).toHaveBeenCalledWith('send-class-booking-reminders')
  })
})

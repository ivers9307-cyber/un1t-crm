// W1.M3b — attendance credits skip bookings at locations with NO membership
// source (counted skipped_no_source) through the seam; a failed seam read is
// a 500 with no heartbeat.
//
// UN1TBOOK.2 — Decision 1 (2026-10-17): the CRM never credits attendance
// (sessions, points, achievement/goal/tier pushes) for a un1t.online booking
// or at a un1t.online studio, whatever the provider's capabilities say: the
// booking read filters source_platform = 'glofox', and a row at a un1t_online
// location is skipped with its own counter (skipped_un1t_online).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null, un1tBookings: false }))
// The un1t.online provider with a switchable `bookings` capability, so a test
// can play P1.2 flipping it true (Review Focus 2). Everything else is as shipped.
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
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/live-class', () => ({
  createParticipationSession: vi.fn(async () => 'sess-1'),
  finalizeSessionRewards: vi.fn(async () => {}),
}))
vi.mock('@/lib/heart-rate', () => ({ resolveScoringConfig: () => ({ participationPoints: 10 }), resolveMaxHr: () => 190 }))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { createParticipationSession } from '@/lib/live-class'
import { logError } from '@/lib/log'
import { fakeDb, queriesOf } from '@/lib/time-off.test-helpers'
import { MEMBERSHIP_SOURCES } from '@/lib/membership/source'
import { ESTATE_2026_10, ESTATE_2026_10_17, STILLORGAN_ID, locationsResolver } from '@/lib/membership/locations-for-source.test-helpers'

const HATCH_ID = ESTATE_2026_10[1].id
const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
const booking = (id, location_id, source_platform = 'glofox') => ({
  id, location_id, glofox_event_id: 'ev-' + id, contact_id: 'c-' + id, class_name: 'HIIT', starts_at: new Date(Date.now() - 3 * 3600_000).toISOString(), source_platform,
})
// class_bookings answered the way PostgREST would: the .eq filters apply, so a
// dropped source_platform filter is a wrong result, not a canned pass.
const dbFor = (rows, { bookings = [booking('b1', STILLORGAN_ID), booking('b2', HATCH_ID)], un1tListError = null, ...opts } = {}) => {
  const loc = locationsResolver(rows, opts)
  return fakeDb((q) => {
    if (q.table === 'locations') {
      if (un1tListError && q.eq.membership_source === 'un1t_online') return { data: null, error: un1tListError }
      return loc(q)
    }
    if (q.table === 'class_bookings') {
      if (q.calls.some(([op, from]) => op === 'range' && from > 0)) return { data: [], error: null }
      return { data: bookings.filter((b) => Object.entries(q.eq).every(([k, v]) => k === 'attended' || b[k] === v)), error: null }
    }
    return { data: [], error: null }
  })
}
const creditedLocations = () => createParticipationSession.mock.calls.map(([, a]) => a.locationId)
const bookingQuery = () => queriesOf(h.db, 'class_bookings')[0]
beforeEach(() => { process.env.CRON_SECRET = 'test-secret'; vi.clearAllMocks(); h.un1tBookings = false })

describe('GET /api/cron/credit-attendance — skips bookings at locations with no membership source (W1.M3b)', () => {
  it('credits the Stillorgan booking, skips the Hatch one with a count, stamps', async () => {
    h.db = dbFor(ESTATE_2026_10)
    const out = await (await GET(req())).json()
    expect(createParticipationSession.mock.calls.map(([, a]) => a.locationId)).toEqual([STILLORGAN_ID])
    expect(out).toMatchObject({ success: true, scanned: 2, credited: 1, skipped_no_source: 1 })
    expect(stampHeartbeat).toHaveBeenCalledWith('credit-attendance')
  })

  it('UN1TCAP.1 / UN1TBOOK.2 — Hatch on un1t.online is still skipped, counted as skipped_un1t_online (not skipped_no_source), stamps', async () => {
    h.db = dbFor(ESTATE_2026_10_17)
    const out = await (await GET(req())).json()
    expect(createParticipationSession.mock.calls.map(([, a]) => a.locationId)).toEqual([STILLORGAN_ID])
    expect(out).toMatchObject({ success: true, scanned: 2, credited: 1, skipped_no_source: 0, skipped_un1t_online: 1 })
    expect(stampHeartbeat).toHaveBeenCalledWith('credit-attendance')
  })
  it('a failed seam read answers 500, credits nothing and does NOT stamp', async () => {
    h.db = dbFor(ESTATE_2026_10, { listError: { message: 'down' } })
    expect((await GET(req())).status).toBe(500)
    expect(createParticipationSession).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

describe('GET /api/cron/credit-attendance — un1t.online hard-off (UN1TBOOK.2, Decision 1)', () => {
  it('the booking read filters source_platform glofox', async () => {
    h.db = dbFor(ESTATE_2026_10_17)
    await GET(req())
    expect(bookingQuery().calls).toContainEqual(['eq', 'source_platform', 'glofox'])
  })

  it('with the un1t_online provider\'s bookings capability forced true, a Hatch attended row is still not credited', async () => {
    h.un1tBookings = true
    // The mock must reach the registry the route reads, or this test proves nothing.
    expect(MEMBERSHIP_SOURCES.un1t_online.capabilities.bookings).toBe(true)
    // A glofox-tagged row at Hatch: neither the row filter nor the capability
    // skip catches it, so only the un1t_online location drop stands between it
    // and a credit.
    h.db = dbFor(ESTATE_2026_10_17, { bookings: [booking('b1', STILLORGAN_ID), booking('b2', HATCH_ID, 'glofox'), booking('b3', HATCH_ID, 'un1t_online')] })
    const out = await (await GET(req())).json()
    expect(creditedLocations()).toEqual([STILLORGAN_ID])
    expect(out).toMatchObject({ success: true, scanned: 2, credited: 1, skipped_no_source: 0, skipped_un1t_online: 1 })
    expect(stampHeartbeat).toHaveBeenCalledWith('credit-attendance')
  })

  it('a Hatch row whose location is no longer un1t_online is still not credited (the row filter)', async () => {
    // Hatch moved to glofox while its projected un1t rows remain: no location
    // skip applies, only the source_platform filter on the read.
    const moved = ESTATE_2026_10_17.map((r) => (r.id === HATCH_ID ? { ...r, membership_source: 'glofox' } : r))
    h.db = dbFor(moved, { bookings: [booking('b1', STILLORGAN_ID), booking('b2', HATCH_ID, 'un1t_online')] })
    const out = await (await GET(req())).json()
    expect(bookingQuery().calls).toContainEqual(['eq', 'source_platform', 'glofox'])
    expect(creditedLocations()).toEqual([STILLORGAN_ID])
    expect(out).toMatchObject({ success: true, scanned: 1, credited: 1, skipped_un1t_online: 0 })
  })

  it('a failed un1t_online locations read answers 500, credits nothing and does not stamp', async () => {
    // bookings forced true so the capability seam never reads the un1t_online
    // list: the 500 comes from the hard-off's own read.
    h.un1tBookings = true
    h.db = dbFor(ESTATE_2026_10_17, { un1tListError: { message: 'down' } })
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(createParticipationSession).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('cron-credit-attendance', expect.stringContaining('un1t_online'), expect.anything())
  })
})

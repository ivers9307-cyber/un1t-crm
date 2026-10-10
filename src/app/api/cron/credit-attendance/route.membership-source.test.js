// W1.M3b — attendance credits skip bookings at locations with NO membership
// source (counted skipped_no_source) through the seam; a failed seam read is
// a 500 with no heartbeat.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null }))
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
import { fakeDb } from '@/lib/time-off.test-helpers'
import { ESTATE_2026_10, STILLORGAN_ID, locationsResolver } from '@/lib/membership/locations-for-source.test-helpers'

const HATCH_ID = ESTATE_2026_10[1].id
const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
const booking = (id, location_id) => ({
  id, location_id, glofox_event_id: 'ev-' + id, contact_id: 'c-' + id, class_name: 'HIIT', starts_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
})
const dbFor = (rows, opts) => {
  const loc = locationsResolver(rows, opts)
  return fakeDb((q) => {
    if (q.table === 'locations') return loc(q)
    if (q.table === 'class_bookings') return { data: q.calls.some(([op, from]) => op === 'range' && from > 0) ? [] : [booking('b1', STILLORGAN_ID), booking('b2', HATCH_ID)], error: null }
    return { data: [], error: null }
  })
}
beforeEach(() => { process.env.CRON_SECRET = 'test-secret'; vi.clearAllMocks() })

describe('GET /api/cron/credit-attendance — skips bookings at locations with no membership source (W1.M3b)', () => {
  it('credits the Stillorgan booking, skips the Hatch one with a count, stamps', async () => {
    h.db = dbFor(ESTATE_2026_10)
    const out = await (await GET(req())).json()
    expect(createParticipationSession.mock.calls.map(([, a]) => a.locationId)).toEqual([STILLORGAN_ID])
    expect(out).toMatchObject({ success: true, scanned: 2, credited: 1, skipped_no_source: 1 })
    expect(stampHeartbeat).toHaveBeenCalledWith('credit-attendance')
  })
  it('a failed seam read answers 500, credits nothing and does NOT stamp', async () => {
    h.db = dbFor(ESTATE_2026_10, { listError: { message: 'down' } })
    expect((await GET(req())).status).toBe(500)
    expect(createParticipationSession).not.toHaveBeenCalled()
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

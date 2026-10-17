// W1.M3b / UN1TREAD.5 — the membership snapshot walks every active location
// and snapshots those whose membership source provides member counts (the
// UN1TREAD seam: Glofox and un1t.online), skipping the rest with a counted
// skipped_no_source. A failed locations read is a 500 with no heartbeat; a
// per-location failure is recorded and the run continues and stamps.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null, rows: [], unknown: new Set() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => h.db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/membership-snapshot', () => ({
  writeMembershipSnapshot: vi.fn(async () => ({ total: 1 })),
  computeMembershipCounts: vi.fn(async () => ({ total_members: 5, source: 'glofox-counts' })),
}))
vi.mock('@/lib/membership/reads/un1t-online', () => ({
  un1tOnlineReads: Object.freeze({ membershipCounts: vi.fn(async () => ({ total_members: 9, source: 'un1t-counts' })) }),
}))
// The source state is judged by the seam's own tests; here it follows the row's column.
vi.mock('@/lib/membership/state-for-page', async (importOriginal) => {
  const real = await importOriginal()
  return {
    ...real,
    membershipStateForPage: vi.fn(async (_db, id) => {
      if (h.unknown.has(id)) return { source: null, state: 'unknown', label: 'No membership source', readError: 'MEMBERSHIP_SOURCE_UNREADABLE', capabilities: {} }
      const src = h.rows.find((r) => r.id === id)?.membership_source ?? 'none'
      return { source: src, state: src === 'none' ? 'none' : 'configured', label: src, capabilities: {} }
    }),
  }
})

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { writeMembershipSnapshot, computeMembershipCounts } from '@/lib/membership-snapshot'
import { un1tOnlineReads } from '@/lib/membership/reads/un1t-online'
import { fakeDb } from '@/lib/time-off.test-helpers'
import { ESTATE_2026_10, ESTATE_2026_10_17, STILLORGAN_ID, locationsResolver } from '@/lib/membership/locations-for-source.test-helpers'

const HATCH_ID = '28c78d6b-0000-0000-0000-000000000002'
const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
const visited = () => writeMembershipSnapshot.mock.calls.map(([, id]) => id)
const useEstate = (rows, opts) => { h.rows = rows; h.db = fakeDb(locationsResolver(rows, opts)) }
beforeEach(() => { process.env.CRON_SECRET = 'test-secret'; vi.clearAllMocks(); h.unknown = new Set() })

describe('GET /api/cron/membership-snapshot — snapshots sources that provide member counts', () => {
  it('snapshots Stillorgan, skips the five none locations with a count, stamps', async () => {
    useEstate(ESTATE_2026_10)
    const out = await (await GET(req())).json()
    expect(visited()).toEqual([STILLORGAN_ID])
    expect(out).toMatchObject({ success: true, locations_processed: 1, skipped_no_source: 5 })
    expect(stampHeartbeat).toHaveBeenCalledWith('membership-snapshot')
  })

  it('UN1TREAD.5 — snapshots Stillorgan (glofox) and Hatch (un1t.online, un1t counts); still skips the four none locations', async () => {
    useEstate(ESTATE_2026_10_17)
    const out = await (await GET(req())).json()
    expect(visited()).toEqual([STILLORGAN_ID, HATCH_ID])
    const byLoc = Object.fromEntries(writeMembershipSnapshot.mock.calls.map(([, id, opts]) => [id, opts]))
    expect(byLoc[STILLORGAN_ID].counts).toEqual({ total_members: 5, source: 'glofox-counts' })
    expect(byLoc[HATCH_ID].counts).toEqual({ total_members: 9, source: 'un1t-counts' })
    expect(computeMembershipCounts).toHaveBeenCalledTimes(1)
    expect(computeMembershipCounts.mock.calls[0][1]).toBe(STILLORGAN_ID)
    expect(un1tOnlineReads.membershipCounts).toHaveBeenCalledTimes(1)
    expect(un1tOnlineReads.membershipCounts.mock.calls[0][1]).toBe(HATCH_ID)
    expect(out).toMatchObject({ success: true, locations_processed: 2, skipped_no_source: 4 })
    expect(stampHeartbeat).toHaveBeenCalledWith('membership-snapshot')
  })

  it('a failed un1t counts read records that location\'s error and continues; the heartbeat still stamps', async () => {
    useEstate(ESTATE_2026_10_17)
    un1tOnlineReads.membershipCounts.mockRejectedValueOnce(new Error('un1t_subscriptions: boom'))
    const out = await (await GET(req())).json()
    expect(visited()).toEqual([STILLORGAN_ID])
    expect(out).toMatchObject({ success: false, locations_processed: 2, skipped_no_source: 4 })
    expect(out.first_error).toContain(HATCH_ID)
    expect(out.first_error).toContain('un1t_subscriptions: boom')
    expect(out.snapshots.find((s) => s.location_id === HATCH_ID).error).toBe('un1t_subscriptions: boom')
    expect(stampHeartbeat).toHaveBeenCalledWith('membership-snapshot')
  })

  it('a location whose source state is unknown is skipped (counted, never zeros); the others still snapshot and stamp', async () => {
    useEstate(ESTATE_2026_10_17)
    h.unknown.add(HATCH_ID)
    const out = await (await GET(req())).json()
    expect(visited()).toEqual([STILLORGAN_ID])
    expect(un1tOnlineReads.membershipCounts).not.toHaveBeenCalled()
    expect(out).toMatchObject({ locations_processed: 1, skipped_no_source: 4, skipped_unknown: 1 })
    expect(stampHeartbeat).toHaveBeenCalledWith('membership-snapshot')
  })

  it('a failed locations read answers 500 and does NOT stamp', async () => {
    h.rows = ESTATE_2026_10
    h.db = fakeDb((q) => (q.table === 'locations' ? { data: null, error: { message: 'down' } } : { data: [], error: null }))
    expect((await GET(req())).status).toBe(500)
    expect(visited()).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

// W1.M3b / UN1TREAD.5 — the membership snapshot walks every active location
// and snapshots those whose membership source provides member counts (the
// UN1TREAD seam: Glofox and un1t.online), skipping the rest with a counted
// skipped_no_source. A failed locations read is a 500 with no heartbeat; a
// per-location failure is recorded and the run continues and stamps.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null, rows: [], unknown: new Set(), override: new Map(), clients: 0 }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => { h.clients++; return h.db } }))
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
      if (h.override.has(id)) return { label: 'x', capabilities: {}, ...h.override.get(id) }
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
import { logError, logWarn } from '@/lib/log'
import { fakeDb } from '@/lib/time-off.test-helpers'
import { ESTATE_2026_10, ESTATE_2026_10_17, HATCH_ID, STILLORGAN_ID, locationsResolver } from '@/lib/membership/locations-for-source.test-helpers'

const req = (auth = 'Bearer test-secret') => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } })
const visited = () => writeMembershipSnapshot.mock.calls.map(([, id]) => id)
const useEstate = (rows, opts) => { h.rows = rows; h.db = fakeDb(locationsResolver(rows, opts)) }
beforeEach(() => { process.env.CRON_SECRET = 'test-secret'; vi.clearAllMocks(); h.unknown = new Set(); h.override = new Map(); h.clients = 0 })

describe('GET /api/cron/membership-snapshot — snapshots sources that provide member counts', () => {
  it('401 without the cron secret: nothing read, nothing written, nothing stamped', async () => {
    useEstate(ESTATE_2026_10)
    const res = await GET(req('Bearer wrong'))
    expect(res.status).toBe(401)
    expect(h.clients).toBe(0)
    expect(visited()).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('snapshots Stillorgan, skips the five none locations with a count, stamps exactly its own row', async () => {
    useEstate(ESTATE_2026_10)
    const res = await GET(req())
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(visited()).toEqual([STILLORGAN_ID])
    expect(out).toMatchObject({ success: true, locations_processed: 1, locations_failed: 0, skipped_no_source: 5 })
    expect(stampHeartbeat.mock.calls).toEqual([['membership-snapshot']])
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
    const err = new Error('un1t_subscriptions: boom')
    un1tOnlineReads.membershipCounts.mockRejectedValueOnce(err)
    const res = await GET(req())
    // ROUTEWRAP.C9 — a failed run that still stamps: success:false, 200 as before.
    expect(res.status).toBe(200)
    const out = await res.json()
    expect(visited()).toEqual([STILLORGAN_ID])
    expect(out).toMatchObject({ success: false, locations_processed: 2, locations_failed: 1, skipped_no_source: 4 })
    expect(out.snapshots.find((s) => s.location_id === HATCH_ID).error).toBe('snapshot failed')
    expect(stampHeartbeat.mock.calls).toEqual([['membership-snapshot']])
    // The error text is logged (ids only beside it), never answered.
    expect(JSON.stringify(out)).not.toContain('boom')
    expect(JSON.stringify(out)).not.toContain('un1t_subscriptions')
    expect(out).not.toHaveProperty('first_error')
    expect(logError).toHaveBeenCalledWith('membership-snapshot', 'location snapshot failed', { locationId: HATCH_ID, err })
  })

  it('a Glofox location in state unconfigured (credentials missing) IS snapshotted from stored contacts', async () => {
    useEstate(ESTATE_2026_10)
    h.override.set(STILLORGAN_ID, { source: 'glofox', state: 'unconfigured', missing: ['api_key'] })
    const out = await (await GET(req())).json()
    expect(visited()).toEqual([STILLORGAN_ID])
    expect(out).toMatchObject({ success: true, locations_processed: 1, skipped_no_source: 5 })
    expect(stampHeartbeat).toHaveBeenCalled()
  })

  it('a Glofox location whose credential read failed (state unknown, source glofox) IS snapshotted', async () => {
    useEstate(ESTATE_2026_10)
    h.override.set(STILLORGAN_ID, { source: 'glofox', state: 'unknown', readError: 'GLOFOX_CREDENTIALS_UNREADABLE' })
    const out = await (await GET(req())).json()
    expect(visited()).toEqual([STILLORGAN_ID])
    expect(out).toMatchObject({ success: true, locations_processed: 1, skipped_unknown: 0 })
  })

  it("a registered-but-unserved key ('un1t') is skipped_no_source, not snapshotted", async () => {
    useEstate(ESTATE_2026_10)
    h.override.set(HATCH_ID, { source: 'un1t', state: 'unconfigured', missing: ['provider'] })
    const out = await (await GET(req())).json()
    expect(visited()).toEqual([STILLORGAN_ID])
    expect(out).toMatchObject({ locations_processed: 1, skipped_no_source: 5 })
  })

  it('one location whose source key is unreadable (source null) is skipped, counted, logged; the rest snapshot and stamp', async () => {
    useEstate(ESTATE_2026_10_17)
    h.unknown.add(HATCH_ID)
    const out = await (await GET(req())).json()
    expect(visited()).toEqual([STILLORGAN_ID])
    expect(un1tOnlineReads.membershipCounts).not.toHaveBeenCalled()
    expect(out).toMatchObject({ success: true, locations_processed: 1, skipped_no_source: 4, skipped_unknown: 1 })
    expect(logError).toHaveBeenCalled()
    expect(stampHeartbeat).toHaveBeenCalledWith('membership-snapshot')
  })

  it('every location unreadable (source null) visits nobody: 500 and NO heartbeat', async () => {
    useEstate(ESTATE_2026_10_17)
    for (const r of ESTATE_2026_10_17) h.unknown.add(r.id)
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'membership source unreadable for every eligible location', skipped_unknown: ESTATE_2026_10_17.length })
    expect(visited()).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })

  it('a failed locations read answers a fixed 500 (no DB text) and does NOT stamp', async () => {
    h.rows = ESTATE_2026_10
    h.db = fakeDb((q) => (q.table === 'locations' ? { data: null, error: { message: 'relation secret_locations down' } } : { data: [], error: null }))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'could not list locations' })
    expect(logWarn).toHaveBeenCalled()
    expect(visited()).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

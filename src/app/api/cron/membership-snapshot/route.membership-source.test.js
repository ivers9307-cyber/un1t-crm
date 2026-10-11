// W1.M3b — the membership snapshot walks every active location but skips
// those with NO membership source (counted skipped_no_source) through the
// seam; a failed seam read is a 500 with no heartbeat.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ db: null }))
vi.mock('@/lib/supabase', () => ({ createServerClient: () => h.db }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/membership-snapshot', () => ({ writeMembershipSnapshot: vi.fn(async () => ({ total: 1 })) }))

import { GET } from './route.js'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { writeMembershipSnapshot } from '@/lib/membership-snapshot'
import { fakeDb } from '@/lib/time-off.test-helpers'
import { ESTATE_2026_10, STILLORGAN_ID, locationsResolver } from '@/lib/membership/locations-for-source.test-helpers'

const req = () => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? 'Bearer test-secret' : null) } })
const visited = () => writeMembershipSnapshot.mock.calls.map(([, id]) => id)
beforeEach(() => { process.env.CRON_SECRET = 'test-secret'; vi.clearAllMocks() })

describe('GET /api/cron/membership-snapshot — skips locations with no membership source (W1.M3b)', () => {
  it('snapshots Stillorgan, skips the five none locations with a count, stamps', async () => {
    h.db = fakeDb(locationsResolver(ESTATE_2026_10))
    const out = await (await GET(req())).json()
    expect(visited()).toEqual([STILLORGAN_ID])
    expect(out).toMatchObject({ success: true, locations_processed: 1, skipped_no_source: 5 })
    expect(stampHeartbeat).toHaveBeenCalledWith('membership-snapshot')
  })
  it('a failed seam read answers 500 and does NOT stamp', async () => {
    h.db = fakeDb(locationsResolver(ESTATE_2026_10, { listError: { message: 'down' } }))
    expect((await GET(req())).status).toBe(500)
    expect(visited()).toEqual([])
    expect(stampHeartbeat).not.toHaveBeenCalled()
  })
})

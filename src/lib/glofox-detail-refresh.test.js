import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the two external deps so the lib's logic is tested in isolation.
vi.mock('./glofox.js', () => ({
  fetchMemberDetail: vi.fn(),
}))
vi.mock('./glofox-sync.js', () => ({
  applyMemberSync: vi.fn(async () => ({ action: 'update' })),
}))

import { fetchMemberDetail } from './glofox.js'
import { applyMemberSync } from './glofox-sync.js'
import {
  DETAIL_COHORT_STATUSES,
  selectDetailRefreshBatch,
  mapWithConcurrency,
  refreshOneContact,
} from './glofox-detail-refresh.js'

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

// ── chainable fake Supabase query builder ───────────────────────────
function fakeContactsQuery(rows) {
  const calls = {}
  const builder = {
    from: vi.fn(() => builder),
    select: vi.fn(() => builder),
    not: vi.fn((...a) => { calls.not = a; return builder }),
    in: vi.fn((col, vals) => { calls.in = { col, vals }; return builder }),
    or: vi.fn((s) => { calls.or = s; return builder }),
    order: vi.fn((col, opts) => { calls.order = { col, opts }; return builder }),
    limit: vi.fn((n) => { calls.limit = n; return Promise.resolve({ data: rows, error: null }) }),
    _calls: calls,
  }
  return builder
}

describe('selectDetailRefreshBatch', () => {
  it('filters to the cohort, never-synced-first, with limit', async () => {
    const rows = [{ id: 'c1', glofox_member_id: 'g1', location_id: 'L' }]
    const q = fakeContactsQuery(rows)
    const db = { from: () => q }
    const out = await selectDetailRefreshBatch(db, { limit: 250 })
    expect(out).toEqual(rows)
    expect(q._calls.in.col).toBe('glofox_membership_status')
    expect(q._calls.in.vals).toEqual(DETAIL_COHORT_STATUSES)
    expect(q._calls.order.col).toBe('glofox_detail_synced_at')
    expect(q._calls.order.opts).toMatchObject({ ascending: true, nullsFirst: true })
    expect(q._calls.limit).toBe(250)
    expect(q._calls.or).toBeUndefined() // no staleBefore → no OR clause
  })

  it('adds the null-OR-stale clause when staleBefore is given', async () => {
    const q = fakeContactsQuery([])
    const db = { from: () => q }
    await selectDetailRefreshBatch(db, { limit: 10, staleBefore: '2026-05-23T00:00:00.000Z' })
    expect(q._calls.or).toContain('glofox_detail_synced_at.is.null')
    expect(q._calls.or).toContain('glofox_detail_synced_at.lt.2026-05-23T00:00:00.000Z')
  })

  it('throws on db error', async () => {
    const q = {
      from: () => q, select: () => q, not: () => q, in: () => q,
      order: () => q, limit: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
    }
    await expect(selectDetailRefreshBatch({ from: () => q }, {})).rejects.toThrow(/boom/)
  })
})

describe('mapWithConcurrency', () => {
  it('never exceeds the concurrency cap and preserves input order', async () => {
    let inFlight = 0
    let peak = 0
    const fn = async (x) => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return x * 2
    }
    const items = Array.from({ length: 20 }, (_, i) => i)
    const res = await mapWithConcurrency(items, 5, fn)
    expect(peak).toBeLessThanOrEqual(5)
    expect(res.map((r) => r.value)).toEqual(items.map((i) => i * 2))
  })

  it('isolates failures as rejected results without throwing', async () => {
    const res = await mapWithConcurrency([1, 2, 3], 2, async (x) => {
      if (x === 2) throw new Error('nope')
      return x
    })
    expect(res[0]).toMatchObject({ status: 'fulfilled', value: 1 })
    expect(res[1]).toMatchObject({ status: 'rejected' })
    expect(res[2]).toMatchObject({ status: 'fulfilled', value: 3 })
  })

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 5, async () => 1)).toEqual([])
  })
})

describe('refreshOneContact', () => {
  const makeDb = () => {
    const update = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }))
    return { db: { from: vi.fn(() => ({ update })) }, update }
  }

  it('syncs detail and stamps the cursor when the member exists', async () => {
    fetchMemberDetail.mockResolvedValueOnce({ _id: 'g1', membership_plan_name: '3 Month' })
    const { db, update } = makeDb()
    const r = await refreshOneContact(db, { id: 'c1', glofox_member_id: 'g1', location_id: 'L' },
      { branchId: 'b' }, { now: () => 'NOW' })
    expect(r).toBe('synced')
    expect(applyMemberSync).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledWith({ glofox_detail_synced_at: 'NOW' })
  })

  it('stamps the cursor but does not sync when the member is gone (404)', async () => {
    fetchMemberDetail.mockResolvedValueOnce(null)
    const { db, update } = makeDb()
    const r = await refreshOneContact(db, { id: 'c1', glofox_member_id: 'gX', location_id: 'L' }, {})
    expect(r).toBe('gone')
    expect(applyMemberSync).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledOnce()
  })

  it('skips when memberId or locationId is missing', async () => {
    const { db } = makeDb()
    expect(await refreshOneContact(db, { id: 'c1', location_id: 'L' }, {})).toBe('skipped')
    expect(await refreshOneContact(db, { id: 'c1', glofox_member_id: 'g1' }, {})).toBe('skipped')
    expect(fetchMemberDetail).not.toHaveBeenCalled()
  })
})

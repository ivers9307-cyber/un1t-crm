import { describe, it, expect, vi } from 'vitest'
import { summariseBackfill, runGlofoxBackfillBatch } from './glofox-backfill.js'

describe('summariseBackfill', () => {
  it('tallies statuses into created/linked/needs_review/failed', () => {
    const out = summariseBackfill([
      { status: 'created' }, { status: 'linked' }, { status: 'created' },
      { status: 'needs_review' }, { status: 'failed' }, { status: 'skipped' },
    ])
    expect(out).toEqual({ processed: 6, created: 2, linked: 1, needs_review: 1, failed: 1, skipped: 1 })
  })
  it('handles empty', () => {
    expect(summariseBackfill([])).toEqual({ processed: 0, created: 0, linked: 0, needs_review: 0, failed: 0, skipped: 0 })
  })
})

describe('runGlofoxBackfillBatch', () => {
  it('calls findOrCreateGlofoxMember create+trial source=automation per contact, returns a summary + remaining', async () => {
    const rows = [
      { id: 'c1', email: 'a@b.com', location_id: 'loc1' },
      { id: 'c2', email: 'c@d.com', location_id: 'loc1' },
    ]
    const db = {
      rpc: vi.fn(async (fn) => {
        if (fn === 'glofox_backfill_eligible_batch') return { data: rows, error: null }
        if (fn === 'glofox_backfill_eligible_count') return { data: 3, error: null }
        throw new Error(fn)
      }),
    }
    const spy = vi.fn(async () => ({ status: 'created' }))
    const res = await runGlofoxBackfillBatch({ db, locationId: 'loc1', limit: 2, _findOrCreateGlofoxMember: spy, _delayMs: 0 })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[0][0]).toMatchObject({ createIfMissing: true, attachTrial: true, source: 'automation', locationId: 'loc1' })
    expect(res.processed).toBe(2)
    expect(res.created).toBe(2)
    expect(res.remaining).toBe(3)
  })

  it('returns processed:0, remaining:0 when nothing is eligible', async () => {
    const db = {
      rpc: vi.fn(async (fn) => {
        if (fn === 'glofox_backfill_eligible_batch') return { data: [], error: null }
        if (fn === 'glofox_backfill_eligible_count') return { data: 0, error: null }
      }),
    }
    const spy = vi.fn()
    const res = await runGlofoxBackfillBatch({ db, locationId: 'loc1', limit: 20, _findOrCreateGlofoxMember: spy, _delayMs: 0 })
    expect(spy).not.toHaveBeenCalled()
    expect(res).toMatchObject({ processed: 0, remaining: 0 })
  })

  it('one contact throwing does not abort the batch', async () => {
    const rows = [{ id: 'c1', email: 'a@b.com', location_id: 'loc1' }, { id: 'c2', email: 'c@d.com', location_id: 'loc1' }]
    const db = {
      rpc: vi.fn(async (fn) => {
        if (fn === 'glofox_backfill_eligible_batch') return { data: rows, error: null }
        if (fn === 'glofox_backfill_eligible_count') return { data: 0, error: null }
      }),
    }
    const spy = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 'created' })
    const res = await runGlofoxBackfillBatch({ db, locationId: 'loc1', limit: 20, _findOrCreateGlofoxMember: spy, _delayMs: 0 })
    expect(res.processed).toBe(2)
    expect(res.failed).toBe(1)
    expect(res.created).toBe(1)
  })
})

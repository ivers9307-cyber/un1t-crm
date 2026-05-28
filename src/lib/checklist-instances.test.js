// CHECKLIST.2 — unit tests for the pure helpers + the tickItem
// flow via a mocked supabase chainable.

import { describe, it, expect, vi } from 'vitest'
import {
  INSTANCE_STATUS,
  todayInTimezone,
  computeDeadlineAt,
  computeStatus,
  applyTick,
  tickItem,
} from './checklist-instances.js'

// ----------------------------------------------------------------
// todayInTimezone — Pg dow + ISO date
// ----------------------------------------------------------------

describe('todayInTimezone', () => {
  it('returns YYYY-MM-DD in the given timezone', () => {
    // 2026-05-28T01:00:00Z is 02:00 in Dublin → same calendar date.
    const out = todayInTimezone(new Date('2026-05-28T01:00:00Z'), 'Europe/Dublin')
    expect(out.date).toBe('2026-05-28')
  })

  it('crosses the date line correctly for a tz ahead of UTC', () => {
    // 2026-05-27T23:00:00Z is 09:00 Sydney on 2026-05-28.
    const out = todayInTimezone(new Date('2026-05-27T23:00:00Z'), 'Australia/Sydney')
    expect(out.date).toBe('2026-05-28')
  })

  it('returns dow with Sun=0 .. Sat=6 (Pg convention)', () => {
    // 2026-05-28 is a Thursday → dow 4.
    expect(todayInTimezone(new Date('2026-05-28T12:00:00Z'), 'Europe/Dublin').dow).toBe(4)
    // 2026-05-31 is a Sunday → dow 0.
    expect(todayInTimezone(new Date('2026-05-31T12:00:00Z'), 'Europe/Dublin').dow).toBe(0)
  })

  it('defaults to Europe/Dublin when no timezone passed', () => {
    expect(todayInTimezone(new Date('2026-05-28T01:00:00Z'), null).date).toBe('2026-05-28')
  })
})

// ----------------------------------------------------------------
// computeDeadlineAt
// ----------------------------------------------------------------

describe('computeDeadlineAt', () => {
  it('returns the END of the LATEST block today in the given tz', () => {
    const blocks = [
      { block_date: '2026-05-28', end_time: '12:00:00' },
      { block_date: '2026-05-28', end_time: '21:30:00' },
    ]
    const iso = computeDeadlineAt(blocks, 'Europe/Dublin')
    // 2026-05-28 21:30 Europe/Dublin in May = UTC+1 → 20:30Z.
    expect(iso).toBe(new Date('2026-05-28T20:30:00.000Z').toISOString())
  })

  it('returns null on an empty list', () => {
    expect(computeDeadlineAt([], 'Europe/Dublin')).toBeNull()
    expect(computeDeadlineAt(null, 'Europe/Dublin')).toBeNull()
  })

  it('skips malformed blocks', () => {
    const out = computeDeadlineAt([
      { block_date: '2026-05-28' },                        // no end_time
      { block_date: '2026-05-28', end_time: '15:00:00' },
    ], 'Europe/Dublin')
    expect(out).toBe(new Date('2026-05-28T14:00:00.000Z').toISOString())
  })
})

// ----------------------------------------------------------------
// computeStatus
// ----------------------------------------------------------------

describe('computeStatus', () => {
  it('returns pending when items snapshot is empty', () => {
    expect(computeStatus([], {})).toBe(INSTANCE_STATUS.PENDING)
  })

  it('returns pending while any item is unticked', () => {
    expect(computeStatus(
      [{ id: 'a' }, { id: 'b' }],
      { a: { checked_at: 't' } },
    )).toBe(INSTANCE_STATUS.PENDING)
  })

  it('returns complete when every item has a tick', () => {
    expect(computeStatus(
      [{ id: 'a' }, { id: 'b' }],
      { a: { checked_at: 't' }, b: { checked_at: 't' } },
    )).toBe(INSTANCE_STATUS.COMPLETE)
  })

  it('ignores stray keys in items_checked that no longer match the snapshot', () => {
    // E.g. an item was removed from the template after the instance
    // was generated. We still report complete based on the snapshot.
    expect(computeStatus(
      [{ id: 'a' }],
      { a: { checked_at: 't' }, b: { checked_at: 't' } },
    )).toBe(INSTANCE_STATUS.COMPLETE)
  })
})

// ----------------------------------------------------------------
// applyTick — returns a new map, mutates nothing
// ----------------------------------------------------------------

describe('applyTick', () => {
  it('sets a key with checked_at + checked_by when checked', () => {
    const at = new Date('2026-05-28T10:00:00Z')
    const next = applyTick({}, { itemId: 'a', checked: true, byProfileId: 'p1', at })
    expect(next.a.checked_at).toBe(at.toISOString())
    expect(next.a.checked_by).toBe('p1')
  })

  it('removes the key when unchecked', () => {
    const next = applyTick(
      { a: { checked_at: 't', checked_by: 'p' } },
      { itemId: 'a', checked: false, byProfileId: 'p' },
    )
    expect(next.a).toBeUndefined()
  })

  it('does not mutate the input map', () => {
    const input = {}
    applyTick(input, { itemId: 'a', checked: true, byProfileId: 'p' })
    expect(input).toEqual({})
  })

  it('handles a null input map', () => {
    const next = applyTick(null, { itemId: 'a', checked: true, byProfileId: 'p' })
    expect(next.a).toBeDefined()
  })
})

// ----------------------------------------------------------------
// tickItem via mocked db
// ----------------------------------------------------------------

function makeDb({ instance = null, updateResult = { data: null, error: null } } = {}) {
  const trackers = { updates: [] }
  const db = {}
  db.from = vi.fn(() => {
    const chain = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.maybeSingle = vi.fn(() => Promise.resolve({ data: instance, error: null }))
    chain.update = vi.fn((row) => {
      trackers.updates.push(row)
      return {
        eq: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn(() => Promise.resolve(updateResult)),
          })),
        })),
      }
    })
    return chain
  })
  return { db, trackers }
}

const baseInstance = {
  id: 'inst-1',
  profile_id: 'p-1',
  items: [{ id: 'a', label: 'one' }, { id: 'b', label: 'two' }],
  items_checked: {},
  status: 'pending',
  completed_at: null,
}

describe('tickItem', () => {
  it('rejects when required args are missing', async () => {
    const { db } = makeDb()
    const out = await tickItem(db, { instanceId: '', itemId: 'a', checked: true, user: { id: 'p-1' } })
    expect(out.ok).toBe(false)
    expect(out.code).toBe('bad_args')
  })

  it('404s when the instance does not exist', async () => {
    const { db } = makeDb({ instance: null })
    const out = await tickItem(db, { instanceId: 'x', itemId: 'a', checked: true, user: { id: 'p-1' } })
    expect(out.status).toBe(404)
    expect(out.code).toBe('not_found')
  })

  it('404s when the caller does not own the instance', async () => {
    const { db } = makeDb({ instance: { ...baseInstance, profile_id: 'someone-else' } })
    const out = await tickItem(db, { instanceId: 'inst-1', itemId: 'a', checked: true, user: { id: 'p-1' } })
    expect(out.status).toBe(404)
    expect(out.code).toBe('not_yours')
  })

  it('400s when the item is not on the checklist', async () => {
    const { db } = makeDb({ instance: baseInstance })
    const out = await tickItem(db, { instanceId: 'inst-1', itemId: 'zzz', checked: true, user: { id: 'p-1' } })
    expect(out.status).toBe(400)
    expect(out.code).toBe('unknown_item')
  })

  it("keeps status pending and writes items_checked when only some items are ticked", async () => {
    const { db, trackers } = makeDb({
      instance: baseInstance,
      updateResult: { data: { ...baseInstance, items_checked: { a: {} }, status: 'pending' }, error: null },
    })
    await tickItem(db, { instanceId: 'inst-1', itemId: 'a', checked: true, user: { id: 'p-1' } })
    expect(trackers.updates[0].status).toBe('pending')
    expect(trackers.updates[0].completed_at).toBeNull()
    expect(trackers.updates[0].items_checked.a).toBeDefined()
  })

  it("auto-transitions to complete + sets completed_at when the last item is ticked", async () => {
    const instance = {
      ...baseInstance,
      items_checked: { a: { checked_at: 't', checked_by: 'p-1' } },
    }
    const { db, trackers } = makeDb({
      instance,
      updateResult: { data: { ...instance, status: 'complete' }, error: null },
    })
    await tickItem(db, { instanceId: 'inst-1', itemId: 'b', checked: true, user: { id: 'p-1' } })
    expect(trackers.updates[0].status).toBe('complete')
    expect(typeof trackers.updates[0].completed_at).toBe('string')
  })

  it("reverts to pending + clears completed_at when an item is unticked from a complete state", async () => {
    const instance = {
      ...baseInstance,
      status: 'complete',
      completed_at: new Date('2026-05-28T10:00:00Z').toISOString(),
      items_checked: {
        a: { checked_at: 't', checked_by: 'p-1' },
        b: { checked_at: 't', checked_by: 'p-1' },
      },
    }
    const { db, trackers } = makeDb({
      instance,
      updateResult: { data: { ...instance, status: 'pending', completed_at: null }, error: null },
    })
    await tickItem(db, { instanceId: 'inst-1', itemId: 'a', checked: false, user: { id: 'p-1' } })
    expect(trackers.updates[0].status).toBe('pending')
    expect(trackers.updates[0].completed_at).toBeNull()
    expect(trackers.updates[0].items_checked.a).toBeUndefined()
  })
})

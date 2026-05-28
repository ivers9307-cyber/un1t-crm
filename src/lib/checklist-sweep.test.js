// CHECKLIST.3 — unit tests for the sweep helpers.

import { describe, it, expect, vi } from 'vitest'
import {
  COMPLIANCE_ROLES,
  listMissedItems,
  buildOverdueBody,
  isEligibleForSweep,
  markIncomplete,
} from './checklist-sweep.js'

// ----------------------------------------------------------------
// listMissedItems
// ----------------------------------------------------------------

describe('listMissedItems', () => {
  it('returns [] for a fully ticked instance', () => {
    const inst = {
      items: [{ id: 'a', label: 'one' }, { id: 'b', label: 'two' }],
      items_checked: { a: { checked_at: 't' }, b: { checked_at: 't' } },
    }
    expect(listMissedItems(inst)).toEqual([])
  })

  it('returns only the unticked items, in snapshot order', () => {
    const inst = {
      items: [
        { id: 'a', label: 'first',  order: 0 },
        { id: 'b', label: 'second', order: 1 },
        { id: 'c', label: 'third',  order: 2 },
      ],
      items_checked: { b: { checked_at: 't' } },
    }
    expect(listMissedItems(inst).map((i) => i.id)).toEqual(['a', 'c'])
  })

  it('survives a missing items array', () => {
    expect(listMissedItems({ items_checked: { a: {} } })).toEqual([])
  })

  it('returns [] when the instance itself is null', () => {
    expect(listMissedItems(null)).toEqual([])
  })
})

// ----------------------------------------------------------------
// buildOverdueBody
// ----------------------------------------------------------------

describe('buildOverdueBody', () => {
  it('returns null on an empty list', () => {
    expect(buildOverdueBody([])).toBeNull()
    expect(buildOverdueBody(null)).toBeNull()
  })

  it('lists all names when under the cap', () => {
    expect(buildOverdueBody([
      { label: 'Wipe kettlebells' },
      { label: 'Sanitise pads' },
    ])).toBe('Wipe kettlebells, Sanitise pads')
  })

  it('truncates with "+ N more" when over the cap', () => {
    const out = buildOverdueBody([
      { label: 'Wipe kettlebells' },
      { label: 'Sanitise pads' },
      { label: 'Lock back door' },
      { label: 'Empty dishwasher' },
      { label: 'Stock loo roll' },
    ])
    expect(out).toBe('Wipe kettlebells, Sanitise pads, Lock back door + 2 more')
  })

  it('skips items with no label', () => {
    expect(buildOverdueBody([{ label: '' }, { label: 'real' }])).toBe('real')
  })

  it("returns null when every item's label is empty", () => {
    expect(buildOverdueBody([{ label: '' }, { label: '' }])).toBeNull()
  })

  it('respects a custom maxNames', () => {
    expect(buildOverdueBody(
      [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
      { maxNames: 1 },
    )).toBe('a + 2 more')
  })
})

// ----------------------------------------------------------------
// isEligibleForSweep
// ----------------------------------------------------------------

const now = new Date('2026-05-28T22:00:00.000Z')

describe('isEligibleForSweep', () => {
  it('eligible when status=pending and deadline_at is in the past', () => {
    expect(isEligibleForSweep({
      status: 'pending',
      deadline_at: '2026-05-28T20:00:00.000Z',
    }, now).eligible).toBe(true)
  })

  it("returns not_due_yet when the deadline is still ahead", () => {
    expect(isEligibleForSweep({
      status: 'pending',
      deadline_at: '2026-05-29T03:00:00.000Z',
    }, now)).toEqual({ eligible: false, reason: 'not_due_yet' })
  })

  it('returns not_pending when the row has already completed', () => {
    expect(isEligibleForSweep({
      status: 'complete', deadline_at: '2026-05-28T20:00:00.000Z',
    }, now).reason).toBe('not_pending')
  })

  it('returns no_deadline when deadline_at is missing or malformed', () => {
    expect(isEligibleForSweep({ status: 'pending', deadline_at: null }, now).reason).toBe('no_deadline')
    expect(isEligibleForSweep({ status: 'pending', deadline_at: 'garbage' }, now).reason).toBe('no_deadline')
  })

  it('returns missing for null input', () => {
    expect(isEligibleForSweep(null, now).reason).toBe('missing')
  })
})

// ----------------------------------------------------------------
// markIncomplete via mocked supabase
// ----------------------------------------------------------------

function makeDb({ updateResult = { data: { id: 'i1', status: 'incomplete' }, error: null } } = {}) {
  const trackers = { updates: [], eqs: [] }
  const db = {}
  db.from = vi.fn(() => {
    const chain = {}
    chain.update = vi.fn((row) => {
      trackers.updates.push(row)
      return {
        eq: vi.fn((col, val) => {
          trackers.eqs.push([col, val])
          return {
            eq: vi.fn((col2, val2) => {
              trackers.eqs.push([col2, val2])
              return {
                select: vi.fn(() => ({
                  single: vi.fn(() => Promise.resolve(updateResult)),
                })),
              }
            }),
          }
        }),
      }
    })
    return chain
  })
  return { db, trackers }
}

describe('markIncomplete', () => {
  it("flips status to 'incomplete' and constrains the write to status='pending'", async () => {
    const { db, trackers } = makeDb()
    await markIncomplete(db, 'i1')
    expect(trackers.updates[0]).toEqual({ status: 'incomplete' })
    expect(trackers.eqs).toEqual([['id', 'i1'], ['status', 'pending']])
  })

  it('returns null on a missing id', async () => {
    const { db } = makeDb()
    expect(await markIncomplete(db, null)).toBeNull()
  })

  it('returns null on an error', async () => {
    const { db } = makeDb({ updateResult: { data: null, error: { message: 'boom' } } })
    expect(await markIncomplete(db, 'i1')).toBeNull()
  })
})

// ----------------------------------------------------------------
// COMPLIANCE_ROLES
// ----------------------------------------------------------------

describe('COMPLIANCE_ROLES', () => {
  it('targets head_coach + owner + master by default', () => {
    expect(COMPLIANCE_ROLES).toEqual(['head_coach', 'owner', 'master'])
  })
})

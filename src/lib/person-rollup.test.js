// Tests for person-rollup.js — pure, no DB.
//
// Covers every branch of combineGroupActivity and rollupByPerson:
//   - MAX for date strings, SUM for numeric fields, null handling
//   - Cross-status grouping (function ignores glofox_membership_status)
//   - Rows without person_group_id are ignored by combineGroupActivity
//   - rollupByPerson: ungrouped pass-through (same reference)
//   - rollupByPerson: primary-in-sweep kept; non-primary dropped
//   - rollupByPerson: representative fallback when primary not in sweep
//   - rollupByPerson: combined activity from combinedByGroup injected
//   - rollupByPerson: no-combinedByGroup entry → row passed as-is
//   - rollupByPerson: output order preserved; no input mutation

import { describe, it, expect } from 'vitest'
import { combineGroupActivity, rollupByPerson } from './person-rollup.js'

// ---------------------------------------------------------------------------
// combineGroupActivity
// ---------------------------------------------------------------------------

describe('combineGroupActivity', () => {
  it('returns an empty Map when no rows have person_group_id', () => {
    const rows = [
      { id: 'c1', last_attended_at: '2026-06-01T10:00:00Z', total_attended_30d: 3 },
      { id: 'c2', person_group_id: null, total_attended_30d: 2 },
    ]
    const map = combineGroupActivity(rows)
    expect(map.size).toBe(0)
  })

  it('takes MAX last_attended_at and SUM totals across two rows in a group', () => {
    const rows = [
      {
        id: 'c1',
        person_group_id: 'g1',
        last_attended_at: '2024-01-25T08:00:00Z',
        last_booked_at: '2024-01-24T08:00:00Z',
        total_attended_30d: 0,
        total_attended_7d: 0,
        total_noshow_30d: 1,
      },
      {
        id: 'c2',
        person_group_id: 'g1',
        last_attended_at: '2026-06-12T09:00:00Z',
        last_booked_at: '2026-06-11T09:00:00Z',
        total_attended_30d: 6,
        total_attended_7d: 2,
        total_noshow_30d: 0,
      },
    ]
    const map = combineGroupActivity(rows)
    expect(map.size).toBe(1)
    const combined = map.get('g1')
    expect(combined.last_attended_at).toBe('2026-06-12T09:00:00Z')
    expect(combined.last_booked_at).toBe('2026-06-11T09:00:00Z')
    expect(combined.total_attended_30d).toBe(6)
    expect(combined.total_attended_7d).toBe(2)
    expect(combined.total_noshow_30d).toBe(1)
  })

  it('returns the original ISO string (not a Date object)', () => {
    const rows = [
      {
        id: 'c1',
        person_group_id: 'g1',
        last_attended_at: '2026-06-12T09:00:00Z',
        last_booked_at: null,
        total_attended_30d: 1,
        total_attended_7d: 0,
        total_noshow_30d: 0,
      },
    ]
    const map = combineGroupActivity(rows)
    const combined = map.get('g1')
    expect(typeof combined.last_attended_at).toBe('string')
    expect(combined.last_attended_at).toBe('2026-06-12T09:00:00Z')
  })

  it('returns null for date fields when all rows have null dates', () => {
    const rows = [
      {
        id: 'c1',
        person_group_id: 'g1',
        last_attended_at: null,
        last_booked_at: null,
        total_attended_30d: 3,
        total_attended_7d: 1,
        total_noshow_30d: 0,
      },
      {
        id: 'c2',
        person_group_id: 'g1',
        last_attended_at: null,
        last_booked_at: null,
        total_attended_30d: 2,
        total_attended_7d: 0,
        total_noshow_30d: 1,
      },
    ]
    const map = combineGroupActivity(rows)
    const combined = map.get('g1')
    expect(combined.last_attended_at).toBeNull()
    expect(combined.last_booked_at).toBeNull()
    expect(combined.total_attended_30d).toBe(5)
    expect(combined.total_noshow_30d).toBe(1)
  })

  it('treats null numeric fields as 0', () => {
    const rows = [
      {
        id: 'c1',
        person_group_id: 'g1',
        last_attended_at: null,
        last_booked_at: null,
        total_attended_30d: null,
        total_attended_7d: null,
        total_noshow_30d: null,
      },
      {
        id: 'c2',
        person_group_id: 'g1',
        last_attended_at: null,
        last_booked_at: null,
        total_attended_30d: 4,
        total_attended_7d: null,
        total_noshow_30d: null,
      },
    ]
    const map = combineGroupActivity(rows)
    const combined = map.get('g1')
    expect(combined.total_attended_30d).toBe(4)
    expect(combined.total_attended_7d).toBe(0)
    expect(combined.total_noshow_30d).toBe(0)
  })

  it('handles multiple groups independently', () => {
    const rows = [
      {
        id: 'c1',
        person_group_id: 'g1',
        last_attended_at: '2026-06-01T00:00:00Z',
        last_booked_at: null,
        total_attended_30d: 5,
        total_attended_7d: 2,
        total_noshow_30d: 0,
      },
      {
        id: 'c2',
        person_group_id: 'g2',
        last_attended_at: '2026-05-01T00:00:00Z',
        last_booked_at: '2026-05-01T00:00:00Z',
        total_attended_30d: 3,
        total_attended_7d: 1,
        total_noshow_30d: 2,
      },
    ]
    const map = combineGroupActivity(rows)
    expect(map.size).toBe(2)
    expect(map.get('g1').total_attended_30d).toBe(5)
    expect(map.get('g2').total_attended_30d).toBe(3)
    expect(map.get('g1').last_attended_at).toBe('2026-06-01T00:00:00Z')
    expect(map.get('g2').last_attended_at).toBe('2026-05-01T00:00:00Z')
  })

  it('cross-status case: combines member + classpass_payg rows regardless of status', () => {
    // The function ignores glofox_membership_status — only person_group_id matters.
    // This is the Mark Doyle / Alice scenario: a dormant 'member' account plus an
    // active 'classpass_payg' account should still combine activity.
    const rows = [
      {
        id: 'mark-member',
        person_group_id: 'g-mark',
        glofox_membership_status: 'member',
        last_attended_at: '2024-01-10T10:00:00Z',
        last_booked_at: '2024-01-09T10:00:00Z',
        total_attended_30d: 0,
        total_attended_7d: 0,
        total_noshow_30d: 0,
      },
      {
        id: 'mark-classpass',
        person_group_id: 'g-mark',
        glofox_membership_status: 'classpass_payg',
        last_attended_at: '2026-06-14T09:00:00Z',
        last_booked_at: '2026-06-13T09:00:00Z',
        total_attended_30d: 8,
        total_attended_7d: 3,
        total_noshow_30d: 1,
      },
    ]
    const map = combineGroupActivity(rows)
    const combined = map.get('g-mark')
    // MAX last_attended = the ClassPass account's (more recent)
    expect(combined.last_attended_at).toBe('2026-06-14T09:00:00Z')
    expect(combined.last_booked_at).toBe('2026-06-13T09:00:00Z')
    // SUM: 0 + 8 = 8
    expect(combined.total_attended_30d).toBe(8)
    expect(combined.total_attended_7d).toBe(3)
    expect(combined.total_noshow_30d).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// rollupByPerson
// ---------------------------------------------------------------------------

describe('rollupByPerson', () => {
  // Helper to build a minimal contact row
  function contact(id, overrides = {}) {
    return {
      id,
      name: `Contact ${id}`,
      last_attended_at: null,
      last_booked_at: null,
      total_attended_30d: 0,
      total_attended_7d: 0,
      total_noshow_30d: 0,
      ...overrides,
    }
  }

  it('passes ungrouped rows through unchanged (same object reference)', () => {
    const c1 = contact('c1') // no person_group_id
    const c2 = contact('c2')
    const result = rollupByPerson([c1, c2], {
      combinedByGroup: new Map(),
      primaryByGroup: new Map(),
    })
    expect(result).toHaveLength(2)
    expect(result[0]).toBe(c1) // same reference
    expect(result[1]).toBe(c2)
  })

  it('Mark Doyle case: injects combined activity from combinedByGroup onto the sweep row', () => {
    // The member account is in the sweep (loaded by the radar); the ClassPass
    // account is NOT in the sweep (different status) but IS in combinedByGroup
    // because that was built from the full group. The member row should end up
    // with the ClassPass account's activity merged in.
    const memberRow = contact('mark-member', {
      person_group_id: 'g-mark',
      last_attended_at: '2024-01-10T10:00:00Z',
      total_attended_30d: 0,
      total_attended_7d: 0,
      total_noshow_30d: 0,
    })

    const combinedByGroup = new Map([
      ['g-mark', {
        last_attended_at: '2026-06-14T09:00:00Z', // from the ClassPass account
        last_booked_at: '2026-06-13T09:00:00Z',
        total_attended_30d: 8,
        total_attended_7d: 3,
        total_noshow_30d: 1,
      }],
    ])
    const primaryByGroup = new Map([['g-mark', 'mark-member']])

    const result = rollupByPerson([memberRow], { combinedByGroup, primaryByGroup })

    expect(result).toHaveLength(1)
    const kept = result[0]
    // Combined activity injected
    expect(kept.last_attended_at).toBe('2026-06-14T09:00:00Z')
    expect(kept.last_booked_at).toBe('2026-06-13T09:00:00Z')
    expect(kept.total_attended_30d).toBe(8)
    expect(kept.total_attended_7d).toBe(3)
    expect(kept.total_noshow_30d).toBe(1)
    // Original identity preserved (it's the member row's other fields)
    expect(kept.id).toBe('mark-member')
    expect(kept.name).toBe('Contact mark-member')
  })

  it('deduplicates grouped rows — keeps the primary, drops the other', () => {
    const primary = contact('c-primary', { person_group_id: 'g1', total_attended_30d: 2 })
    const secondary = contact('c-secondary', { person_group_id: 'g1', total_attended_30d: 5 })

    const combinedByGroup = new Map([
      ['g1', {
        last_attended_at: null,
        last_booked_at: null,
        total_attended_30d: 7,
        total_attended_7d: 0,
        total_noshow_30d: 0,
      }],
    ])
    const primaryByGroup = new Map([['g1', 'c-primary']])

    const result = rollupByPerson([primary, secondary], { combinedByGroup, primaryByGroup })

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('c-primary')
    // Combined totals injected
    expect(result[0].total_attended_30d).toBe(7)
  })

  it('representative fallback: keeps first sweep row when primary is NOT in sweepRows', () => {
    const first = contact('c-first', { person_group_id: 'g1' })
    const second = contact('c-second', { person_group_id: 'g1' })

    const combinedByGroup = new Map([
      ['g1', {
        last_attended_at: '2026-06-10T00:00:00Z',
        last_booked_at: null,
        total_attended_30d: 3,
        total_attended_7d: 1,
        total_noshow_30d: 0,
      }],
    ])
    // primary is 'c-primary' — but that row is NOT in the sweep
    const primaryByGroup = new Map([['g1', 'c-primary']])

    const result = rollupByPerson([first, second], { combinedByGroup, primaryByGroup })

    expect(result).toHaveLength(1)
    // First-encountered sweep row kept as representative
    expect(result[0].id).toBe('c-first')
    // Combined activity still injected onto the representative
    expect(result[0].last_attended_at).toBe('2026-06-10T00:00:00Z')
    expect(result[0].total_attended_30d).toBe(3)
  })

  it('preserves order: ungrouped rows and group representatives maintain sweepRows order', () => {
    const u1 = contact('u1') // ungrouped
    const g1a = contact('g1a', { person_group_id: 'g1' }) // primary
    const u2 = contact('u2') // ungrouped
    const g1b = contact('g1b', { person_group_id: 'g1' }) // secondary — should be dropped
    const g2a = contact('g2a', { person_group_id: 'g2' }) // primary of another group
    const u3 = contact('u3') // ungrouped

    const combinedByGroup = new Map([
      ['g1', { last_attended_at: null, last_booked_at: null, total_attended_30d: 0, total_attended_7d: 0, total_noshow_30d: 0 }],
      ['g2', { last_attended_at: null, last_booked_at: null, total_attended_30d: 0, total_attended_7d: 0, total_noshow_30d: 0 }],
    ])
    const primaryByGroup = new Map([['g1', 'g1a'], ['g2', 'g2a']])

    const result = rollupByPerson([u1, g1a, u2, g1b, g2a, u3], { combinedByGroup, primaryByGroup })

    // g1b dropped; order preserved
    expect(result.map(r => r.id)).toEqual(['u1', 'g1a', 'u2', 'g2a', 'u3'])
  })

  it('does not mutate the input row', () => {
    const row = contact('c1', {
      person_group_id: 'g1',
      last_attended_at: '2024-01-10T10:00:00Z',
      total_attended_30d: 0,
    })
    const original = { ...row } // snapshot before

    const combinedByGroup = new Map([
      ['g1', {
        last_attended_at: '2026-06-12T09:00:00Z',
        last_booked_at: '2026-06-11T09:00:00Z',
        total_attended_30d: 6,
        total_attended_7d: 2,
        total_noshow_30d: 0,
      }],
    ])
    const primaryByGroup = new Map([['g1', 'c1']])

    const result = rollupByPerson([row], { combinedByGroup, primaryByGroup })

    // Input row must not have been mutated
    expect(row.last_attended_at).toBe(original.last_attended_at)
    expect(row.total_attended_30d).toBe(original.total_attended_30d)
    // Output row has the injected values
    expect(result[0].last_attended_at).toBe('2026-06-12T09:00:00Z')
    expect(result[0]).not.toBe(row) // different object (shallow copy)
  })

  it('does not mutate the input sweepRows array', () => {
    const rows = [
      contact('c1', { person_group_id: 'g1' }),
      contact('c2', { person_group_id: 'g1' }),
    ]
    const originalLength = rows.length

    rollupByPerson(rows, {
      combinedByGroup: new Map([['g1', { last_attended_at: null, last_booked_at: null, total_attended_30d: 0, total_attended_7d: 0, total_noshow_30d: 0 }]]),
      primaryByGroup: new Map([['g1', 'c1']]),
    })

    expect(rows).toHaveLength(originalLength)
  })

  it('passes grouped row as-is when group has no combinedByGroup entry', () => {
    const row = contact('c1', {
      person_group_id: 'g-no-combined',
      last_attended_at: '2026-01-01T10:00:00Z',
      total_attended_30d: 4,
    })

    const result = rollupByPerson([row], {
      combinedByGroup: new Map(), // empty — no entry for this group
      primaryByGroup: new Map([['g-no-combined', 'c1']]),
    })

    expect(result).toHaveLength(1)
    // Row passed through: same object reference (no combined to inject)
    expect(result[0]).toBe(row)
    expect(result[0].last_attended_at).toBe('2026-01-01T10:00:00Z')
    expect(result[0].total_attended_30d).toBe(4)
  })

  it('keeps the primary even when it appears after other group members in sweepRows', () => {
    const secondary = contact('c-secondary', { person_group_id: 'g1', total_attended_30d: 5 })
    const primary   = contact('c-primary',   { person_group_id: 'g1', total_attended_30d: 2 })
    const combinedByGroup = new Map([
      ['g1', { last_attended_at: null, last_booked_at: null, total_attended_30d: 7, total_attended_7d: 0, total_noshow_30d: 0 }],
    ])
    const primaryByGroup = new Map([['g1', 'c-primary']])
    const result = rollupByPerson([secondary, primary], { combinedByGroup, primaryByGroup })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('c-primary')
    expect(result[0].total_attended_30d).toBe(7)
  })

  it('handles a mix of grouped and ungrouped rows across multiple groups', () => {
    // Three groups, two ungrouped. Each group has 2 sweep rows.
    // Verifies that all groups dedup correctly and ungrouped pass through.
    const ungrouped1 = contact('u1')
    const g1p = contact('g1-primary', { person_group_id: 'g1', total_attended_30d: 1 })
    const g1s = contact('g1-secondary', { person_group_id: 'g1', total_attended_30d: 5 })
    const ungrouped2 = contact('u2')
    const g2p = contact('g2-primary', { person_group_id: 'g2', total_attended_30d: 2 })
    const g2s = contact('g2-secondary', { person_group_id: 'g2', total_attended_30d: 3 })

    const combinedByGroup = new Map([
      ['g1', { last_attended_at: '2026-06-01T00:00:00Z', last_booked_at: null, total_attended_30d: 6, total_attended_7d: 0, total_noshow_30d: 0 }],
      ['g2', { last_attended_at: '2026-05-01T00:00:00Z', last_booked_at: null, total_attended_30d: 5, total_attended_7d: 0, total_noshow_30d: 0 }],
    ])
    const primaryByGroup = new Map([
      ['g1', 'g1-primary'],
      ['g2', 'g2-primary'],
    ])

    const result = rollupByPerson(
      [ungrouped1, g1p, g1s, ungrouped2, g2p, g2s],
      { combinedByGroup, primaryByGroup },
    )

    expect(result.map(r => r.id)).toEqual(['u1', 'g1-primary', 'u2', 'g2-primary'])
    // Ungrouped: same references
    expect(result[0]).toBe(ungrouped1)
    expect(result[2]).toBe(ungrouped2)
    // Grouped: combined activity injected
    expect(result[1].total_attended_30d).toBe(6)
    expect(result[3].total_attended_30d).toBe(5)
  })
})

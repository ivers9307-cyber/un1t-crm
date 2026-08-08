// EQUIP-MAINT.2 — unit tests for inspection draft + tick logic.

import { describe, it, expect } from 'vitest'
import { buildDraftRow, mergeTick, isFullyMarked } from './equipment-inspections.js'

const TYPE = {
  id: 'type-1',
  name: 'Treadmill',
  interval_weeks: 4,
  items: [
    { id: 'a', label: 'Check belt wear', order: 0 },
    { id: 'b', label: 'Emergency stop works', order: 1 },
  ],
}
const ASSET = { id: 'eq-1', location_id: 'loc-1', type_id: 'type-1', next_due_on: '2026-08-04' }

describe('buildDraftRow', () => {
  it('snapshots the type items so a later type edit cannot shift the run', () => {
    const row = buildDraftRow({ asset: ASSET, type: TYPE, inspectorId: 'prof-1' })
    expect(row.items).toEqual(TYPE.items)
    // A snapshot, not a live reference.
    TYPE.items.push({ id: 'c', label: 'added later', order: 2 })
    expect(row.items).toHaveLength(2)
    TYPE.items.pop()
  })

  it('keys the draft to the asset current cycle', () => {
    const row = buildDraftRow({ asset: ASSET, type: TYPE, inspectorId: 'prof-1' })
    expect(row).toMatchObject({
      equipment_id: 'eq-1', location_id: 'loc-1', type_id: 'type-1',
      due_on: '2026-08-04', status: 'draft', results: {},
    })
  })

  it('throws when the type has no checklist items', () => {
    expect(() => buildDraftRow({ asset: ASSET, type: { ...TYPE, items: [] }, inspectorId: 'p' }))
      .toThrow(/checklist/i)
  })
})

describe('mergeTick', () => {
  const base = { a: { state: 'pass', at: 't0', by: 'p1' } }

  it('adds a new mark without disturbing existing ones', () => {
    const out = mergeTick(base, { itemId: 'b', state: 'pass', at: 't1', by: 'p1' })
    expect(out.a).toEqual(base.a)
    expect(out.b).toMatchObject({ state: 'pass', at: 't1', by: 'p1' })
  })

  it('overwrites a previous mark on the same item', () => {
    const out = mergeTick(base, { itemId: 'a', state: 'fail', note: 'frayed', at: 't2', by: 'p1' })
    expect(out.a).toMatchObject({ state: 'fail', note: 'frayed' })
  })

  it('does not mutate the input', () => {
    const snapshot = JSON.parse(JSON.stringify(base))
    mergeTick(base, { itemId: 'b', state: 'pass', at: 't1', by: 'p1' })
    expect(base).toEqual(snapshot)
  })

  it('drops the note when the item is marked pass', () => {
    const out = mergeTick(base, { itemId: 'b', state: 'pass', note: 'leftover', at: 't', by: 'p' })
    expect(out.b).not.toHaveProperty('note')
  })
})

describe('isFullyMarked', () => {
  const items = [{ id: 'a' }, { id: 'b' }]
  it('is false while an item is unmarked', () => {
    expect(isFullyMarked(items, { a: { state: 'pass' } })).toBe(false)
  })
  it('is true once every item carries a valid state', () => {
    expect(isFullyMarked(items, { a: { state: 'pass' }, b: { state: 'fail' } })).toBe(true)
  })
  it('ignores results for items not in the snapshot', () => {
    expect(isFullyMarked(items, { a: { state: 'pass' }, b: { state: 'pass' }, ghost: { state: 'pass' } })).toBe(true)
  })
})

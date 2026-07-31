// EQUIP-MAINT.1 — unit tests for the pure equipment library.
//
// Date arithmetic (dowOf, addDays, nextOccurrenceOfDow, firstDueOn,
// rollForward) has its own test file: src/lib/equipment-dates.test.js.

import { describe, it, expect } from 'vitest'
import { validateItems, MAX_ITEMS_PER_TYPE, ITEM_LABEL_MAX, ITEM_ID_MAX } from './equipment.js'

describe('validateItems', () => {
  const ok = [
    { id: 'a1', label: 'Check belt wear', order: 0 },
    { id: 'b2', label: 'Emergency stop works', order: 1 },
  ]

  it('accepts a well-formed list and renumbers order from the array index', () => {
    const res = validateItems([
      { id: 'a1', label: 'Check belt wear', order: 9 },
      { id: 'b2', label: 'Emergency stop works', order: 4 },
    ])
    expect(res.ok).toBe(true)
    expect(res.items).toEqual(ok)
  })

  it('trims labels and ids', () => {
    const res = validateItems([{ id: '  a1  ', label: '  Check belt  ' }])
    expect(res.ok).toBe(true)
    expect(res.items[0]).toEqual({ id: 'a1', label: 'Check belt', order: 0 })
  })

  it('rejects a non-array', () => {
    expect(validateItems('nope').ok).toBe(false)
    expect(validateItems(null).ok).toBe(false)
  })

  it('rejects an empty list', () => {
    const res = validateItems([])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/at least one/i)
  })

  it('rejects more than MAX_ITEMS_PER_TYPE items', () => {
    const many = Array.from({ length: MAX_ITEMS_PER_TYPE + 1 }, (_, i) => ({
      id: `i${i}`, label: `item ${i}`,
    }))
    expect(validateItems(many).ok).toBe(false)
  })

  it('rejects a missing id', () => {
    const res = validateItems([{ label: 'no id' }])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/id/i)
  })

  it('rejects duplicate ids', () => {
    const res = validateItems([
      { id: 'same', label: 'one' },
      { id: 'same', label: 'two' },
    ])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/duplicate/i)
  })

  it('rejects a blank label', () => {
    expect(validateItems([{ id: 'a', label: '   ' }]).ok).toBe(false)
  })

  it('rejects an over-long label', () => {
    const res = validateItems([{ id: 'a', label: 'x'.repeat(ITEM_LABEL_MAX + 1) }])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(new RegExp(String(ITEM_LABEL_MAX)))
  })

  it('rejects an over-long id', () => {
    const res = validateItems([{ id: 'i'.repeat(ITEM_ID_MAX + 1), label: 'ok' }])
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(new RegExp(String(ITEM_ID_MAX)))
  })
})

import {
  validateResults,
  buildIssueDescription,
  shouldReturnToService,
  isDue,
  RESULT_NOTE_MAX,
  ISSUE_DESCRIPTION_MAX,
} from './equipment.js'

const ITEMS = [
  { id: 'a', label: 'Check belt wear', order: 0 },
  { id: 'b', label: 'Emergency stop works', order: 1 },
]

describe('validateResults', () => {
  it('accepts an all-pass run with no failures', () => {
    const res = validateResults({ items: ITEMS, results: { a: { state: 'pass' }, b: { state: 'pass' } } })
    expect(res.ok).toBe(true)
    expect(res.failed).toEqual([])
  })

  it('returns failed items with their notes, in snapshot order', () => {
    const res = validateResults({
      items: ITEMS,
      results: { a: { state: 'fail', note: 'fraying at the edge' }, b: { state: 'pass' } },
    })
    expect(res.ok).toBe(true)
    expect(res.failed).toEqual([{ id: 'a', label: 'Check belt wear', note: 'fraying at the edge' }])
  })

  it('rejects a fail with no note', () => {
    const res = validateResults({ items: ITEMS, results: { a: { state: 'fail' }, b: { state: 'pass' } } })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/note/i)
  })

  it('rejects a fail whose note is only whitespace', () => {
    const res = validateResults({ items: ITEMS, results: { a: { state: 'fail', note: '   ' }, b: { state: 'pass' } } })
    expect(res.ok).toBe(false)
  })

  it('rejects an over-long note', () => {
    const res = validateResults({
      items: ITEMS,
      results: { a: { state: 'fail', note: 'x'.repeat(RESULT_NOTE_MAX + 1) }, b: { state: 'pass' } },
    })
    expect(res.ok).toBe(false)
  })

  it('rejects submission when an item is unmarked, listing the missing ids', () => {
    const res = validateResults({ items: ITEMS, results: { a: { state: 'pass' } } })
    expect(res.ok).toBe(false)
    expect(res.missing).toEqual(['b'])
    expect(res.error).toMatch(/pass or fail/i)
  })

  it('rejects an unrecognised state', () => {
    const res = validateResults({ items: ITEMS, results: { a: { state: 'maybe' }, b: { state: 'pass' } } })
    expect(res.ok).toBe(false)
    expect(res.missing).toEqual(['a'])
  })

  it('rejects a non-object results blob', () => {
    expect(validateResults({ items: ITEMS, results: [] }).ok).toBe(false)
    expect(validateResults({ items: ITEMS, results: null }).ok).toBe(false)
  })

  it('rejects a malformed items snapshot instead of throwing or producing an unmappable id', () => {
    // equipment_inspections.items is only constrained to
    // jsonb_typeof = 'array' — elements themselves are unvalidated.
    expect(validateResults({ items: [null], results: {} }).ok).toBe(false)
    expect(validateResults({ items: ['a'], results: {} }).ok).toBe(false)
    expect(() => validateResults({ items: [null], results: {} })).not.toThrow()
  })
})

describe('buildIssueDescription', () => {
  const failed = [
    { id: 'a', label: 'Check belt wear', note: 'fraying at the edge' },
    { id: 'b', label: 'Emergency stop works', note: 'sticks, needs force' },
  ]

  it('names the asset, its type and the cycle date, then lists each failure', () => {
    const text = buildIssueDescription({
      equipmentName: 'Treadmill 3',
      typeName: 'Treadmill',
      dueOn: '2026-08-04',
      failed,
    })
    // Exact composed string, not just toContain fragments — pins the
    // format (blank line after the header, one bullet per failure).
    expect(text).toBe(
      'Treadmill 3 (Treadmill) failed inspection due 2026-08-04.\n\n' +
      '• Check belt wear: fraying at the edge\n' +
      '• Emergency stop works: sticks, needs force'
    )
  })

  it('appends the inspector note when present', () => {
    const text = buildIssueDescription({
      equipmentName: 'Treadmill 3', typeName: 'Treadmill', dueOn: '2026-08-04',
      failed, extraNote: 'Taken off the floor.',
    })
    expect(text).toContain('Taken off the floor.')
  })

  it('omits the note section entirely when blank', () => {
    const text = buildIssueDescription({
      equipmentName: 'T3', typeName: 'Treadmill', dueOn: '2026-08-04', failed, extraNote: '   ',
    })
    expect(text).not.toMatch(/\n\n\s*\n/)
  })

  it('defaults failed to an empty array so an omitted argument does not throw', () => {
    expect(() =>
      buildIssueDescription({ equipmentName: 'Rig', typeName: 'Rig', dueOn: '2026-08-04' })
    ).not.toThrow()
  })

  it('never exceeds the issues.description cap', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `i${i}`, label: `Item ${i}`, note: 'x'.repeat(RESULT_NOTE_MAX),
    }))
    const text = buildIssueDescription({
      equipmentName: 'Rig', typeName: 'Rig', dueOn: '2026-08-04', failed: many,
    })
    expect(text.length).toBeLessThanOrEqual(ISSUE_DESCRIPTION_MAX)
  })

  it('leaves a marker with the true fault count rather than cutting mid-word silently', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: `i${i}`, label: `Item ${i}`, note: 'x'.repeat(RESULT_NOTE_MAX),
    }))
    const text = buildIssueDescription({
      equipmentName: 'Rig', typeName: 'Rig', dueOn: '2026-08-04', failed: many,
    })
    expect(text).toMatch(/truncated \(200 faults in total/)
    expect(text.length).toBeLessThanOrEqual(ISSUE_DESCRIPTION_MAX)
  })

  it('does not split a surrogate pair when truncating for the cap', () => {
    // Inspectors type notes on phones and use emoji (surrogate pairs).
    // Postgres rejects an unpaired UTF-16 surrogate anywhere in a JSON
    // string, which would otherwise 500 the issue insert — so this
    // scans the whole string, not just the very end, because the
    // truncation marker is appended AFTER the cut point and would mask
    // an unpaired surrogate left at the out/marker join. The fixed
    // 2-char label is deliberate: with this shape of input, a naive
    // `.slice(0, ISSUE_DESCRIPTION_MAX)` provably lands mid-pair
    // (verified against the pre-fix implementation), so this is not
    // vacuously passing on a lucky boundary.
    const many = Array.from({ length: 400 }, (_, i) => ({
      id: `i${i}`, label: 'AB', note: '😀'.repeat(50),
    }))
    const text = buildIssueDescription({
      equipmentName: 'Rig', typeName: 'Rig', dueOn: '2026-08-04', failed: many,
    })
    const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    expect(text.length).toBeLessThanOrEqual(ISSUE_DESCRIPTION_MAX)
    expect(UNPAIRED_SURROGATE.test(text)).toBe(false)
  })
})

describe('shouldReturnToService', () => {
  it('is true when the resolved issue is the one that removed the asset', () => {
    const eq = { status: 'out_of_service', out_of_service_issue_id: 'iss-1' }
    expect(shouldReturnToService(eq, 'iss-1')).toBe(true)
  })

  it('is false for a different issue on the same asset', () => {
    const eq = { status: 'out_of_service', out_of_service_issue_id: 'iss-1' }
    expect(shouldReturnToService(eq, 'iss-2')).toBe(false)
  })

  it('is false for an asset taken off the floor manually (no linked issue)', () => {
    const eq = { status: 'out_of_service', out_of_service_issue_id: null }
    expect(shouldReturnToService(eq, 'iss-1')).toBe(false)
  })

  it('is false for an in-service or retired asset', () => {
    expect(shouldReturnToService({ status: 'in_service', out_of_service_issue_id: 'iss-1' }, 'iss-1')).toBe(false)
    expect(shouldReturnToService({ status: 'retired', out_of_service_issue_id: 'iss-1' }, 'iss-1')).toBe(false)
  })

  it('is false for a missing asset', () => {
    expect(shouldReturnToService(null, 'iss-1')).toBe(false)
  })
})

describe('isDue', () => {
  it('is true for an in-service asset due today or earlier', () => {
    expect(isDue({ status: 'in_service', next_due_on: '2026-08-04' }, '2026-08-04')).toBe(true)
    expect(isDue({ status: 'in_service', next_due_on: '2026-07-28' }, '2026-08-04')).toBe(true)
  })

  it('is false for an asset due in the future', () => {
    expect(isDue({ status: 'in_service', next_due_on: '2026-09-01' }, '2026-08-04')).toBe(false)
  })

  it('excludes out-of-service assets — they already have an open issue', () => {
    expect(isDue({ status: 'out_of_service', next_due_on: '2026-08-04' }, '2026-08-04')).toBe(false)
  })

  it('excludes retired assets', () => {
    expect(isDue({ status: 'retired', next_due_on: '2026-08-04' }, '2026-08-04')).toBe(false)
  })
})

// AVAIL.1b review — the web availability editor's pure decisions: what a
// save sends (the server's own canonical order, so its issue paths index the
// rows on screen) and where each issue the server returns belongs.
import { describe, it, expect } from 'vitest'
import { planSave, placeIssues, isDirty } from './availability-editor-model'

const row = (over) => ({
  key: 1, kind: 'weekly', weekday: 'mon', start_date: '', end_date: '', all_day: false,
  start_time: '09:00', end_time: '12:00', note: '', ...over,
})

describe('planSave', () => {
  it("sends each list in the server's order: sorted and de-duplicated exactly as normaliseAvailability does", () => {
    const rows = [
      row({ key: 1, weekday: 'fri' }),
      row({ key: 2, weekday: 'mon', start_time: '17:00', end_time: '19:00' }),
      row({ key: 3, weekday: 'mon' }),
      row({ key: 4, weekday: 'fri' }), // an exact duplicate of row 1
      row({ key: 5, kind: 'dated', start_date: '2026-10-09', end_date: '', all_day: true, note: ' Wedding ' }),
      row({ key: 6, kind: 'dated', start_date: '2026-10-02', end_date: '2026-10-03', all_day: true }),
    ]
    const { body, sent } = planSave(rows)
    expect(body.weekly).toEqual([
      { weekday: 'mon', all_day: false, start_time: '09:00', end_time: '12:00', note: null },
      { weekday: 'mon', all_day: false, start_time: '17:00', end_time: '19:00', note: null },
      { weekday: 'fri', all_day: false, start_time: '09:00', end_time: '12:00', note: null },
    ])
    expect(body.dated).toEqual([
      { start_date: '2026-10-02', end_date: '2026-10-03', all_day: true, start_time: null, end_time: null, note: null },
      { start_date: '2026-10-09', end_date: '2026-10-09', all_day: true, start_time: null, end_time: null, note: 'Wedding' },
    ])
    expect(sent.weekly.map((e) => e.rowKeys)).toEqual([[3], [2], [1, 4]])
    expect(sent.dated.map((e) => e.rowKeys)).toEqual([[6], [5]])
  })
})

describe('placeIssues', () => {
  const rows = [
    row({ key: 1, weekday: 'fri' }),
    row({ key: 2, kind: 'dated', start_date: '2026-09-24', end_date: '2026-09-24', all_day: true }),
    row({ key: 3, kind: 'dated', start_date: '2026-10-02', end_date: '2026-10-02', all_day: true }),
  ]
  const { sent } = planSave(rows)

  it("puts each issue under the row the SERVER's index points at", () => {
    const placed = placeIssues([
      { path: 'dated.0', message: 'Start today or later' },
      { path: 'weekly.0.start_time', message: 'Use HH:MM (24h)' },
    ], sent)
    expect(placed.byRow).toEqual({ 2: ['Start today or later'], 1: ['Use HH:MM (24h)'] })
    expect(placed.general).toEqual([])
  })

  it('an issue about a whole list stays general; an index with no row says which rule it means', () => {
    const placed = placeIssues([
      { path: 'dated', message: 'Up to 60 dates' },
      { path: 'dated.7', message: 'That date has passed' },
      { message: 'Invalid availability' },
    ], { ...sent, dated: [...sent.dated, ...Array(5).fill(null), { rule: { kind: 'dated', start_date: '2026-10-05', end_date: '2026-10-05', all_day: true }, rowKeys: [] }] })
    expect(placed.byRow).toEqual({})
    expect(placed.general).toEqual(['Up to 60 dates', '5 Oct, all day: That date has passed', 'Invalid availability'])
  })

  it('nothing to place', () => {
    expect(placeIssues(null, sent)).toEqual({ byRow: {}, general: [] })
  })
})

describe('isDirty — does the screen differ from what is saved?', () => {
  const saved = {
    weekly: [{ kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: false, start_time: '09:00', end_time: '12:00', note: 'School run' }],
    dated: [{ kind: 'dated', weekday: null, start_date: '2026-10-02', end_date: '2026-10-03', all_day: true, start_time: null, end_time: null, note: null }],
  }
  const asLoaded = () => [
    row({ key: 1, weekday: 'mon', note: 'School run' }),
    row({ key: 2, kind: 'dated', start_date: '2026-10-02', end_date: '2026-10-03', all_day: true, start_time: '', end_time: '' }),
  ]

  it.each([
    ['as loaded', (rows) => rows, false],
    ['rows in another order', (rows) => [...rows].reverse(), false],
    ['a note with only extra spaces', (rows) => [{ ...rows[0], note: '  School run ' }, rows[1]], false],
    ['the same rule typed twice', (rows) => [...rows, { ...rows[0], key: 9 }], false],
    ['a note edited', (rows) => [{ ...rows[0], note: 'Nursery run' }, rows[1]], true],
    ['a time moved', (rows) => [{ ...rows[0], end_time: '13:00' }, rows[1]], true],
    ['a row removed', (rows) => [rows[0]], true],
    ['an empty new row', (rows) => [...rows, row({ key: 9, start_time: '', end_time: '' })], true],
  ])('%s', (_label, change, expected) => {
    expect(isDirty(change(asLoaded()), saved)).toBe(expected)
  })

  it('nothing loaded yet is never dirty', () => {
    expect(isDirty(null, saved)).toBe(false)
    expect(isDirty(asLoaded(), null)).toBe(false)
  })
})

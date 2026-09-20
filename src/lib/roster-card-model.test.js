// src/lib/roster-card-model.test.js
// ROSTERLOOK.1 — every decision the roster's week card, day header, month cell
// and toolbar make is made HERE, in pure functions, because jsdom cannot see
// layout and a component test can only say "this text is present".
import { describe, it, expect } from 'vitest'
import { cardTone, shiftCardModel, dayHeaderStatus } from './roster-card-model'

const TODAY = '2026-09-21'
const block = (over = {}) => ({
  id: 'b1', block_date: TODAY, start_time: '09:15', end_time: '10:30',
  max_coaches: 17, min_coaches: 2, notes: 'manager only: cover for Coach B',
  shift_templates: { name: 'Morning 8 Week Challenge - Strength', color: '#EC4899' },
  ...over,
})
const coach = (id, name, over = {}) => ({ id: `a-${id}`, profile_id: id, status: 'confirmed', profiles: { full_name: name }, ...over })

describe('cardTone', () => {
  it("is 'neutral' for every block today; Wave 2 returns 'admin' here without touching the card", () => {
    expect(cardTone(block())).toBe('neutral')
    expect(cardTone(block({ shift_templates: { name: 'Admin', color: '#000000' } }))).toBe('neutral')
    expect(cardTone(null)).toBe('neutral')
  })
})

describe('shiftCardModel', () => {
  it('time on one line, then coaches, then the FULL template name', () => {
    const m = shiftCardModel(block(), [coach('u2', 'Coach A'), coach('u3', 'Coach B')], { status: 'ok', count: 2, min: 2 }, { isManager: true, viewerId: 'u9' })
    expect(m.timeLabel).toBe('9:15–10:30am')
    expect(m.coaches.map((c) => c.name)).toEqual(['Coach A', 'Coach B'])
    expect(m.templateName).toBe('Morning 8 Week Challenge - Strength')
    expect(m.shortLabel).toBe('9:15am Morning 8 Week Challenge - Strength shift')
    expect(m.tone).toBe('neutral')
    expect(m.status).toBeNull()
    expect(m.emptyText).toBeNull()
  })

  it('cancelled assignments are not coaches', () => {
    const m = shiftCardModel(block(), [coach('u2', 'Coach A'), coach('u3', 'Coach B', { status: 'cancelled' })], { status: 'short', count: 1, min: 2 }, { isManager: true })
    expect(m.coaches.map((c) => c.name)).toEqual(['Coach A'])
  })

  it.each([
    // staffing,                                isManager, coaches, expected status,                    expected emptyText
    [{ status: 'ok', count: 1, min: 1 },        true,      1,       null,                                null],
    [{ status: 'short', count: 1, min: 2 },     true,      1,       { kind: 'short', label: '1 of 2' },  null],
    [{ status: 'empty', count: 0, min: 1 },     true,      0,       { kind: 'empty', label: 'Needs coach' }, null],
    [null /* past block */,                     true,      0,       null,                                'No coach (past)'],
    [{ status: 'short', count: 1, min: 2 },     false,     1,       null,                                null],
    [{ status: 'empty', count: 0, min: 0 },     false,     0,       null,                                'No coach assigned'],
  ])('staffing %j, manager=%s, %i coach(es)', (staffing, isManager, n, status, emptyText) => {
    const list = n ? [coach('u2', 'Coach A')] : []
    const m = shiftCardModel(block(), list, staffing, { isManager })
    if (status) expect(m.status).toMatchObject(status)
    else expect(m.status).toBeNull()
    expect(m.emptyText).toBe(emptyText)
  })

  it('short says what the numbers mean, for a tooltip and a screen reader', () => {
    const m = shiftCardModel(block(), [coach('u2', 'Coach A')], { status: 'short', count: 1, min: 2 }, { isManager: true })
    expect(m.status.srPrefix).toBe('Below minimum: ')
    expect(m.status.title).toBe('Below minimum: 1 of 2 coaches')
  })

  it('marks the viewer, and an adjusted assignment with its real hours', () => {
    const m = shiftCardModel(
      block({ start_time: '09:00', end_time: '12:00' }),
      [coach('u2', 'Coach A', { start_time_override: '09:30', end_time_override: null, partial_reason: 'covered until 12' })],
      { status: 'ok', count: 1, min: 1 },
      { isManager: true, viewerId: 'u2' },
    )
    expect(m.coaches[0].isMe).toBe(true)
    expect(m.coaches[0].adjusted).toEqual({
      title: 'Adjusted: 9:30am–12pm · covered until 12',
      srLabel: 'Adjusted hours: 9:30am to 12pm. covered until 12',
    })
  })

  // 🔴 The coach boundary. The coach feed does not carry these columns; this
  // test hands them over anyway, so the guarantee is the model's, not the feed's.
  it('coach mode: the model contains no capacity figure, no minimum and no manager note', () => {
    const m = shiftCardModel(block(), [coach('u2', 'Coach A')], { status: 'short', count: 1, min: 2 }, { isManager: false, viewerId: 'u2' })
    expect(m.status).toBeNull()
    const flat = JSON.stringify(m)
    expect(flat).not.toMatch(/17/)            // max_coaches (17 so the 9:15 start cannot mask it)
    expect(flat).not.toMatch(/\d+ of \d+/)    // "1 of 2"
    expect(flat).not.toMatch(/\d+\/\d+/)      // the old "1/15" chip
    expect(flat).not.toMatch(/manager only/)  // shift_blocks.notes
  })

  it('manager mode: still no n/max chip anywhere in the model', () => {
    const m = shiftCardModel(block(), [coach('u2', 'Coach A')], { status: 'ok', count: 1, min: 1 }, { isManager: true })
    expect(JSON.stringify(m)).not.toMatch(/17|\d+\/\d+/)
  })

  it('falls back to "Shift" when the template is missing', () => {
    const m = shiftCardModel(block({ shift_templates: null }), [], null, { isManager: true })
    expect(m.templateName).toBe('Shift')
  })
})

describe('dayHeaderStatus', () => {
  const live = (n) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, profile_id: `u${i}`, status: 'confirmed' }))
  const b = (id, min, n, date = TODAY) => ({ id, block_date: date, start_time: '09:00', min_coaches: min, shift_assignments: live(n) })

  it.each([
    ['no blocks at all',            [],                                        'none',  '',        ''],
    ['only past blocks',            [b('p', 1, 0, '2026-09-01')],              'none',  '',        ''],
    ['every shift at its minimum',  [b('x', 1, 1), b('y', 2, 2)],              'ok',    '',        'Fully staffed'],
    ['one below minimum',           [b('x', 2, 1), b('y', 1, 1)],              'short', '1 short', '1 shift needs coaches: 1 below the minimum'],
    ['one with no coach',           [b('x', 1, 0), b('y', 1, 1)],              'empty', '1 short', '1 shift needs coaches: 1 with no coach'],
    ['one of each: red wins',       [b('x', 1, 0), b('y', 2, 1)],              'empty', '2 short', '2 shifts need coaches: 1 with no coach, 1 below the minimum'],
    ['past gaps are not counted',   [b('p', 1, 0, '2026-09-01'), b('y', 1, 1)], 'ok',   '',        'Fully staffed'],
  ])('%s', (_name, blocks, tone, label, srLabel) => {
    const s = dayHeaderStatus(blocks, { todayIso: TODAY })
    expect(s.tone).toBe(tone)
    expect(s.label).toBe(label)
    expect(s.srLabel).toBe(srLabel)
  })

  it('a cancelled assignment is not a coach', () => {
    const blocks = [{ id: 'x', block_date: TODAY, min_coaches: 1, shift_assignments: [{ id: 'a', profile_id: 'u', status: 'cancelled' }] }]
    expect(dayHeaderStatus(blocks, { todayIso: TODAY }).tone).toBe('empty')
  })

  it('the tooltip is the sentence, so the dot is never the only explanation', () => {
    const s = dayHeaderStatus([b('x', 2, 1)], { todayIso: TODAY })
    expect(s.title).toBe(s.srLabel)
    expect(dayHeaderStatus([b('x', 1, 1)], { todayIso: TODAY }).title).toBe('Every shift has its minimum number of coaches')
  })

  it('tolerates null', () => {
    expect(dayHeaderStatus(null, { todayIso: TODAY }).tone).toBe('none')
  })
})

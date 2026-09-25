// src/lib/roster-card-model.test.js
// ROSTERLOOK.1 — every decision the roster's week card, day header, month cell
// and toolbar make is made HERE, in pure functions, because jsdom cannot see
// layout and a component test can only say "this text is present".
import { describe, it, expect } from 'vitest'
import { cardTone, shiftCardModel, dayHeaderStatus, monthCellLines, rosterToolbarModel, dayLeaveBars, dayUnavailableBars, dayAvailabilityRules } from './roster-card-model'

const TODAY = '2026-09-21'
const block = (over = {}) => ({
  id: 'b1', block_date: TODAY, start_time: '09:15', end_time: '10:30',
  max_coaches: 17, min_coaches: 2, notes: 'manager only: cover for Coach B',
  shift_templates: { name: 'Morning 8 Week Challenge - Strength', color: '#EC4899' },
  ...over,
})
const coach = (id, name, over = {}) => ({ id: `a-${id}`, profile_id: id, status: 'confirmed', profiles: { full_name: name }, ...over })

describe('cardTone', () => {
  it("is 'neutral' for a class block, and for anything whose kind cannot be read", () => {
    expect(cardTone(block())).toBe('neutral')
    expect(cardTone(block({ shift_templates: { name: 'Admin', color: '#000000' } }))).toBe('neutral')
    expect(cardTone(null)).toBe('neutral')
  })

  it("is 'admin' for a block whose template is an admin shift (SHIFTTYPE.1)", () => {
    expect(cardTone(block({ shift_templates: { name: 'Ops', kind: 'admin' } }))).toBe('admin')
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

  it('a swapped assignment IS a coach: only cancelled is dead (ROSTER-FIX.1)', () => {
    const m = shiftCardModel(block(), [coach('u2', 'Coach A', { status: 'swapped' }), coach('u3', 'Coach B', { status: undefined })], { status: 'ok', count: 2, min: 2 }, { isManager: true })
    expect(m.coaches.map((c) => c.name)).toEqual(['Coach A', 'Coach B'])
  })

  it('tolerates a null block like every other field does', () => {
    const m = shiftCardModel(null, [coach('u2', 'Coach A', { start_time_override: '09:30' })], null, { isManager: true })
    expect(m.coaches[0].adjusted.title).toBe('Adjusted: 9:30am–')
    expect(m.templateName).toBe('Shift')
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

  // The card's click target is a button stretched OVER its text, so a title on
  // the template label or a coach's name is never under the pointer. The card
  // container carries one tooltip that says everything truncation can cut.
  it('hoverTitle: template, range, full names with adjusted hours, and the status in words', () => {
    const m = shiftCardModel(
      block(),
      [coach('u2', 'Coach A', { start_time_override: '09:30', partial_reason: 'late start' }), coach('u3', 'Coach B')],
      { status: 'short', count: 2, min: 3 },
      { isManager: true },
    )
    expect(m.hoverTitle).toBe('Morning 8 Week Challenge - Strength · 9:15–10:30am · Coach A (Adjusted: 9:30am–10:30am · late start), Coach B · Below minimum: 2 of 3 coaches')
  })

  it('hoverTitle for a coach carries no staffing words', () => {
    const m = shiftCardModel(block(), [coach('u2', 'Coach A')], { status: 'short', count: 1, min: 2 }, { isManager: false })
    expect(m.hoverTitle).toBe('Morning 8 Week Challenge - Strength · 9:15–10:30am · Coach A')
  })

  it('falls back to "Shift" when the template is missing', () => {
    const m = shiftCardModel(block({ shift_templates: null }), [], null, { isManager: true })
    expect(m.templateName).toBe('Shift')
  })
})

describe('dayHeaderStatus', () => {
  const live = (n) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, profile_id: `u${i}`, status: 'confirmed' }))
  const b = (id, min, n, date = TODAY) => ({ id, block_date: date, start_time: '09:00', min_coaches: min, shift_assignments: live(n) })

  // The visible label says WHICH problem in words, so red vs amber is never the
  // only thing separating "no coach" from "below minimum". `label` is the one
  // that always fits (the more severe problem); `labelWide` adds the other when
  // both apply, for a header wide enough to hold it.
  it.each([
    ['no blocks at all',            [],                                        'none',  '',           '',                     ''],
    ['only past blocks',            [b('p', 1, 0, '2026-09-01')],              'none',  '',           '',                     ''],
    ['every shift at its minimum',  [b('x', 1, 1), b('y', 2, 2)],              'ok',    '',           '',                     'Shifts at minimum'],
    ['one below minimum',           [b('x', 2, 1), b('y', 1, 1)],              'short', '1 short',    '1 short',              '1 shift needs coaches: 1 below the minimum'],
    ['one with no coach',           [b('x', 1, 0), b('y', 1, 1)],              'empty', '1 no coach', '1 no coach',           '1 shift needs coaches: 1 with no coach'],
    ['two with no coach',           [b('x', 1, 0), b('y', 1, 0)],              'empty', '2 no coach', '2 no coach',           '2 shifts need coaches: 2 with no coach'],
    ['one of each: red wins',       [b('x', 1, 0), b('y', 2, 1)],              'empty', '1 no coach', '1 no coach · 1 short', '2 shifts need coaches: 1 with no coach, 1 below the minimum'],
    ['past gaps are not counted',   [b('p', 1, 0, '2026-09-01'), b('y', 1, 1)], 'ok',   '',           '',                     'Shifts at minimum'],
  ])('%s', (_name, blocks, tone, label, labelWide, srLabel) => {
    const s = dayHeaderStatus(blocks, { todayIso: TODAY })
    expect(s.tone).toBe(tone)
    expect(s.label).toBe(label)
    expect(s.labelWide).toBe(labelWide)
    expect(s.srLabel).toBe(srLabel)
  })

  // The dialog a header opens counts EVENT demand against supply minus leave,
  // and can say UNDERMANNED on a day whose shifts are all at minimum. The dot
  // claims only what it measured.
  it('ok never claims "fully staffed"', () => {
    const s = dayHeaderStatus([b('x', 1, 1)], { todayIso: TODAY })
    expect(`${s.srLabel} ${s.title}`).not.toMatch(/fully staffed/i)
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

describe('monthCellLines', () => {
  const on = (...names) => names.map((n, i) => ({ id: `a-${n}-${i}`, profile_id: `u-${n}-${i}`, status: 'confirmed', profiles: { full_name: n } }))
  const mb = (id, start, end, min, assignments, date = TODAY) => ({
    id, block_date: date, start_time: start, end_time: end, min_coaches: min, max_coaches: 10,
    shift_templates: { name: `Template ${id}` }, shift_assignments: assignments,
  })

  it('time + first names, in start order, three lines then "+N more"', () => {
    const blocks = [
      mb('d', '17:45', '18:45', 1, on('Devon Fourth')),
      mb('a', '05:45', '06:45', 1, on('Alex First', 'Blake Second')),
      mb('b', '06:45', '07:45', 1, on('Casey Third')),
      mb('c', '09:00', '10:00', 1, on('Eden Fifth')),
      mb('e', '18:45', '19:45', 1, on('Flynn Sixth')),
    ]
    const { lines, more } = monthCellLines(blocks, { todayIso: TODAY, isManager: true })
    expect(lines.map((l) => l.text)).toEqual(['5:45 Alex, Blake', '6:45 Casey', '9 Eden'])
    expect(more).toBe(2)
  })

  it('pm keeps its suffix so 5:45 and 5:45pm never read the same', () => {
    const { lines } = monthCellLines([mb('d', '17:45', '18:45', 1, on('Devon Fourth'))], { todayIso: TODAY, isManager: true })
    expect(lines[0].text).toBe('5:45pm Devon')
  })

  it('two coaches sharing a first name get a last initial', () => {
    const { lines } = monthCellLines([mb('a', '05:45', '06:45', 1, on('Sam Alpha', 'Sam Bravo', 'Casey Third'))], { todayIso: TODAY, isManager: true })
    expect(lines[0].text).toBe('5:45 Sam A, Sam B, Casey')
  })

  it('same first name AND last initial: both get their full names, never two identical labels', () => {
    const { lines } = monthCellLines([mb('a', '05:45', '06:45', 1, on('Sam Alpha', 'Sam Avery', 'Casey Third'))], { todayIso: TODAY, isManager: true })
    expect(lines[0].text).toBe('5:45 Sam Alpha, Sam Avery, Casey')
  })

  it('a shared first name is shared whatever its case', () => {
    const { lines } = monthCellLines([mb('a', '05:45', '06:45', 1, on('sam Alpha', 'Sam Bravo'))], { todayIso: TODAY, isManager: true })
    expect(lines[0].text).toBe('5:45 sam A, Sam B')
  })

  it('a swapped assignment is named; it is a real shift owned by the taker', () => {
    const list = [{ id: 's', profile_id: 'u8', status: 'swapped', profiles: { full_name: 'Devon Fourth' } }]
    const { lines } = monthCellLines([mb('x', '09:00', '10:00', 1, list)], { todayIso: TODAY, isManager: true })
    expect(lines[0].text).toBe('9 Devon')
    expect(lines[0].tone).toBe('ok')
  })

  it.each([
    // name,                         assignments,        min, date,          isManager, tone,    text
    ['staffed',                      on('Coach A'),      1,   TODAY,         true,      'ok',    '9 Coach'],
    ['short: numbers only here',     on('Coach A'),      2,   TODAY,         true,      'short', '9 Coach (1 of 2)'],
    ['empty future',                 [],                 1,   TODAY,         true,      'empty', '9 Needs coach'],
    ['empty past is history',        [],                 1,   '2026-09-01',  true,      'quiet', '9 No coach'],
    ['coach never sees a status',    on('Coach A'),      2,   TODAY,         false,     'ok',    '9 Coach'],
    ['coach, empty block',           [],                 1,   TODAY,         false,     'quiet', '9 No coach'],
  ])('%s', (_n, assignments, min, date, isManager, tone, text) => {
    const { lines } = monthCellLines([mb('x', '09:00', '10:00', min, assignments, date)], { todayIso: TODAY, isManager })
    expect(lines[0].tone).toBe(tone)
    expect(lines[0].text).toBe(text)
  })

  it('the title says everything the line had to cut: template, full range, full names, and the status in words', () => {
    const { lines } = monthCellLines([mb('x', '05:45', '06:45', 2, on('Alex First'))], { todayIso: TODAY, isManager: true })
    expect(lines[0].title).toBe('Template x · 5:45–6:45am · Alex First · Below minimum: 1 of 2 coaches')
  })

  it('no capacity figure for anyone: the old "2/10" is gone', () => {
    const out = monthCellLines([mb('x', '09:00', '10:00', 1, on('Coach A'))], { todayIso: TODAY, isManager: true })
    expect(JSON.stringify(out)).not.toMatch(/\d+\/\d+/)
  })

  it('cancelled assignments are not named', () => {
    const list = [...on('Coach A'), { id: 'c', profile_id: 'u9', status: 'cancelled', profiles: { full_name: 'Gone Person' } }]
    expect(monthCellLines([mb('x', '09:00', '10:00', 1, list)], { todayIso: TODAY, isManager: true }).lines[0].text).toBe('9 Coach')
  })

  it('tolerates null and honours a custom limit', () => {
    expect(monthCellLines(null, { todayIso: TODAY })).toEqual({ lines: [], more: 0 })
    const two = [mb('a', '06:00', '07:00', 1, on('A B')), mb('b', '07:00', '08:00', 1, on('C D'))]
    expect(monthCellLines(two, { todayIso: TODAY, limit: 1 }).more).toBe(1)
  })

  // SHIFTTYPE.1 — an empty admin block is not a gap: it reads like the week
  // card ("Nobody assigned"), never "No coach" or "Needs coach".
  it('an empty admin block reads "Nobody assigned", quietly, for a manager and a coach', () => {
    const admin = { ...mb('x', '09:00', '10:00', 0, []), shift_templates: { name: 'Stock take', kind: 'admin' } }
    for (const isManager of [true, false]) {
      const { lines } = monthCellLines([admin], { todayIso: TODAY, isManager })
      expect(lines[0]).toMatchObject({ tone: 'quiet', text: '9 Nobody assigned' })
    }
    // A class block keeps its wording.
    expect(monthCellLines([mb('y', '09:00', '10:00', 1, [])], { todayIso: TODAY, isManager: false }).lines[0].text).toBe('9 No coach')
  })
})

describe('rosterToolbarModel', () => {
  const base = { isManager: true, viewType: 'week', selectMode: false, selectedCount: 0, copying: false }

  it('a manager in week view: five actions in More, in this order, and Publish on the row', () => {
    const m = rosterToolbarModel(base)
    expect(m.moreItems.map((i) => i.key)).toEqual(['time-off', 'select', 'copy-week', 'copy-month', 'templates'])
    expect(m.moreItems.map((i) => i.label)).toEqual(['Time off', 'Select multiple', 'Copy last week', 'Copy last month', 'Manage templates'])
    expect(m.showPublish).toBe(true)
    expect(m.timeOffInline).toBe(false)
  })

  it('links are links: Time off and Manage templates keep their hrefs', () => {
    const byKey = Object.fromEntries(rosterToolbarModel(base).moreItems.map((i) => [i.key, i]))
    expect(byKey['time-off'].href).toBe('/schedule/time-off')
    expect(byKey.templates.href).toBe('/settings/shifts')
    expect(byKey['copy-week'].href).toBeUndefined()
  })

  it('Publish is week-view only; everything in More stays reachable in month view', () => {
    const m = rosterToolbarModel({ ...base, viewType: 'month' })
    expect(m.showPublish).toBe(false)
    expect(m.moreItems).toHaveLength(5)
  })

  it('a coach: Time off inline, no More, no Publish', () => {
    const m = rosterToolbarModel({ ...base, isManager: false })
    expect(m.moreItems).toEqual([])
    expect(m.timeOffInline).toBe(true)
    expect(m.showPublish).toBe(false)
  })

  it('select mode is a checked item that says how to leave it, and marks the menu button', () => {
    const m = rosterToolbarModel({ ...base, selectMode: true, selectedCount: 3 })
    const item = m.moreItems.find((i) => i.key === 'select')
    expect(item.checked).toBe(true)
    expect(item.label).toBe('Exit multi-select (3)')
    expect(m.moreActive).toBe(true)
    // The old row said "Selecting (3)" on its own amber button. An amber button
    // still reading "More" hid the mode; the label carries it now.
    expect(m.moreLabel).toBe('More · selecting (3)')
    expect(rosterToolbarModel({ ...base, selectMode: true, selectedCount: 0 }).moreLabel).toBe('More · selecting')
    expect(rosterToolbarModel(base).moreItems.find((i) => i.key === 'select').checked).toBe(false)
  })

  it('both copies are disabled while a copy runs, and the menu button says so', () => {
    const m = rosterToolbarModel({ ...base, copying: true })
    expect(m.moreItems.filter((i) => i.disabled).map((i) => i.key)).toEqual(['copy-week', 'copy-month'])
    expect(m.moreLabel).toBe('More · copying…')
    // A running copy outranks select mode: it is the thing about to change the roster.
    expect(rosterToolbarModel({ ...base, copying: true, selectMode: true, selectedCount: 2 }).moreLabel).toBe('More · copying…')
    expect(rosterToolbarModel(base).moreLabel).toBe('More')
  })

  // GRID.1 — Days | Coaches: the grid is a week-level layout, for managers.
  it('offers Days | Coaches to a manager in week view only', () => {
    expect(rosterToolbarModel(base).showLayoutToggle).toBe(true)
    expect(rosterToolbarModel({ ...base, viewType: 'month' }).showLayoutToggle).toBe(false)
    expect(rosterToolbarModel({ ...base, isManager: false }).showLayoutToggle).toBe(false)
  })
})

// ROSTERLOOK.1 — seen live once the cards went quiet: a person with two
// overlapping requests had their leave bar drawn TWICE on every day of the
// week, and "Firstname Lastname — Unavailable" never fitted a 99-116px column.
describe('dayLeaveBars', () => {
  const DAY = '2026-09-23'
  const req = (id, profile_id, full_name, type, start_date, end_date) => ({ id, profile_id, type, start_date, end_date, profiles: { full_name } })

  it('one bar per person per day: the first by start date wins', () => {
    const bars = dayLeaveBars([
      req('r2', 'p1', 'Coach A', 'unavailable', '2026-09-22', '2026-09-24'),
      req('r1', 'p1', 'Coach A', 'unavailable', '2026-09-21', '2026-09-27'),
      req('r3', 'p2', 'Devon Fourth', 'holiday', '2026-09-23', '2026-09-23'),
    ], DAY)
    expect(bars.map((b) => b.id)).toEqual(['r1', 'r3'])
    expect(bars.map((b) => b.text)).toEqual(['Coach · Unavailable', 'Devon · Holiday'])
  })

  it('when the types differ, the more specific one is the one shown', () => {
    const bars = dayLeaveBars([
      req('r1', 'p1', 'Coach A', 'unavailable', '2026-09-21', '2026-09-27'),
      req('r2', 'p1', 'Coach A', 'sick', '2026-09-23', '2026-09-23'),
      req('r3', 'p1', 'Coach A', 'other', '2026-09-20', '2026-09-27'),
    ], DAY)
    expect(bars).toHaveLength(1)
    expect(bars[0].id).toBe('r2')
    expect(bars[0].type).toBe('sick')
    expect(bars[0].text).toBe('Coach · Sick leave')
  })

  it('the title carries what the bar cut: full name, type, the date range, and that requests overlap', () => {
    const [one] = dayLeaveBars([req('r1', 'p1', 'Coach A', 'holiday', '2026-09-21', '2026-09-27')], DAY)
    expect(one.title).toBe('Coach A — Holiday, 21 Sep – 27 Sep')
    const [single] = dayLeaveBars([req('r1', 'p1', 'Coach A', 'holiday', DAY, DAY)], DAY)
    expect(single.title).toBe('Coach A — Holiday, 23 Sep')
    const [merged] = dayLeaveBars([
      req('r1', 'p1', 'Coach A', 'holiday', '2026-09-21', '2026-09-27'),
      req('r2', 'p1', 'Coach A', 'holiday', '2026-09-23', '2026-09-24'),
    ], DAY)
    expect(merged.title).toBe('Coach A — Holiday, 21 Sep – 27 Sep (+1 overlapping request)')
  })

  it('two people sharing a first name are told apart, as in the month cell', () => {
    const bars = dayLeaveBars([
      req('r1', 'p1', 'Sam Alpha', 'holiday', DAY, DAY),
      req('r2', 'p2', 'Sam Bravo', 'sick', DAY, DAY),
    ], DAY)
    expect(bars.map((b) => b.text)).toEqual(['Sam A · Holiday', 'Sam B · Sick leave'])
  })

  it('only requests covering the day; an unknown type reads "Time off"; null is no bars', () => {
    expect(dayLeaveBars([req('r1', 'p1', 'Coach A', 'holiday', '2026-09-21', '2026-09-22')], DAY)).toEqual([])
    expect(dayLeaveBars([req('r1', 'p1', 'Coach A', 'legacy', DAY, DAY)], DAY)[0].text).toBe('Coach · Time off')
    expect(dayLeaveBars(null, DAY)).toEqual([])
  })

  it('does not decide WHO may see a bar: it returns what it is given, deduped', () => {
    // The caller keeps its own filter (a coach sees only their own leave).
    const bars = dayLeaveBars([req('r1', 'p9', 'Coach Z', 'holiday', DAY, DAY)], DAY)
    expect(bars).toHaveLength(1)
    expect(bars[0].profileId).toBe('p9')
  })
})

describe('dayUnavailableBars (AVAIL.1)', () => {
  const staff = [
    { id: 'c1', full_name: 'Alex Beta' },
    { id: 'c2', full_name: 'Alex Gamma' },
    { id: 'c3', full_name: 'Casey Delta' },
  ]
  const rules = [
    { id: 'r1', profile_id: 'c1', kind: 'weekly', weekday: 'wed', all_day: false, start_time: '10:00', end_time: '11:00', note: 'School run' },
    { id: 'r2', profile_id: 'c1', kind: 'weekly', weekday: 'wed', all_day: false, start_time: '17:00', end_time: '19:00', note: null },
    { id: 'r3', profile_id: 'c2', kind: 'dated', start_date: '2026-05-05', end_date: '2026-05-07', all_day: true, note: null },
    { id: 'r4', profile_id: 'c3', kind: 'weekly', weekday: 'wed', all_day: true, note: null },
    { id: 'r5', profile_id: 'stranger', kind: 'weekly', weekday: 'wed', all_day: true, note: null },
  ]

  it('one bar per person that day, first names told apart, windows summarised, notes in the title', () => {
    const bars = dayUnavailableBars(rules, '2026-05-06', staff)
    expect(bars.map((b) => b.text)).toEqual([
      'Alex B · Unavailable 10am–11am, 5pm–7pm',
      'Alex G · Unavailable all day',
      'Casey · Unavailable all day',
    ])
    expect(bars[0].title).toBe('Alex Beta: unavailable Wednesdays, 10am–11am (School run); Wednesdays, 5pm–7pm')
    expect(bars.map((b) => b.id)).toEqual(['unavail-c1-2026-05-06', 'unavail-c2-2026-05-06', 'unavail-c3-2026-05-06'])
  })

  it("skips people not in the studio's staff list and people already shown on leave", () => {
    const bars = dayUnavailableBars(rules, '2026-05-06', staff, { skipProfileIds: ['c3'] })
    expect(bars.map((b) => b.profileId)).toEqual(['c1', 'c2'])
  })

  it('reads the times Postgres sends (HH:MM:SS)', () => {
    const bars = dayUnavailableBars(
      [{ id: 'r9', profile_id: 'c3', kind: 'weekly', weekday: 'wed', all_day: false, start_time: '09:00:00', end_time: '12:30:00', note: null }],
      '2026-05-06', staff,
    )
    expect(bars.map((b) => b.text)).toEqual(['Casey · Unavailable 9am–12:30pm'])
  })

  // A weekly rule is what the coach says NOW about every such weekday; drawn
  // on a past week it would claim they were unavailable then, which nobody
  // said. A dated rule is about its own dates, so it stays (history).
  it('weekly rules are drawn from today on only; dated ones on any day', () => {
    const past = dayUnavailableBars(rules, '2026-05-06', staff, { todayIso: '2026-05-07' })
    expect(past.map((b) => b.text)).toEqual(['Alex · Unavailable all day']) // the one dated rule
    const today = dayUnavailableBars(rules, '2026-05-06', staff, { todayIso: '2026-05-06' })
    expect(today).toHaveLength(3)
  })

  it('nothing on a day no rule touches', () => {
    expect(dayUnavailableBars(rules, '2026-05-04', staff)).toEqual([])
    expect(dayUnavailableBars(null, '2026-05-06', staff)).toEqual([])
    expect(dayUnavailableBars(rules, '2026-05-06', null)).toEqual([])
  })

  // GRID.1 — the per-day rule set the bars above and the Coaches grid share,
  // so the two layouts cannot disagree about who is unavailable on a day.
  it('dayAvailabilityRules: every rule per person, weekly ones dropped before today, strangers kept for the caller to judge', () => {
    const all = dayAvailabilityRules(rules, '2026-05-06')
    expect([...all.keys()]).toEqual(['c1', 'c2', 'c3', 'stranger'])
    expect(all.get('c1').map((r) => r.id)).toEqual(['r1', 'r2'])
    const past = dayAvailabilityRules(rules, '2026-05-06', { todayIso: '2026-05-07' })
    expect([...past.keys()]).toEqual(['c2'])
    expect(dayAvailabilityRules(null, '2026-05-06').size).toBe(0)
    expect(dayAvailabilityRules([{ id: 'x', kind: 'weekly' }], '2026-05-06').size).toBe(0)
  })
})

describe('shiftCardModel — admin shifts (SHIFTTYPE.1)', () => {
  const adminBlock = block({ block_date: '2026-09-22', min_coaches: 0, shift_templates: { name: 'Stock take', kind: 'admin' } })

  it('carries the admin tone and a word for it, for a manager and a coach alike', () => {
    for (const isManager of [true, false]) {
      const m = shiftCardModel(adminBlock, [coach('u2', 'Coach A')], null, { isManager, viewerId: 'u9' })
      expect(m.tone).toBe('admin')
      expect(m.kindLabel).toBe('Admin')
      expect(m.status).toBeNull()
      expect(m.hoverTitle.startsWith('Stock take · Admin · ')).toBe(true)
    }
  })

  it('an unassigned future admin shift says so plainly: never "No coach (past)", never "Needs coach"', () => {
    const m = shiftCardModel(adminBlock, [], null, { isManager: true })
    expect(m.status).toBeNull()
    expect(m.emptyText).toBe('Nobody assigned')
  })

  it('a class card carries no kind label, and its empty text is unchanged', () => {
    expect(shiftCardModel(block(), [], { status: 'empty', count: 0, min: 2 }, { isManager: true }).kindLabel).toBeNull()
    expect(shiftCardModel(block(), [], null, { isManager: true }).emptyText).toBe('No coach (past)')
    expect(shiftCardModel(block(), [], null, { isManager: false }).emptyText).toBe('No coach assigned')
  })
})

describe('dayHeaderStatus — admin shifts (SHIFTTYPE.1)', () => {
  it('a day whose only future shifts are admin says nothing', () => {
    const adminEmpty = block({ id: 'a', block_date: '2026-09-22', min_coaches: 0, shift_templates: { name: 'Ops', kind: 'admin' }, shift_assignments: [] })
    expect(dayHeaderStatus([adminEmpty], { todayIso: TODAY }).tone).toBe('none')
  })
})

describe('shiftCardModel — briefing (BLOCKEDIT.1)', () => {
  it('says a shift has a briefing, for a manager and a coach alike, and never copies the text', () => {
    for (const isManager of [true, false]) {
      const m = shiftCardModel(block({ briefing: 'Fire drill at 10' }), [coach('u2', 'Coach A')], null, { isManager })
      expect(m.hasBriefing).toBe(true)
      expect(m.hoverTitle).toMatch(/Has a briefing/)
      expect(JSON.stringify(m)).not.toMatch(/Fire drill/)
    }
  })

  it('no briefing (or a blank one) is no marker', () => {
    expect(shiftCardModel(block(), [], null).hasBriefing).toBe(false)
    expect(shiftCardModel(block({ briefing: '  ' }), [], null).hasBriefing).toBe(false)
  })
})

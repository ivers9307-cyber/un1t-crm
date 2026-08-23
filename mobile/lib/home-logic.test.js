// mobile/lib/home-logic.test.js
import { describe, it, expect } from 'vitest'
import { shiftWindow, shiftTimeLabel, groupShiftsByDay, homeTiles } from './home-logic'
import { addDays, shortDate } from './dates'

const shift = (date, start, name = 'Open') => ({
  shift_date: date,
  shift_templates: { name, start_time: start, end_time: '17:00:00' },
})

describe('shiftWindow', () => {
  it('returns today..today+6 as ISO dates', () => {
    const w = shiftWindow(new Date(2026, 7, 23)) // 23 Aug 2026, local
    expect(w).toEqual({ startDate: '2026-08-23', endDate: '2026-08-29' })
  })
})

describe('shiftTimeLabel', () => {
  it('prefers overrides over template times and trims seconds', () => {
    expect(shiftTimeLabel({ start_time_override: '10:30:00', shift_templates: { start_time: '06:00:00', end_time: '14:00:00' } })).toBe('10:30–14:00')
  })
  it('falls back to template times when no override is set', () => {
    expect(shiftTimeLabel({ shift_templates: { start_time: '06:00:00', end_time: '14:00:00' } })).toBe('06:00–14:00')
  })
  it('empty when nothing is set', () => {
    expect(shiftTimeLabel({})).toBe('')
  })
})

describe('groupShiftsByDay', () => {
  it('groups into ordered days, drops empty days, sorts within a day, labels Today/Tomorrow', () => {
    const groups = groupShiftsByDay(
      [shift('2026-08-25', '09:00:00'), shift('2026-08-23', '14:00:00', 'PM'), shift('2026-08-23', '06:00:00', 'AM')],
      '2026-08-23'
    )
    expect(groups.map(g => g.iso)).toEqual(['2026-08-23', '2026-08-25'])
    expect(groups[0].label).toBe('Today')
    expect(groups[0].shifts.map(s => s.shift_templates.name)).toEqual(['AM', 'PM'])
    expect(groups[1].label).not.toBe('Tomorrow') // day 3 gets a date label
  })

  it('labels day 2 Tomorrow and ignores shifts outside the window', () => {
    const groups = groupShiftsByDay([shift('2026-08-24', '09:00:00'), shift('2026-09-20', '09:00:00')], '2026-08-23')
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Tomorrow')
  })

  it('a day-3+ label matches shortDate(that date) exactly — structural, not a hardcoded locale string', () => {
    const groups = groupShiftsByDay([shift('2026-08-25', '09:00:00')], '2026-08-23')
    expect(groups).toHaveLength(1)
    expect(groups[0].iso).toBe('2026-08-25')
    expect(groups[0].label).toBe(shortDate(addDays(new Date(2026, 7, 23), 2)))
  })

  it('within-day sort orders by effective time, not insertion order (kills a dropped/inverted sort)', () => {
    // Deliberately inserted latest-first, and interleaved with a different day.
    const groups = groupShiftsByDay(
      [
        shift('2026-08-23', '18:00:00', 'Evening'),
        shift('2026-08-24', '09:00:00', 'OtherDay'),
        shift('2026-08-23', '06:00:00', 'Morning'),
        shift('2026-08-23', '12:00:00', 'Midday'),
      ],
      '2026-08-23'
    )
    const day0 = groups.find(g => g.iso === '2026-08-23')
    expect(day0.shifts.map(s => s.shift_templates.name)).toEqual(['Morning', 'Midday', 'Evening'])
  })

  it('includes day 6 (today+6, the last day of the 7-day window) and excludes day 7', () => {
    const groups = groupShiftsByDay(
      [shift('2026-08-29', '09:00:00', 'EdgeIn'), shift('2026-08-30', '09:00:00', 'EdgeOut')],
      '2026-08-23'
    )
    expect(groups.map(g => g.iso)).toEqual(['2026-08-29'])
    expect(groups[0].shifts.map(s => s.shift_templates.name)).toEqual(['EdgeIn'])
  })

  it('a shift the day BEFORE the window (yesterday) is excluded', () => {
    const groups = groupShiftsByDay([shift('2026-08-22', '09:00:00')], '2026-08-23')
    expect(groups).toEqual([])
  })

  it('handles no shifts / null shifts gracefully', () => {
    expect(groupShiftsByDay([], '2026-08-23')).toEqual([])
    expect(groupShiftsByDay(null, '2026-08-23')).toEqual([])
  })
})

describe('homeTiles', () => {
  it('builds the full list for a master and nothing without a location', () => {
    const master = { role: 'master', permissions: {} }
    const loc = { id: 'loc-hatch', name: 'Hatch Street' }
    const keys = homeTiles(master, loc).map(t => t.key)
    expect(keys).toEqual(['sonos', 'shelly', 'ac', 'doors', 'timer', 'tv'])
    expect(homeTiles(master, null)).toEqual([])
    expect(homeTiles(null, loc)).toEqual([])
  })

  // Quality-bar (a): if homeTiles ever dropped the third (location) arg to
  // canMobile, a master profile would resolve every key to true regardless
  // of the location's tier-1 feature gate below, and every one of these
  // per-location assertions would fail.
  it('device_control gated off at THIS location hides sonos + shelly but not the others (tier-1 feature gate, per-location)', () => {
    const master = { role: 'master' }
    const gated = { id: 'loc-still', features: { device_control: false }, permissions: {}, roleTemplate: {} }
    expect(homeTiles(master, gated).map(t => t.key)).toEqual(['ac', 'doors', 'timer', 'tv'])
  })

  it('studio_management gated off hides ac + doors but not the others', () => {
    const master = { role: 'master' }
    const gated = { id: 'loc-still', features: { studio_management: false }, permissions: {}, roleTemplate: {} }
    expect(homeTiles(master, gated).map(t => t.key)).toEqual(['sonos', 'shelly', 'timer', 'tv'])
  })

  it('class_timer gated off hides only timer', () => {
    const master = { role: 'master' }
    const gated = { id: 'loc-still', features: { class_timer: false }, permissions: {}, roleTemplate: {} }
    expect(homeTiles(master, gated).map(t => t.key)).toEqual(['sonos', 'shelly', 'ac', 'doors', 'tv'])
  })

  it('tv_displays gated off hides only tv', () => {
    const master = { role: 'master' }
    const gated = { id: 'loc-still', features: { tv_displays: false }, permissions: {}, roleTemplate: {} }
    expect(homeTiles(master, gated).map(t => t.key)).toEqual(['sonos', 'shelly', 'ac', 'doors', 'timer'])
  })

  it('an ungated sibling location for the SAME master still shows everything (proves the gate check is truly per-location, not global)', () => {
    const master = { role: 'master' }
    const ungated = { id: 'loc-hatch', features: {}, permissions: {}, roleTemplate: {} }
    expect(homeTiles(master, ungated).map(t => t.key)).toEqual(['sonos', 'shelly', 'ac', 'doors', 'timer', 'tv'])
  })

  it('a staff role with no grants sees only class_timer (its one default-on key; role-default tier, not master short-circuit)', () => {
    const staff = { role: 'staff' }
    const loc = { id: 'loc-still', features: {}, permissions: {}, roleTemplate: {} }
    expect(homeTiles(staff, loc).map(t => t.key)).toEqual(['timer'])
  })
})

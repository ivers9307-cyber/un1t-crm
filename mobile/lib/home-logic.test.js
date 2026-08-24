// mobile/lib/home-logic.test.js
import { describe, it, expect } from 'vitest'
import { shiftWindow, shiftTimeLabel, groupShiftsByDay, homeTiles, safeHomeTiles } from './home-logic'
import { addDays, shortDate, isoDate } from './dates'

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
  // HOME-LOC.4b — built from the same effShiftStart/effShiftEnd resolver as
  // schedule-team.js/schedule.jsx (not a re-implementation), rendered through
  // dates.js's timeRange() so Home matches PersonalDashboard/schedule.jsx's
  // spaced-en-dash convention ('06:00 – 14:00'), deliberately NOT the
  // unspaced '06:00–14:00' the original plan draft pinned.
  it('prefers overrides over template times and trims seconds', () => {
    expect(shiftTimeLabel({ start_time_override: '10:30:00', shift_templates: { start_time: '06:00:00', end_time: '14:00:00' } })).toBe('10:30 – 14:00')
  })
  it('falls back to template times when no override is set', () => {
    expect(shiftTimeLabel({ shift_templates: { start_time: '06:00:00', end_time: '14:00:00' } })).toBe('06:00 – 14:00')
  })
  it('honours the middle effShiftStart rung — a legacy row with a top-level start_time and no override', () => {
    // Only effShiftStart/effShiftEnd know about this rung; a hand-rolled
    // override-or-template resolver would miss it entirely.
    expect(shiftTimeLabel({ start_time: '07:15:00', end_time: '15:00:00', shift_templates: { start_time: '06:00:00', end_time: '14:00:00' } })).toBe('07:15 – 15:00')
  })
  it('empty when nothing is set (timeRange would otherwise render " – ")', () => {
    expect(shiftTimeLabel({})).toBe('')
  })
  it('a start-only shift (no end anywhere) renders just the start, not "10:30 – "', () => {
    expect(shiftTimeLabel({ start_time_override: '10:30:00' })).toBe('10:30')
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

  it('a malformed todayIso (parseIsoDate returns null) returns [] rather than throwing on epoch arithmetic', () => {
    expect(groupShiftsByDay([shift('2026-08-23', '09:00:00')], 'not-a-date')).toEqual([])
    expect(groupShiftsByDay([shift('2026-08-23', '09:00:00')], '2026-02-31')).toEqual([]) // impossible calendar date
    expect(groupShiftsByDay([shift('2026-08-23', '09:00:00')], null)).toEqual([])
  })

  it('a malformed todayIso does not silently fall through to epoch-anchored dates (kills a dropped guard, not just a no-op guard)', () => {
    // Without the explicit `if (!start) return []` guard, addDays(null, i)
    // coerces to `new Date(null)` = the Unix epoch, so a shift dated on
    // whatever the epoch's LOCAL date is would wrongly appear. Compute that
    // real local date with the same isoDate() the implementation uses, so
    // this test can't drift from the epoch/timezone maths it's guarding.
    const epochIso = isoDate(new Date(null))
    const groups = groupShiftsByDay([shift(epochIso, '09:00:00', 'EpochLeak')], 'not-a-date')
    expect(groups).toEqual([])
  })

  it('sorts on the raw effShiftStart value, not the rendered label — two same-start shifts keep insertion order (stable sort), not end-time order', () => {
    // A label-based sort ('09:00 – 18:00' vs '09:00 – 12:00') would tie-break
    // on the end time and reorder these; sorting on effShiftStart alone ties
    // exactly, so JS's stable sort must leave insertion order untouched.
    const laterEnd = { shift_date: '2026-08-23', shift_templates: { name: 'B-later-end', start_time: '09:00:00', end_time: '18:00:00' } }
    const earlierEnd = { shift_date: '2026-08-23', shift_templates: { name: 'A-earlier-end', start_time: '09:00:00', end_time: '12:00:00' } }
    const groups = groupShiftsByDay([laterEnd, earlierEnd], '2026-08-23')
    expect(groups[0].shifts.map(s => s.shift_templates.name)).toEqual(['B-later-end', 'A-earlier-end'])
  })

  it('an untimed shift (no start anywhere) sorts FIRST within its day, ahead of every timed shift', () => {
    const untimed = { shift_date: '2026-08-23', shift_templates: { name: 'Untimed' } }
    const groups = groupShiftsByDay(
      [shift('2026-08-23', '06:00:00', 'Morning'), untimed, shift('2026-08-23', '18:00:00', 'Evening')],
      '2026-08-23'
    )
    expect(groups[0].shifts.map(s => s.shift_templates.name)).toEqual(['Untimed', 'Morning', 'Evening'])
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

  // HOME-LOC.9b — pins which tiles the manual controls launcher may offer:
  // only screens that actually read ?loc= (control-location.js's override
  // tier). Timer/TV bind to activeLocation and would silently command the
  // wrong studio if launched with a forwarded ?loc= — this flag is the
  // guard against that drifting back in unnoticed.
  it('exactly sonos/shelly/ac/doors are locAware — timer/tv are not', () => {
    const master = { role: 'master', permissions: {} }
    const loc = { id: 'loc-hatch', name: 'Hatch Street' }
    expect(homeTiles(master, loc).filter(t => t.locAware).map(t => t.key)).toEqual(['sonos', 'shelly', 'ac', 'doors'])
  })
})

// HOME-LOC.12 — Home renders its on-site tiles for the DETECTED studio, which
// is routinely not the app's activeLocation. Timer and TV read activeLocation
// (they are not loc-aware yet), so offering them under a different studio's
// header is the same false affordance the /controls launcher already filters
// out — except here the tap silently starts a timer at the OTHER gym. This is
// the logic Home's JSX calls; the component itself has no test harness.
describe('safeHomeTiles', () => {
  const master = { role: 'master', permissions: {} }
  const hatch = { id: 'loc-hatch', name: 'Hatch Street' }

  it('offers everything when the detected studio IS the active location', () => {
    expect(safeHomeTiles(master, hatch, 'loc-hatch').map(t => t.key))
      .toEqual(['sonos', 'shelly', 'ac', 'doors', 'timer', 'tv'])
  })

  it('drops timer + tv when the detected studio is NOT the active location', () => {
    expect(safeHomeTiles(master, hatch, 'loc-still').map(t => t.key))
      .toEqual(['sonos', 'shelly', 'ac', 'doors'])
  })

  it('a null activeLocationId is not a match — still only the loc-aware four', () => {
    expect(safeHomeTiles(master, hatch, null).map(t => t.key))
      .toEqual(['sonos', 'shelly', 'ac', 'doors'])
  })

  it('the per-location feature gate still applies on top of the safety filter', () => {
    const gated = { id: 'loc-still', features: { device_control: false }, permissions: {}, roleTemplate: {} }
    // Same location as active → timer/tv survive; device_control off → sonos/shelly do not.
    expect(safeHomeTiles(master, gated, 'loc-still').map(t => t.key)).toEqual(['ac', 'doors', 'timer', 'tv'])
    // Different location → the two survivors are the loc-aware ones only.
    expect(safeHomeTiles(master, gated, 'loc-hatch').map(t => t.key)).toEqual(['ac', 'doors'])
  })

  it('no location at all is still nothing, whatever the active location is', () => {
    expect(safeHomeTiles(master, null, 'loc-hatch')).toEqual([])
  })
})

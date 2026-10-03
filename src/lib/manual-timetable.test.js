import { describe, it, expect } from 'vitest'
import {
  parseManualTimetable,
  manualClassOccurrences,
  manualTimetableConfigFromBlocks,
  isManualEventId,
  DEFAULT_MIN_NOTICE_HOURS,
} from './manual-timetable'
import { PUBLIC_CLASS_KEYS } from './public-classes'

describe('parseManualTimetable', () => {
  it('reads one class time per line: day, time, name', () => {
    const { slots, rejected } = parseManualTimetable('Mon 06:15 Strength\nSat 09:00 Conditioning')
    expect(rejected).toEqual([])
    expect(slots).toEqual([
      { dow: 1, time: '06:15', name: 'Strength' },
      { dow: 6, time: '09:00', name: 'Conditioning' },
    ])
  })

  it('expands day ranges, lists and several times on one line', () => {
    const { slots } = parseManualTimetable('Mon-Wed 06:15, 18:00 UN1T\nTue/Thu 12:15 Lunch')
    expect(slots.filter((s) => s.name === 'UN1T').map((s) => `${s.dow} ${s.time}`)).toEqual([
      '1 06:15', '1 18:00', '2 06:15', '2 18:00', '3 06:15', '3 18:00',
    ])
    expect(slots.filter((s) => s.name === 'Lunch').map((s) => s.dow)).toEqual([2, 4])
  })

  it('reads a range written with spaces, full day names and day groups', () => {
    expect(parseManualTimetable('Monday to Friday 07:00 A').slots.map((s) => s.dow)).toEqual([1, 2, 3, 4, 5])
    expect(parseManualTimetable('Sat - Mon 07:00 A').slots.map((s) => s.dow)).toEqual([1, 6, 7])
    expect(parseManualTimetable('Weekdays 07:00').slots).toHaveLength(5)
    expect(parseManualTimetable('Weekends 10:00').slots.map((s) => s.dow)).toEqual([6, 7])
  })

  it('reads the common ways a time is typed', () => {
    const times = (line) => parseManualTimetable(line).slots.map((s) => s.time)
    expect(times('Mon 6.15 A')).toEqual(['06:15'])
    expect(times('Mon 0615 A')).toEqual(['06:15'])
    expect(times('Mon 6am A')).toEqual(['06:00'])
    expect(times('Mon 6:15pm A')).toEqual(['18:15'])
    expect(times('Mon 6:15 pm A')).toEqual(['18:15'])
    expect(times('Mon 12am A')).toEqual(['00:00'])
    expect(times('Mon 12pm A')).toEqual(['12:00'])
  })

  it('keeps a class name that starts with AM or PM after a 24-hour time', () => {
    expect(parseManualTimetable('Mon 18:00 PM Burn').slots).toEqual([{ dow: 1, time: '18:00', name: 'PM Burn' }])
  })

  it('keeps separators inside a class name and falls back to "Class" for none', () => {
    expect(parseManualTimetable('Mon 06:15 Strength & Conditioning').slots[0].name).toBe('Strength & Conditioning')
    expect(parseManualTimetable('Mon 06:15 - Strength').slots[0].name).toBe('Strength')
    expect(parseManualTimetable('Mon 06:15').slots[0].name).toBe('Class')
  })

  it('returns a line it cannot read instead of guessing, and skips blanks and comments', () => {
    const { slots, rejected } = parseManualTimetable('# weekday mornings\n\nMon 06:15 A\nStrength at six\nMon 25:00 B\nMon 6 C')
    expect(slots).toEqual([{ dow: 1, time: '06:15', name: 'A' }])
    expect(rejected).toEqual(['Strength at six', 'Mon 25:00 B', 'Mon 6 C'])
  })

  it('drops an exact duplicate and is safe on non-text', () => {
    expect(parseManualTimetable('Mon 06:15 A\nmon 6.15 a').slots).toHaveLength(1)
    expect(parseManualTimetable(null)).toEqual({ slots: [], rejected: [] })
    expect(parseManualTimetable(undefined)).toEqual({ slots: [], rejected: [] })
  })
})

describe('manualClassOccurrences', () => {
  const slots = parseManualTimetable('Mon 06:15 Strength\nSat 09:00 Conditioning').slots
  // Thursday 1 October 2026, 10:00 Dublin (IST, UTC+1).
  const now = Date.parse('2026-10-01T09:00:00Z')

  it('produces the public class shape and nothing else', () => {
    const [c] = manualClassOccurrences({ slots, now, minNoticeHours: 0 })
    expect(Object.keys(c).sort()).toEqual([...PUBLIC_CLASS_KEYS].sort())
    expect(c).toMatchObject({
      event_id: 'manual-20261003-0900-conditioning',
      name: 'Conditioning',
      starts_at: '2026-10-03T08:00:00.000Z', // 09:00 Dublin in summer time
      day: '2026-10-03',
      time: '09:00',
    })
    // Same formatter as the Glofox list; the comma depends on the ICU build.
    expect(c.day_label).toMatch(/^Sat,? 3 Oct$/)
    expect(isManualEventId(c.event_id)).toBe(true)
    expect(c.event_id.length).toBeLessThanOrEqual(64)
  })

  it('lists the next 7 Dublin days from today, in time order', () => {
    const list = manualClassOccurrences({ slots, now, minNoticeHours: 0 })
    expect(list.map((c) => `${c.day} ${c.time}`)).toEqual(['2026-10-03 09:00', '2026-10-05 06:15'])
  })

  it('starts the window on the start date when the studio has not opened yet', () => {
    const list = manualClassOccurrences({ slots, now, minNoticeHours: 0, startDate: '2026-10-04' })
    expect(list.map((c) => c.day)).toEqual(['2026-10-05', '2026-10-10'])
  })

  it('ignores a start date already in the past', () => {
    const list = manualClassOccurrences({ slots, now, minNoticeHours: 0, startDate: '2026-09-19' })
    expect(list[0].day).toBe('2026-10-03')
  })

  it('leaves out a class inside the notice window', () => {
    // Friday 2 October 22:00 Dublin: Saturday 09:00 is 11 hours away.
    const fridayNight = Date.parse('2026-10-02T21:00:00Z')
    expect(manualClassOccurrences({ slots, now: fridayNight, minNoticeHours: 12 }).map((c) => c.day)).toEqual(['2026-10-05'])
    expect(manualClassOccurrences({ slots, now: fridayNight, minNoticeHours: 10 }).map((c) => c.day)).toEqual(['2026-10-03', '2026-10-05'])
  })

  it('never lists a class that has already started', () => {
    const satAfter = Date.parse('2026-10-03T08:30:00Z') // 09:30 Dublin
    expect(manualClassOccurrences({ slots, now: satAfter, minNoticeHours: 0 }).map((c) => c.day)).toEqual(['2026-10-05'])
  })

  it('keeps the wall-clock time on the day the clocks go back (25 Oct 2026)', () => {
    const sunday = parseManualTimetable('Sun 06:15 Early\nSun 10:00 Late').slots
    const list = manualClassOccurrences({ slots: sunday, now: Date.parse('2026-10-24T09:00:00Z'), minNoticeHours: 0 })
    expect(list.map((c) => [c.time, c.starts_at])).toEqual([
      ['06:15', '2026-10-25T06:15:00.000Z'], // GMT from 02:00 that morning
      ['10:00', '2026-10-25T10:00:00.000Z'],
    ])
  })

  it('keeps the wall-clock time on the day the clocks go forward (28 Mar 2027)', () => {
    const sunday = parseManualTimetable('Sun 06:15 Early').slots
    const [c] = manualClassOccurrences({ slots: sunday, now: Date.parse('2027-03-27T09:00:00Z'), minNoticeHours: 0 })
    expect(c.starts_at).toBe('2027-03-28T05:15:00.000Z')
  })

  it('gives two classes at the same time different ids, and the same class the same id on every read', () => {
    const two = parseManualTimetable('Sat 09:00 Strength\nSat 09:00 Conditioning').slots
    const a = manualClassOccurrences({ slots: two, now, minNoticeHours: 0 })
    const b = manualClassOccurrences({ slots: two, now: now + 3_600_000, minNoticeHours: 0, days: 14 })
    expect(new Set(a.map((c) => c.event_id)).size).toBe(2)
    for (const c of a) expect(b.map((x) => x.event_id)).toContain(c.event_id)
  })

  it('is empty for no slots', () => {
    expect(manualClassOccurrences({ slots: [], now })).toEqual([])
    expect(manualClassOccurrences({ slots: null, now })).toEqual([])
  })
})

describe('manualTimetableConfigFromBlocks', () => {
  it('is null when the page has no class_funnel block or the block has no timetable', () => {
    expect(manualTimetableConfigFromBlocks(null)).toBeNull()
    expect(manualTimetableConfigFromBlocks([{ type: 'hero' }])).toBeNull()
    expect(manualTimetableConfigFromBlocks([{ type: 'class_funnel' }])).toBeNull()
    expect(manualTimetableConfigFromBlocks([{ type: 'class_funnel', timetable: '  \n ' }])).toBeNull()
  })

  it('reads the timetable, start date and notice hours', () => {
    expect(manualTimetableConfigFromBlocks([
      { type: 'class_funnel', timetable: 'Mon 06:15 A', timetable_start_date: '2026-10-03', min_notice_hours: 6 },
    ])).toEqual({ text: 'Mon 06:15 A', startDate: '2026-10-03', minNoticeHours: 6 })
  })

  it('falls back to the default notice and no start date for blank or malformed values', () => {
    for (const bad of [undefined, null, '', 'soon', -1]) {
      expect(manualTimetableConfigFromBlocks([
        { type: 'class_funnel', timetable: 'Mon 06:15 A', timetable_start_date: '3 Oct', min_notice_hours: bad },
      ])).toEqual({ text: 'Mon 06:15 A', startDate: null, minNoticeHours: DEFAULT_MIN_NOTICE_HOURS })
    }
  })

  it('honours a notice of zero and caps a very large one at a week', () => {
    const cfg = (n) => manualTimetableConfigFromBlocks([{ type: 'class_funnel', timetable: 'Mon 06:15 A', min_notice_hours: n }]).minNoticeHours
    expect(cfg(0)).toBe(0)
    expect(cfg('0')).toBe(0)
    expect(cfg(9999)).toBe(168)
  })
})

describe('isManualEventId', () => {
  it('is true only for ids this module mints', () => {
    expect(isManualEventId('manual-20261003-0900-conditioning')).toBe(true)
    expect(isManualEventId('66f1a2b3c4d5e6f7a8b9c0d1')).toBe(false)
    expect(isManualEventId(null)).toBe(false)
  })
})

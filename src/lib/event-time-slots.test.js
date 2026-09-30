// EVENT-MULTITIME.1 — non-race events (classes, workshops, open days…) can
// offer more than one start time on the same page. Races keep their
// wave picker + 90-minute release window; non-race kinds show a plain
// time picker whenever there is more than one time to choose from.

import { describe, it, expect } from 'vitest'
import { timePickerWaves, initialWaveId, timeRowLabel, formatTimeChoices } from './event-time-slots'

const w = (id, start_time, is_full = false) => ({ id, start_time, is_full })

describe('timePickerWaves', () => {
  it('shows no picker for a single-time non-race event', () => {
    expect(timePickerWaves('open_day', [w('a', '09:00:00')])).toEqual([])
  })

  it('shows every time for a multi-time non-race event, with no release window', () => {
    const waves = [w('a', '08:00:00'), w('b', '09:00:00'), w('c', '18:00:00')]
    expect(timePickerWaves('workshop', waves).map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps full times in the list so the picker can grey them', () => {
    const waves = [w('a', '08:00:00', true), w('b', '09:00:00')]
    expect(timePickerWaves('open_day', waves).map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('never shows a picker for lead_gen', () => {
    expect(timePickerWaves('lead_gen', [w('a', '08:00:00'), w('b', '09:00:00')])).toEqual([])
  })

  it('keeps the race 90-minute window, including for a single wave', () => {
    const waves = [w('a', '10:00:00'), w('b', '11:00:00'), w('c', '14:00:00')]
    expect(timePickerWaves('race', waves).map((x) => x.id)).toEqual(['a', 'b'])
    expect(timePickerWaves('race', [w('a', '10:00:00')]).map((x) => x.id)).toEqual(['a'])
  })

  it('treats a missing kind as race', () => {
    const waves = [w('a', '10:00:00'), w('b', '14:00:00')]
    expect(timePickerWaves(undefined, waves).map((x) => x.id)).toEqual(['a'])
  })

  it('tolerates a non-array', () => {
    expect(timePickerWaves('open_day', null)).toEqual([])
  })
})

describe('initialWaveId', () => {
  it('auto-selects the only time', () => {
    expect(initialWaveId([w('a', '09:00:00')])).toBe('a')
  })

  it('auto-selects the one time that still has space', () => {
    expect(initialWaveId([w('a', '08:00:00', true), w('b', '09:00:00')])).toBe('b')
  })

  it('makes the customer choose when two times have space', () => {
    expect(initialWaveId([w('a', '08:00:00'), w('b', '09:00:00')])).toBe('')
  })

  it('selects nothing when everything is full', () => {
    expect(initialWaveId([w('a', '08:00:00', true)])).toBe('')
    expect(initialWaveId(undefined)).toBe('')
  })
})

describe('timeRowLabel', () => {
  it('says Wave for races and Time for everything else', () => {
    expect(timeRowLabel('race')).toBe('Wave')
    expect(timeRowLabel(null)).toBe('Wave')
    expect(timeRowLabel('open_day')).toBe('Time')
    expect(timeRowLabel('workshop')).toBe('Time')
  })
})

describe('formatTimeChoices', () => {
  it('joins times as HH:MM with "or" before the last', () => {
    expect(formatTimeChoices([w('a', '08:00:00'), w('b', '09:00:00')])).toBe('08:00 or 09:00')
    expect(formatTimeChoices([w('a', '08:00:00'), w('b', '09:00:00'), w('c', '10:30:00')]))
      .toBe('08:00, 09:00 or 10:30')
  })

  it('sorts by start time and skips blanks', () => {
    expect(formatTimeChoices([w('b', '09:00:00'), w('x', null), w('a', '08:00:00')])).toBe('08:00 or 09:00')
  })

  it('returns a single time on its own and empty for none', () => {
    expect(formatTimeChoices([w('a', '09:00:00')])).toBe('09:00')
    expect(formatTimeChoices([])).toBe('')
  })
})

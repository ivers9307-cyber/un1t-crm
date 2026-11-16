// OPENWEEK.1 — how an open week's picked classes read in emails and staff alerts.
import { describe, it, expect } from 'vitest'
import { openWeekClassLines, openWeekClassListHtml, openWeekClassListText } from './open-week-format'

const PICKS = [
  { event_id: 'a', name: 'S&C <Strength>', starts_at: '2026-11-24T07:00:00.000Z' },
  { event_id: 'b', name: 'HIIT', starts_at: '2026-11-25T18:30:00.000Z' },
]

describe('openWeekClassLines', () => {
  it('reads each class as weekday, date, time and name on the studio clock, in order', () => {
    expect(openWeekClassLines(PICKS, 'Europe/Dublin')).toEqual(['Tue 24 Nov, 07:00, S&C <Strength>', 'Wed 25 Nov, 18:30, HIIT'])
    expect(openWeekClassLines(PICKS, 'America/New_York')[0]).toBe('Tue 24 Nov, 02:00, S&C <Strength>')
  })
  it('no picks is no lines', () => {
    expect(openWeekClassLines([], 'Europe/Dublin')).toEqual([])
    expect(openWeekClassLines(null, 'Europe/Dublin')).toEqual([])
  })
})

describe('openWeekClassListHtml / Text', () => {
  it('html is an escaped list; text is one per line', () => {
    expect(openWeekClassListHtml(PICKS, 'Europe/Dublin')).toBe('<ul><li>Tue 24 Nov, 07:00, S&amp;C &lt;Strength&gt;</li><li>Wed 25 Nov, 18:30, HIIT</li></ul>')
    expect(openWeekClassListText(PICKS, 'Europe/Dublin')).toBe('Tue 24 Nov, 07:00, S&C <Strength>\nWed 25 Nov, 18:30, HIIT')
    expect(openWeekClassListHtml([], 'Europe/Dublin')).toBe('')
  })
})

import { describe, it, expect } from 'vitest'
import { formatDuration, formatLastActive, formatPerDay, timelineBars } from './format.js'

const TZ = 'Europe/Dublin'

describe('formatDuration', () => {
  it('reads like the mockup', () => {
    expect(formatDuration(0)).toBe('—')
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(130)).toBe('2m 10s')
    expect(formatDuration(51 * 60)).toBe('51m')
    expect(formatDuration(6 * 3600 + 5 * 60)).toBe('6h 05m')
  })
})

describe('formatPerDay', () => {
  it('rounds to one decimal and hides zero', () => {
    expect(formatPerDay(5.24)).toBe('5.2')
    expect(formatPerDay(0)).toBe('—')
  })
})

describe('formatLastActive', () => {
  const now = Date.UTC(2026, 9, 26, 16, 0)
  it('says today, yesterday, or days ago', () => {
    expect(formatLastActive('2026-10-26T14:32:00Z', now, TZ)).toBe('Today 14:32')
    expect(formatLastActive('2026-10-25T18:55:00Z', now, TZ)).toBe('Yesterday 18:55')
    expect(formatLastActive('2026-10-14T09:00:00Z', now, TZ)).toBe('12 days ago')
    expect(formatLastActive(null, now, TZ)).toBe('Never')
  })
})

describe('timelineBars', () => {
  const day = '2026-10-26'
  it('uses 06:00–22:00 when every session fits', () => {
    const { bars, startHour, endHour } = timelineBars([
      { sessionId: 'a', platform: 'phone', startedAt: '2026-10-26T06:00:00Z', endedAt: '2026-10-26T07:00:00Z' },
    ], day, TZ)
    expect([startHour, endHour]).toEqual([6, 22])
    expect(bars[0]).toMatchObject({ sessionId: 'a', platform: 'phone', left: 0, width: 6.25 })
  })

  it('widens to whole hours to fit an early or late session', () => {
    const { bars, startHour, endHour } = timelineBars([
      { sessionId: 'c', platform: 'web', startedAt: '2026-10-26T02:00:00Z', endedAt: '2026-10-26T03:00:00Z' },
      { sessionId: 'b', platform: 'web', startedAt: '2026-10-26T21:30:00Z', endedAt: '2026-10-26T22:30:00Z' },
    ], day, TZ)
    expect([startHour, endHour]).toEqual([2, 23])
    expect(bars.map((b) => [b.sessionId, Math.round(b.left * 10) / 10, Math.round(b.width * 10) / 10])).toEqual([
      ['c', 0, 4.8], ['b', 92.9, 4.8],
    ])
  })

  it('clips a session that started the day before', () => {
    const { bars, startHour } = timelineBars([
      { sessionId: 'n', platform: 'web', startedAt: '2026-10-25T23:30:00Z', endedAt: '2026-10-26T00:30:00Z' },
    ], day, TZ)
    expect(startHour).toBe(0)
    expect(bars[0].left).toBe(0)
  })

  it('gives a very short session a visible sliver', () => {
    const { bars } = timelineBars([
      { sessionId: 's', platform: 'phone', startedAt: '2026-10-26T09:00:00Z', endedAt: '2026-10-26T09:00:30Z' },
    ], day, TZ)
    expect(bars[0].width).toBe(0.5)
  })
})

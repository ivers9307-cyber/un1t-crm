// NOTIF.4 — tests for parseIsoDate, the guard that turns `?date=` route
// params (fed by push payloads) into a local-time Date. Pure (no RN
// imports), runs under the root vitest like the other mobile/lib tests.

import { describe, it, expect } from 'vitest'
import { parseIsoDate, isoDate } from './dates'

describe('parseIsoDate', () => {
  it('parses a valid YYYY-MM-DD into a local-time midnight Date', () => {
    const d = parseIsoDate('2026-07-10')
    expect(d).toBeInstanceOf(Date)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(6)
    expect(d.getDate()).toBe(10)
    expect(d.getHours()).toBe(0)
    // Round-trips through the local formatter (i.e. no UTC day-shift).
    expect(isoDate(d)).toBe('2026-07-10')
  })

  it('rejects malformed or non-string input', () => {
    expect(parseIsoDate('next week')).toBe(null)
    expect(parseIsoDate('2026-7-1')).toBe(null)
    expect(parseIsoDate('2026-07-10T00:00:00Z')).toBe(null)
    expect(parseIsoDate('')).toBe(null)
    expect(parseIsoDate(null)).toBe(null)
    expect(parseIsoDate(undefined)).toBe(null)
    expect(parseIsoDate(20260710)).toBe(null)
    expect(parseIsoDate(['2026-07-10'])).toBe(null)
  })

  it('rejects impossible calendar dates (no silent rollover)', () => {
    expect(parseIsoDate('2026-02-31')).toBe(null)
    expect(parseIsoDate('2026-13-01')).toBe(null)
    expect(parseIsoDate('2026-00-10')).toBe(null)
  })
})

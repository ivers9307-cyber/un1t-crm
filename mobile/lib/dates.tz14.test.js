// TZ.14 — the roster's "today" is the studio's calendar day in the studio's
// own zone (mobile/lib/dates.js studioTodayIso).
//
// The Europe/Dublin byte-identity sweep against a frozen pre-change copy ran in
// TZ.14 and was retired in TZ.18b: Dublin is pinned below by fixed values, and
// zoned-time ≡ dublin-time stays proven by shared/zoned-time.parity.test.js.
process.env.TZ = 'America/Los_Angeles' // neither zone under test
import { describe, it, expect } from 'vitest'

const { studioTodayIso } = await import('./dates')

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'

describe('TZ.14 studioTodayIso: Europe/Dublin pinned values', () => {
  it('the day flips at Dublin midnight on both sides of both 2026 EU clock changes', () => {
    const at = (iso) => studioTodayIso(DUB, new Date(iso))
    expect(at('2026-03-28T23:59:00Z')).toBe('2026-03-28') // 23:59 GMT Sat
    expect(at('2026-03-29T00:00:00Z')).toBe('2026-03-29') // 00:00 GMT Sun (spring-forward day)
    expect(at('2026-03-29T22:59:00Z')).toBe('2026-03-29') // 23:59 IST
    expect(at('2026-03-29T23:00:00Z')).toBe('2026-03-30') // 00:00 IST Mon
    expect(at('2026-10-24T22:59:00Z')).toBe('2026-10-24') // 23:59 IST Sat
    expect(at('2026-10-24T23:00:00Z')).toBe('2026-10-25') // 00:00 IST Sun (fall-back day)
    expect(at('2026-10-25T23:59:00Z')).toBe('2026-10-25') // 23:59 GMT
    expect(at('2026-10-26T00:00:00Z')).toBe('2026-10-26') // 00:00 GMT Mon
  })
  it('an ordinary summer and winter night', () => {
    expect(studioTodayIso(DUB, new Date('2026-07-01T23:30:00Z'))).toBe('2026-07-02') // 00:30 IST
    expect(studioTodayIso(DUB, new Date('2026-01-15T23:30:00Z'))).toBe('2026-01-15') // 23:30 GMT
  })
  it('an absent or invalid zone (an older server) is Dublin', () => {
    const now = new Date('2026-10-24T23:30:00Z')
    expect(studioTodayIso(undefined, now)).toBe('2026-10-25')
    expect(studioTodayIso(null, now)).toBe('2026-10-25')
    expect(studioTodayIso('Mars/Olympus', now)).toBe('2026-10-25')
  })
})

describe('TZ.14 studioTodayIso: America/New_York follows New York across DST', () => {
  it('the day flips at New York midnight, not Dublin midnight', () => {
    expect(studioTodayIso(NY, new Date('2026-11-01T03:59:00Z'))).toBe('2026-10-31') // 23:59 EDT
    expect(studioTodayIso(NY, new Date('2026-11-01T04:00:00Z'))).toBe('2026-11-01') // 00:00 EDT
    expect(studioTodayIso(NY, new Date('2026-11-02T04:59:00Z'))).toBe('2026-11-01') // 23:59 EST
    expect(studioTodayIso(NY, new Date('2026-11-02T05:00:00Z'))).toBe('2026-11-02') // 00:00 EST
  })
  it('spring forward keeps the same day across the gap', () => {
    expect(studioTodayIso(NY, new Date('2026-03-08T06:59:00Z'))).toBe('2026-03-08')
    expect(studioTodayIso(NY, new Date('2026-03-08T07:00:00Z'))).toBe('2026-03-08')
  })
})

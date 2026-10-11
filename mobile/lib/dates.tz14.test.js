// TZ.14 — the roster's "today" is the studio's calendar day in the studio's
// own zone (mobile/lib/dates.js studioTodayIso).
process.env.TZ = 'America/Los_Angeles' // neither zone under test
import { describe, it, expect } from 'vitest'

const { studioTodayIso } = await import('./dates')
const { dublinTodayIsoLegacy } = await import('./tz14-screens.legacy-dublin.test-helpers.js')

const NY = 'America/New_York'

describe('TZ.14 studioTodayIso: Europe/Dublin is byte-identical', () => {
  it('every half hour of 2026', () => {
    for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 30 * 60_000) {
      const now = new Date(ms)
      expect(studioTodayIso('Europe/Dublin', now)).toBe(dublinTodayIsoLegacy(now))
    }
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

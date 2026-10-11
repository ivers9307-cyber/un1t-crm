// TZ.14 — member screens take the member's HOME studio zone (D7 = A).
process.env.TZ = 'America/Los_Angeles' // neither zone under test
import { describe, it, expect } from 'vitest'

const M = await import('./member-zone.js')
const L = await import('../tz14-screens.legacy-dublin.test-helpers.js')

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
const SAMPLES = [
  '2026-03-07T04:30:00Z', '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z',
  '2026-03-28T23:30:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z',
  '2026-10-24T23:30:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z',
  '2026-11-01T04:59:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z',
  '2026-06-30T22:59:00Z', '2026-06-30T23:00:00Z', '2026-12-31T23:30:00Z',
]
const HOURS_2026 = []
for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 3 * 3_600_000 + 30 * 60_000) HOURS_2026.push(ms)

describe('TZ.14 Europe/Dublin is byte-identical', () => {
  it('Home digest window (last completed week)', () => {
    for (const ms of [...SAMPLES.map(Date.parse), ...HOURS_2026]) {
      expect(M.lastWeekWindow(ms, DUB)).toStrictEqual(L.lastWeekWindowLegacy(ms))
    }
  })
  it('Home this-week pips start', () => {
    for (const ms of [...SAMPLES.map(Date.parse), ...HOURS_2026]) {
      expect(M.thisWeekStartMs(ms, DUB)).toBe(L.thisWeekStartMsLegacy(ms))
    }
  })
  it('"You usually train on …"', () => {
    // Sessions straddling Dublin midnight in both seasons.
    const sets = [
      ['2026-10-24T23:30:00Z', '2026-10-31T23:30:00Z', '2026-11-07T23:30:00Z'],
      ['2026-06-30T22:59:00Z', '2026-06-30T23:00:00Z', '2026-07-07T23:00:00Z'],
      SAMPLES,
      [],
      ['2026-01-05T10:00:00Z'],
    ]
    for (const isos of sets) {
      const sessions = isos.map((started_at) => ({ started_at }))
      expect(M.mostFrequentWeekday(sessions, DUB)).toBe(L.mostFrequentWeekdayLegacy(sessions))
    }
  })
  it('session start time', () => {
    for (const ms of [...SAMPLES.map(Date.parse), ...HOURS_2026]) {
      const iso = new Date(ms).toISOString()
      expect(M.memberClockLabel(iso, DUB)).toBe(L.memberClockLabelLegacy(iso))
    }
    expect(M.memberClockLabel(null, DUB)).toBe(L.memberClockLabelLegacy(null))
  })
  it('the default zone is Dublin', () => {
    expect(M.lastWeekWindow(Date.parse(SAMPLES[0]))).toStrictEqual(L.lastWeekWindowLegacy(Date.parse(SAMPLES[0])))
  })
})

describe('TZ.14 America/New_York follows New York across DST', () => {
  it('the digest window after the NY fall-back week is 7 days + 1 hour long', () => {
    // Mon 2 Nov 2026 12:00 EST: last week = Mon 26 Oct 00:00 EDT → Mon 2 Nov 00:00 EST.
    const w = M.lastWeekWindow(Date.parse('2026-11-02T17:00:00Z'), NY)
    expect(w.lastWeekStartIso).toBe('2026-10-26T04:00:00.000Z')
    expect(w.thisWeekStartIso).toBe('2026-11-02T05:00:00.000Z')
    expect(Date.parse(w.thisWeekStartIso) - Date.parse(w.lastWeekStartIso)).toBe(7 * 86_400_000 + 3_600_000)
  })
  it('the week turns at New York Monday midnight, not Dublin\'s', () => {
    // Sun 8 Mar 23:30 EDT (after spring forward) is still last week in NY,
    // while it is already Monday 03:30 in Dublin.
    expect(M.thisWeekStartMs(Date.parse('2026-03-09T03:30:00Z'), NY)).toBe(Date.parse('2026-03-02T05:00:00Z'))
    expect(M.thisWeekStartMs(Date.parse('2026-03-09T03:30:00Z'), DUB)).toBe(Date.parse('2026-03-09T00:00:00Z'))
  })
  it('a 23:30 New York session counts on the New York weekday', () => {
    // 23:30 EDT on Fridays = 03:30Z Saturday (Saturday in Dublin).
    const sessions = ['2026-10-03T03:30:00Z', '2026-10-10T03:30:00Z'].map((started_at) => ({ started_at }))
    expect(M.mostFrequentWeekday(sessions, NY)).toBe('Friday')
    expect(M.mostFrequentWeekday(sessions, DUB)).toBe('Saturday')
  })
  it('a session start reads on the member\'s clock', () => {
    expect(M.memberClockLabel('2026-07-15T13:00:00Z', NY)).toBe('09:00')
    expect(M.memberClockLabel('2026-12-15T14:00:00Z', NY)).toBe('09:00')
  })
})

describe('TZ.14 memberZoneFromBrand', () => {
  it('reads the brand\'s timezone, falling back to Dublin while absent or invalid', () => {
    expect(M.memberZoneFromBrand({ timezone: NY })).toBe(NY)
    expect(M.memberZoneFromBrand({ timezone: null })).toBe(DUB)
    expect(M.memberZoneFromBrand({})).toBe(DUB)
    expect(M.memberZoneFromBrand(null)).toBe(DUB)
    expect(M.memberZoneFromBrand({ timezone: 'Etc/GMT+5' })).toBe(DUB)
  })
})

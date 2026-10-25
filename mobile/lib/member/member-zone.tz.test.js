// TZ.14 — member screens take the member's HOME studio zone (D7 = A).
//
// The Europe/Dublin byte-identity sweep against a frozen pre-change copy ran in
// TZ.14 and was retired in TZ.18b: Dublin is pinned below by fixed values, and
// zoned-time ≡ dublin-time stays proven by shared/zoned-time.parity.test.js.
process.env.TZ = 'America/Los_Angeles' // neither zone under test
import { describe, it, expect } from 'vitest'

const M = await import('./member-zone.js')

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
// EU DST 2026: spring forward Sun 29 Mar 01:00Z; fall back Sun 25 Oct 01:00Z.
const P = ['2026-01-15T14:30:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', '2026-07-01T23:30:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z']

describe('TZ.14 Europe/Dublin pinned values', () => {
  it('Home digest window (last completed week), across both EU clock changes', () => {
    const w = (iso, zone) => { const { thisWeekStartIso, lastWeekStartIso } = M.lastWeekWindow(Date.parse(iso), zone); return [lastWeekStartIso, thisWeekStartIso] }
    // The week of the spring-forward Sunday is 167 hours; of the fall-back Sunday, 169.
    expect(w('2026-03-30T12:00:00Z', DUB)).toEqual(['2026-03-23T00:00:00.000Z', '2026-03-29T23:00:00.000Z'])
    expect(w('2026-10-26T12:00:00Z', DUB)).toEqual(['2026-10-18T23:00:00.000Z', '2026-10-26T00:00:00.000Z'])
    expect(w('2026-07-15T12:00:00Z', DUB)).toEqual(['2026-07-05T23:00:00.000Z', '2026-07-12T23:00:00.000Z'])
    expect(w('2026-01-15T12:00:00Z', DUB)).toEqual(['2026-01-05T00:00:00.000Z', '2026-01-12T00:00:00.000Z'])
  })
  it('the default zone is Dublin', () => {
    expect(M.lastWeekWindow(Date.parse('2026-03-30T12:00:00Z'))).toStrictEqual(M.lastWeekWindow(Date.parse('2026-03-30T12:00:00Z'), DUB))
    expect(M.lastWeekWindow(Date.parse('2026-03-30T12:00:00Z')).thisWeekStartMs).toBe(Date.parse('2026-03-29T23:00:00Z'))
  })
  it('Home this-week pips start: the week turns at Dublin Monday midnight', () => {
    const s = (iso) => new Date(M.thisWeekStartMs(Date.parse(iso), DUB)).toISOString()
    expect(s('2026-03-29T22:59:00Z')).toBe('2026-03-23T00:00:00.000Z') // 23:59 IST Sun
    expect(s('2026-03-29T23:00:00Z')).toBe('2026-03-29T23:00:00.000Z') // 00:00 IST Mon
    expect(s('2026-10-25T23:59:00Z')).toBe('2026-10-18T23:00:00.000Z') // 23:59 GMT Sun
    expect(s('2026-10-26T00:00:00Z')).toBe('2026-10-26T00:00:00.000Z') // 00:00 GMT Mon
    expect(s('2026-07-15T12:00:00Z')).toBe('2026-07-12T23:00:00.000Z')
    expect(s('2026-01-15T12:00:00Z')).toBe('2026-01-12T00:00:00.000Z')
  })
  it('"You usually train on …" counts the Dublin weekday', () => {
    const f = (isos) => M.mostFrequentWeekday(isos.map((started_at) => ({ started_at })), DUB)
    // 23:30Z on 24 Oct is 00:30 IST Sunday; on 31 Oct / 7 Nov it is 23:30 GMT Saturday.
    expect(f(['2026-10-24T23:30:00Z', '2026-10-31T23:30:00Z', '2026-11-07T23:30:00Z'])).toBe('Saturday')
    // 23:00Z on 30 Jun / 7 Jul is 00:00 IST Wednesday.
    expect(f(['2026-06-30T22:59:00Z', '2026-06-30T23:00:00Z', '2026-07-07T23:00:00Z'])).toBe('Wednesday')
    expect(f([])).toBeNull()
    expect(f(['2026-01-05T10:00:00Z'])).toBeNull()
  })
  it('session start time', () => {
    expect(P.map((iso) => M.memberClockLabel(iso, DUB))).toEqual(['14:30', '00:59', '02:00', '00:30', '01:30', '01:30'])
    expect(M.memberClockLabel(null, DUB)).toBeNull()
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

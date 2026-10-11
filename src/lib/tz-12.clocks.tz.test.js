// tz-12.clocks.tz.test.js — TZ.12. The TV boards' wall clocks (the live HR
// board's and the challenge board's header clock, the cast board's idle clock
// and day line) used the SCREEN's own clock zone (toLocaleTimeString,
// getHours). They now format through the board's studio zone from the payload.
//
// This file runs on a Dublin host clock, i.e. a UN1T kiosk:
//   • Europe/Dublin payload zone: byte-identical to the frozen host-clock
//     bodies (tz-12.legacy-dublin.test-helpers.js), every quarter-hour of 2026.
//   • No payload yet (zone null): still the screen's own clock, byte-identical.
//   • America/New_York payload zone: New York's time on a Dublin screen,
//     across both 2026 US DST changes.
process.env.TZ = 'Europe/Dublin' // the host clock of a UN1T kiosk
import { describe, it, expect } from 'vitest'

const L = await import('./tz-12.legacy-dublin.test-helpers.js')
const { boardZone, boardClockText, idleBoardClock } = await import('./tv-board-time.js')

const D = 'Europe/Dublin'
const NY = 'America/New_York'
const HOUR = 3600_000
const range = (fromIso, toIso, stepMs) => {
  const out = []
  for (let t = Date.parse(fromIso); t < Date.parse(toIso); t += stepMs) out.push(t)
  return out
}
const SWEEP = [
  ...range('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', HOUR / 4),
  // seconds tick on the live board: the minutes around both EU changes, every 7 s
  ...range('2026-03-29T00:58:00Z', '2026-03-29T01:02:00Z', 7_000),
  ...range('2026-10-25T00:58:00Z', '2026-10-25T01:02:00Z', 7_000),
]
const LIVE_OPTS = { hour: '2-digit', minute: '2-digit', second: '2-digit' }
const CHALLENGE_OPTS = { hour: '2-digit', minute: '2-digit' }
const SWEEP_TIMEOUT = 120_000

describe('TZ.12 board clocks on a Dublin screen are byte-identical', () => {
  it('the host really is Dublin (guards the premise of this file)', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(D)
  })

  it('live board header clock, challenge board header clock, cast idle clock: Dublin payload and no payload', () => {
    for (const ms of SWEEP) {
      const now = new Date(ms)
      for (const zone of [boardZone(D), boardZone(undefined)]) {
        expect(boardClockText(now, zone, LIVE_OPTS)).toBe(L.liveTvClockLegacy(now))
        expect(boardClockText(now, zone, CHALLENGE_OPTS)).toBe(L.challengeTvClockLegacy(now))
        expect(idleBoardClock(now, zone)).toStrictEqual(L.idleClockLegacy(now))
      }
    }
  }, SWEEP_TIMEOUT)
})

describe('TZ.12 board clocks follow the studio zone, not the screen', () => {
  it('boardZone: canonical zone, or null before the payload lands', () => {
    expect(boardZone(NY)).toBe(NY)
    expect(boardZone(D)).toBe(D)
    for (const v of [undefined, null, '', 'Not/AZone', '+05:00']) expect(boardZone(v)).toBeNull()
  })

  it('a New York board on a Dublin screen shows New York time across the March spring-forward', () => {
    // 06:59Z = 01:59:00 EST; 07:00Z = 03:00:00 EDT (02:xx never happens).
    expect(boardClockText(new Date('2026-03-08T06:59:00Z'), NY, LIVE_OPTS)).toBe('01:59:00')
    expect(boardClockText(new Date('2026-03-08T07:00:00Z'), NY, LIVE_OPTS)).toBe('03:00:00')
    expect(boardClockText(new Date('2026-03-08T07:00:00Z'), NY, CHALLENGE_OPTS)).toBe('03:00')
    // The same instants on the Dublin screen's own clock.
    expect(L.liveTvClockLegacy(new Date('2026-03-08T07:00:00Z'))).toBe('07:00:00')
  })

  it('and across the November fall-back (01:30 happens twice; 06:00Z is the second)', () => {
    expect(boardClockText(new Date('2026-11-01T05:30:00Z'), NY, CHALLENGE_OPTS)).toBe('01:30')
    expect(boardClockText(new Date('2026-11-01T06:30:00Z'), NY, CHALLENGE_OPTS)).toBe('01:30')
  })

  it("the cast board's idle day line turns over at New York midnight, not Dublin's", () => {
    // 03:30Z on Mon 9 Mar: Dublin is Monday 03:30, New York still Sunday 23:30 EDT.
    const now = new Date('2026-03-09T03:30:00Z')
    expect(idleBoardClock(now, NY)).toStrictEqual({ hh: '23', mm: '30', day: 'Sunday, 8 March' })
    expect(idleBoardClock(now, D)).toStrictEqual({ hh: '03', mm: '30', day: 'Monday, 9 March' })
    // Midnight is '00', never '24'.
    expect(idleBoardClock(new Date('2026-07-01T04:00:00Z'), NY).hh).toBe('00')
  })
})

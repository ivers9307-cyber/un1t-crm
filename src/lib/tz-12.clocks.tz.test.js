// tz-12.clocks.tz.test.js — TZ.12. The TV boards' wall clocks (the live HR
// board's and the challenge board's header clock, the cast board's idle clock
// and day line) used the SCREEN's own clock zone (toLocaleTimeString,
// getHours). They now format through the board's studio zone from the payload.
//
// This file runs on a Dublin host clock, i.e. a UN1T kiosk. TZ.12 proved the
// Dublin payload zone and the no-payload case byte-identical to a frozen copy of
// the host-clock bodies over every quarter-hour of 2026; that sweep was retired
// in TZ.18b. Dublin is now pinned by fixed values around both 2026 EU DST
// changes; zoned-time ≡ dublin-time stays proven by
// shared/zoned-time.parity.test.js.
//   • Europe/Dublin payload zone, and no payload yet (zone null: the screen's
//     own clock): pinned values.
//   • America/New_York payload zone: New York's time on a Dublin screen,
//     across both 2026 US DST changes.
process.env.TZ = 'Europe/Dublin' // the host clock of a UN1T kiosk
import { describe, it, expect } from 'vitest'

const { boardZone, boardClockText, idleBoardClock } = await import('./tv-board-time.js')

const D = 'Europe/Dublin'
const NY = 'America/New_York'
const LIVE_OPTS = { hour: '2-digit', minute: '2-digit', second: '2-digit' }
const CHALLENGE_OPTS = { hour: '2-digit', minute: '2-digit' }

describe('TZ.12 board clocks on a Dublin screen: Europe/Dublin pinned values', () => {
  it('the host really is Dublin (guards the premise of this file)', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(D)
  })

  // [instant, live header, challenge header, idle clock] — identical for a
  // Dublin payload and for no payload yet (the Dublin screen's own clock).
  it.each([
    ['2026-01-15T09:05:07Z', '09:05:07', '09:05', { hh: '09', mm: '05', day: 'Thursday, 15 January' }], // winter, GMT
    ['2026-03-29T00:59:53Z', '00:59:53', '00:59', { hh: '00', mm: '59', day: 'Sunday, 29 March' }], // last GMT seconds
    ['2026-03-29T01:00:00Z', '02:00:00', '02:00', { hh: '02', mm: '00', day: 'Sunday, 29 March' }], // spring-forward: 01:xx skipped
    ['2026-07-01T23:30:00Z', '00:30:00', '00:30', { hh: '00', mm: '30', day: 'Thursday, 2 July' }], // summer, already tomorrow
    ['2026-10-25T00:59:53Z', '01:59:53', '01:59', { hh: '01', mm: '59', day: 'Sunday, 25 October' }], // last IST seconds
    ['2026-10-25T01:00:00Z', '01:00:00', '01:00', { hh: '01', mm: '00', day: 'Sunday, 25 October' }], // fall-back: 01:xx again
  ])('%s', (iso, live, challenge, idle) => {
    const now = new Date(iso)
    for (const zone of [boardZone(D), boardZone(undefined)]) {
      expect(boardClockText(now, zone, LIVE_OPTS)).toBe(live)
      expect(boardClockText(now, zone, CHALLENGE_OPTS)).toBe(challenge)
      expect(idleBoardClock(now, zone)).toStrictEqual(idle)
    }
  })
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
    // The same instant on the Dublin screen's own clock (no payload yet).
    expect(boardClockText(new Date('2026-03-08T07:00:00Z'), null, LIVE_OPTS)).toBe('07:00:00')
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

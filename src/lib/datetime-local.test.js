// COMMSFIX.D.3b — seeding a <input type="datetime-local"> from
// `new Date(iso).toISOString().slice(0, 16)` renders the UTC wall clock into a
// LOCAL-time input: exactly the local/UTC mixing CLAUDE.md bans. The campaign
// editor did this, and handleSchedule then reinterpreted the shown value as
// local — so a 10:00 Dublin send reopened as 09:00 and re-confirming moved it
// an hour earlier, every round trip.
//
// Run under BOTH timezones (the assertions below are offset-derived, so they
// hold in either):
//   TZ=Europe/Dublin npx vitest run src/lib/datetime-local.test.js
//   TZ=America/New_York npx vitest run src/lib/datetime-local.test.js

import { describe, it, expect } from 'vitest'
import { isoToLocalDatetime, localDatetimeToIso } from './datetime-local.js'

const SUMMER = '2026-08-20T09:00:00.000Z'   // IST (UTC+1) in Dublin
const WINTER = '2026-01-20T09:00:00.000Z'   // GMT (UTC+0) in Dublin

// The local wall clock for an instant, derived independently of the helper:
// shift the instant by the local offset, then read it in UTC.
function expectedLocal(iso) {
  const off = new Date(iso).getTimezoneOffset()   // minutes local is BEHIND utc
  return new Date(Date.parse(iso) - off * 60_000).toISOString().slice(0, 16)
}

describe('isoToLocalDatetime', () => {
  it.each([SUMMER, WINTER])('renders the local wall clock for %s', (iso) => {
    expect(isoToLocalDatetime(iso)).toBe(expectedLocal(iso))
  })

  it.each([SUMMER, WINTER])('round-trips %s back to the same instant', (iso) => {
    // This is the whole defect: the old seeding produced a string that, when
    // reparsed as local time (which is what the input and handleSchedule do),
    // pointed at a DIFFERENT instant.
    expect(localDatetimeToIso(isoToLocalDatetime(iso))).toBe(iso)
  })

  it.each([SUMMER, WINTER])('differs from the UTC slice whenever the zone is offset (%s)', (iso) => {
    const utcSlice = new Date(iso).toISOString().slice(0, 16)
    if (new Date(iso).getTimezoneOffset() === 0) {
      expect(isoToLocalDatetime(iso)).toBe(utcSlice)      // UTC box: identical by definition
    } else {
      expect(isoToLocalDatetime(iso)).not.toBe(utcSlice)  // the old code's bug
    }
  })

  it('returns an empty string for null / undefined / an unparseable value', () => {
    expect(isoToLocalDatetime(null)).toBe('')
    expect(isoToLocalDatetime(undefined)).toBe('')
    expect(isoToLocalDatetime('not a date')).toBe('')
  })

  it('zero-pads month, day, hour and minute', () => {
    const out = isoToLocalDatetime('2026-01-02T03:04:00.000Z')
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  })
})

describe('localDatetimeToIso', () => {
  it('returns null for an empty picker', () => {
    expect(localDatetimeToIso('')).toBeNull()
    expect(localDatetimeToIso(null)).toBeNull()
  })

  it('interprets the picked value in the browser timezone', () => {
    const local = isoToLocalDatetime(SUMMER)
    expect(localDatetimeToIso(local)).toBe(SUMMER)
  })
})

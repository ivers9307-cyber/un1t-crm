// BOOKING.2 — regression test for the Dublin wall-clock time render
// shared by booking confirmations, the cancellation email, and the
// event-reminder body. booking_date / start_time are stored as Dublin
// wall-clock with no TZ semantics; the old code did
// `new Date(\`${date}T${time}Z\`)` which parsed the time as UTC and then
// rendered in Europe/Dublin, adding the BST hour (a 17:00 booking went
// out saying 18:00). fmtBookingTime must echo the stored time verbatim
// regardless of the host machine's TZ.
//
// Run under both Europe/Dublin and a US TZ to prove host-TZ
// independence:
//   for tz in Europe/Dublin America/Los_Angeles; do
//     TZ=$tz npx vitest run src/lib/booking-time-format.test.js
//   done

import { describe, it, expect } from 'vitest'
import { fmtBookingTime } from './booking-confirmations'

describe('fmtBookingTime (Dublin wall-clock render)', () => {
  it('renders the stored time verbatim during BST (no +1h drift)', () => {
    // 1 July is firmly inside Irish Summer Time (UTC+1). The bug
    // rendered 18:00 here; the fix must keep 17:00.
    const out = fmtBookingTime('2026-07-01', '17:00:00')
    expect(out).toContain('17:00')
    expect(out).not.toContain('18:00')
    // Day label is anchored on noon-UTC of the booking date, so the
    // weekday must be the booking's own day (Wed 1 Jul 2026).
    expect(out).toContain('Wed')
  })

  it('renders the stored time verbatim outside BST (winter, UTC+0)', () => {
    // Mid-December: Dublin is UTC+0, so even the buggy path happened
    // to be correct here — pin it so a future "fix" can't regress it.
    const out = fmtBookingTime('2026-12-15', '17:00:00')
    expect(out).toContain('17:00')
    expect(out).toContain('Tue')
  })

  it('handles the midnight / early-morning edge during BST', () => {
    // 00:30 local in BST is the classic case where a Z-parse + Dublin
    // render rolls the *date* forward as well as the hour.
    const out = fmtBookingTime('2026-07-01', '00:30:00')
    expect(out).toContain('00:30')
    expect(out).toContain('Wed') // still 1 Jul, not 2 Jul
  })

  it('truncates seconds to HH:MM', () => {
    expect(fmtBookingTime('2026-07-01', '17:00:45')).toContain('17:00')
  })

  it('returns the date label alone when no time is supplied', () => {
    const out = fmtBookingTime('2026-07-01', '')
    expect(out).toContain('Wed')
    expect(out).not.toContain(':')
  })

  it('returns empty string for a missing date', () => {
    expect(fmtBookingTime('', '17:00:00')).toBe('')
    expect(fmtBookingTime(null, '17:00:00')).toBe('')
  })
})

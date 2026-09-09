// ROSTER-FIX.7 — the Schedule tab's fetch-outcome decision table. Pure, so it
// runs under the root vitest (which only collects mobile/lib/**, never a
// .jsx screen).

import { describe, it, expect } from 'vitest'
import { applyWeekResult, TRANSPORT_ERROR } from './schedule-refresh'

const PREV = [{ id: 'a' }, { id: 'b' }]

describe('applyWeekResult', () => {
  it('takes the new rows and clears the error on success', () => {
    expect(applyWeekResult(PREV, { success: true, data: [{ id: 'c' }] }))
      .toEqual({ shifts: [{ id: 'c' }], error: null })
  })

  it('treats a successful empty week as an empty week, not as a failure', () => {
    expect(applyWeekResult(PREV, { success: true, data: [] })).toEqual({ shifts: [], error: null })
    // A success envelope with no data key at all is still a success.
    expect(applyWeekResult(PREV, { success: true })).toEqual({ shifts: [], error: null })
  })

  it('KEEPS the last-good rows on a transport failure and warns non-destructively', () => {
    const res = applyWeekResult(PREV, { success: false, transport: true, error: 'Network error: aborted' })
    expect(res.shifts).toBe(PREV)
    expect(res.error).toBe(TRANSPORT_ERROR)
  })

  it('never surfaces an em dash in the transport copy', () => {
    // Richard's rule — plain punctuation in anything a human reads.
    expect(TRANSPORT_ERROR).not.toMatch(/[—–]/)
  })

  it('empties the list and shows the server message on a real API failure', () => {
    expect(applyWeekResult(PREV, { success: false, status: 403, error: 'Not your studio' }))
      .toEqual({ shifts: [], error: 'Not your studio' })
  })

  it('falls back to the caller-supplied copy when the API failure carries no message', () => {
    expect(applyWeekResult(PREV, { success: false })).toEqual({ shifts: [], error: 'Failed to load shifts' })
    expect(applyWeekResult(PREV, { success: false }, { fallbackError: 'Failed to load roster' }))
      .toEqual({ shifts: [], error: 'Failed to load roster' })
  })

  it('tolerates a missing / non-array previous week and a missing envelope', () => {
    expect(applyWeekResult(null, { success: false, transport: true })).toEqual({ shifts: [], error: TRANSPORT_ERROR })
    expect(applyWeekResult(undefined, { success: true, data: null })).toEqual({ shifts: [], error: null })
    expect(applyWeekResult(PREV, null)).toEqual({ shifts: [], error: 'Failed to load shifts' })
  })

  it('does not mistake a transport envelope for a success because it has no error string', () => {
    // api() always sets success:false alongside transport:true, but a caller
    // must not be able to blank the week by dropping the message.
    expect(applyWeekResult(PREV, { transport: true }).shifts).toBe(PREV)
  })
})

// ROSTER-FIX.7 — the Schedule tab's fetch-outcome decision table. Pure, so it
// runs under the root vitest (which only collects mobile/lib/**, never a
// .jsx screen).

import { describe, it, expect } from 'vitest'
import { applyWeekResult, TRANSPORT_ERROR, weekKey, lastGoodFor, isStaleResponse } from './schedule-refresh'

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

// ROSTER-FIX.7g — the last-good rows are only last-good for the context they
// were fetched in, and a response that arrives after its question changed is
// not an answer.

describe('weekKey', () => {
  it('changes when the location, the user, the week or the view changes', () => {
    const base = { locationId: 'loc-1', profileId: 'p-1', weekStartIso: '2026-09-07', view: 'me' }
    const k = weekKey(base)
    expect(weekKey({ ...base })).toBe(k)
    expect(weekKey({ ...base, locationId: 'loc-2' })).not.toBe(k)
    expect(weekKey({ ...base, profileId: 'p-2' })).not.toBe(k)
    expect(weekKey({ ...base, weekStartIso: '2026-09-14' })).not.toBe(k)
    expect(weekKey({ ...base, view: 'team' })).not.toBe(k)
  })

  it('does not let a missing field collide with a populated one', () => {
    // '' for an absent location must not read as the location literally
    // called 'p-1' with no profile, which naive concatenation would allow.
    expect(weekKey({ profileId: 'p-1', weekStartIso: '2026-09-07', view: 'me' }))
      .not.toBe(weekKey({ locationId: 'p-1', weekStartIso: '2026-09-07', view: 'me' }))
  })
})

describe('lastGoodFor', () => {
  const LG = { key: 'k1', shifts: PREV, timeOff: [{ id: 't' }] }

  it('hands back the rows when the key matches', () => {
    expect(lastGoodFor(LG, 'k1')).toBe(PREV)
    expect(lastGoodFor(LG, 'k1', 'timeOff')).toBe(LG.timeOff)
  })

  it('hands back NOTHING when the key has moved on', () => {
    // The bug: a transport failure on the first fetch after a studio switch
    // replayed the previous studio's roster under the new header.
    expect(lastGoodFor(LG, 'k2')).toEqual([])
    expect(lastGoodFor(LG, 'k2', 'timeOff')).toEqual([])
    expect(applyWeekResult(lastGoodFor(LG, 'k2'), { transport: true }).shifts).toEqual([])
    // ...and still replays it when the context did NOT change.
    expect(applyWeekResult(lastGoodFor(LG, 'k1'), { transport: true }).shifts).toBe(PREV)
  })

  it('is empty for an unset ref, an unset key or a shape it does not recognise', () => {
    expect(lastGoodFor(null, 'k1')).toEqual([])
    expect(lastGoodFor(undefined, 'k1')).toEqual([])
    expect(lastGoodFor(LG, null)).toEqual([])
    expect(lastGoodFor(LG, '')).toEqual([])
    expect(lastGoodFor({ key: 'k1' }, 'k1')).toEqual([])
    expect(lastGoodFor({ key: null, shifts: PREV }, null)).toEqual([])
    expect(lastGoodFor({ key: 'k1', shifts: 'nope' }, 'k1')).toEqual([])
  })
})

describe('isStaleResponse', () => {
  it('drops a response whose stamp is no longer the current one', () => {
    expect(isStaleResponse(2, 1)).toBe(true)
    expect(isStaleResponse('k2', 'k1')).toBe(true)
  })

  it('keeps the response of the newest fetch', () => {
    expect(isStaleResponse(2, 2)).toBe(false)
    expect(isStaleResponse('k1', 'k1')).toBe(false)
  })

  it('compares identity, not looks — an equal-looking object is still stale', () => {
    const current = { id: 1 }
    expect(isStaleResponse(current, current)).toBe(false)
    expect(isStaleResponse(current, { id: 1 })).toBe(true)
  })
})

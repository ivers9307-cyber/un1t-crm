// ROSTER-FIX.4 — the overlap refusal is one sentence shared by the publish
// modal and the approvals queue. Both call sites used to carry their own copy
// and had already drifted on how a range is joined, so the thing worth pinning
// is that one input produces one wording, whichever surface asks.

import { describe, it, expect } from 'vitest'
import { OVERLAP_ERROR, overlapRanges, overlapMessage, rosterErrorMessage } from './roster-overlap-message'

const CONFLICT = {
  error: OVERLAP_ERROR,
  overlapping: [{ id: 'r-month', period_start: '2026-05-01', period_end: '2026-05-31' }],
}

describe('overlapRanges', () => {
  it('joins several ranges', () => {
    expect(overlapRanges({
      overlapping: [
        { period_start: '2026-05-01', period_end: '2026-05-31' },
        { period_start: '2026-06-01', period_end: '2026-06-07' },
      ],
    })).toBe('2026-05-01 to 2026-05-31, 2026-06-01 to 2026-06-07')
  })

  it('renders a single-day roster as one date, not a range repeating itself', () => {
    expect(overlapRanges({ overlapping: [{ period_start: '2026-05-04', period_end: '2026-05-04' }] }))
      .toBe('2026-05-04')
  })

  it('is empty when the server sent the code with no rows', () => {
    expect(overlapRanges({ error: OVERLAP_ERROR })).toBe('')
    expect(overlapRanges(null)).toBe('')
  })
})

describe('overlapMessage', () => {
  it('names the range and what to do about it', () => {
    expect(overlapMessage(CONFLICT))
      .toBe('Those days are already published as part of 2026-05-01 to 2026-05-31. Re-publish that range instead.')
  })

  it('takes the calling surface’s own next step', () => {
    expect(overlapMessage(CONFLICT, 'Reject this draft and re-publish that range instead.'))
      .toMatch(/Reject this draft and re-publish that range instead\.$/)
  })

  it('still stands up with no rows to name', () => {
    expect(overlapMessage({ error: OVERLAP_ERROR }))
      .toBe('Those days are already published as part of another roster. Re-publish that range instead.')
  })
})

describe('rosterErrorMessage', () => {
  it('turns the code into copy', () => {
    expect(rosterErrorMessage(CONFLICT, { nextStep: 'Reject this draft and re-publish that range instead.' }))
      .toContain('2026-05-01 to 2026-05-31')
  })

  it('passes any other server error through untouched', () => {
    expect(rosterErrorMessage({ error: 'Roster is already published; only draft rosters can be approved.' }))
      .toBe('Roster is already published; only draft rosters can be approved.')
  })

  it('never alerts a raw error key or an empty string', () => {
    expect(rosterErrorMessage({}, { fallback: 'Approval failed' })).toBe('Approval failed')
    expect(rosterErrorMessage(undefined, { fallback: 'Approval failed' })).toBe('Approval failed')
  })
})

// Focused test for the notify-onboarding-pace cron's PURE selection helper.
//
// selectPaceNudgeRows is the only branch of the cron that decides WHO gets a
// nudge — it must keep exactly the coach-actionable states (behind, at_risk)
// AND only members who are reachable (have a registered push token). Everything
// else (on_track / expired / completed, or an unreachable member) is dropped so
// we never push noise or burn a dedup claim on someone who can't receive it.
//
// Kept pure so this test needs no DB; the send/dedup loop is exercised by the
// data-layer + customer-push tests it composes.

import { describe, it, expect } from 'vitest'
import { selectPaceNudgeRows } from './route.js'

const lane = [
  { contactId: 'a', status: 'at_risk', weekIndex: 3 },
  { contactId: 'b', status: 'behind', weekIndex: 2 },
  { contactId: 'c', status: 'on_track', weekIndex: 2 },
  { contactId: 'd', status: 'expired', weekIndex: 6 },
  { contactId: 'e', status: 'completed', weekIndex: 4 },
  { contactId: 'f', status: 'behind', weekIndex: 5 }, // reachable? no
]

describe('selectPaceNudgeRows', () => {
  it('keeps only behind/at_risk rows whose contact is reachable', () => {
    const reachable = new Set(['a', 'b', 'c', 'd', 'e']) // f has no token
    const picked = selectPaceNudgeRows(lane, reachable)
    expect(picked.map((r) => r.contactId)).toEqual(['a', 'b'])
  })

  it('drops on_track / expired / completed even when reachable', () => {
    const reachable = new Set(['c', 'd', 'e'])
    expect(selectPaceNudgeRows(lane, reachable)).toEqual([])
  })

  it('drops actionable rows for unreachable members', () => {
    const reachable = new Set() // nobody has a token
    expect(selectPaceNudgeRows(lane, reachable)).toEqual([])
  })

  it('preserves lane order (worst-first) among the survivors', () => {
    const reachable = new Set(['a', 'b', 'f'])
    // a (at_risk) precedes b (behind) precedes f (behind) exactly as the lane
    // presents them — the helper filters, it does not re-sort.
    expect(selectPaceNudgeRows(lane, reachable).map((r) => r.contactId)).toEqual(['a', 'b', 'f'])
  })

  it('tolerates a null/empty lane', () => {
    expect(selectPaceNudgeRows(null, new Set(['a']))).toEqual([])
    expect(selectPaceNudgeRows([], new Set(['a']))).toEqual([])
  })
})

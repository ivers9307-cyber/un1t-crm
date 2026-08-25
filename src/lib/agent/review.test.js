// MIA-BOARD.4 — the nightly reviewer. Ten weeks of zero staff ratings was the
// verdict on passive collection (agent_message_feedback: 0 rows ever), so the
// quality signal is generated instead: every night a rubric reviewer reads
// yesterday's agent-touched conversations and writes a score + flags + a
// worst-moment quote per conversation. Direct API calls, not Batch — at ~3
// conversations/day batching buys nothing.
import { describe, it, expect } from 'vitest'
import {
  parseReviewJson,
  buildReviewTranscript,
  reviewWindow,
  isHandoffSummaryReason,
} from './review'

describe('parseReviewJson', () => {
  it('parses a clean strict-JSON reply', () => {
    const out = parseReviewJson('{"score":4,"flags":[],"summary":"Handled well.","worst_quote":null}')
    expect(out).toEqual({ score: 4, flags: [], summary: 'Handled well.', worst_quote: null })
  })

  it('tolerates code fences and prose around the object', () => {
    const text = 'Here is the review:\n```json\n{"score": 2, "flags": ["eligibility_overreach"], "summary": "Adjudicated an offer question.", "worst_quote": "that wouldn\'t apply"}\n```\nDone.'
    const out = parseReviewJson(text)
    expect(out.score).toBe(2)
    expect(out.flags).toEqual(['eligibility_overreach'])
  })

  it('clamps score to 1-5 and coerces junk flags away', () => {
    const out = parseReviewJson('{"score": 99, "flags": ["ok", 7, null, "x"], "summary": 3}')
    expect(out.score).toBe(5)
    expect(out.flags).toEqual(['ok', 'x'])
    expect(out.summary).toBe(null)
  })

  it('returns null when no JSON object can be found', () => {
    expect(parseReviewJson('The conversation was fine.')).toBe(null)
    expect(parseReviewJson('')).toBe(null)
    expect(parseReviewJson(null)).toBe(null)
  })
})

describe('buildReviewTranscript', () => {
  it('labels the three speakers and keeps order', () => {
    const t = buildReviewTranscript([
      { direction: 'inbound', body: 'Can I book?', source: 'api', sent_by: null },
      { direction: 'outbound', body: 'Sure, what day suits?', source: 'agent', sent_by: null },
      { direction: 'outbound', body: 'I will take this one.', source: 'api', sent_by: 'staff-1' },
    ])
    expect(t).toBe('CUSTOMER: Can I book?\nMIA: Sure, what day suits?\nSTAFF: I will take this one.')
  })

  it('skips empty bodies and clips very long ones', () => {
    const t = buildReviewTranscript([
      { direction: 'inbound', body: '', source: 'api' },
      { direction: 'inbound', body: 'y'.repeat(900), source: 'api' },
    ])
    expect(t.startsWith('CUSTOMER: yyy')).toBe(true)
    expect(t.length).toBeLessThan(650)
  })
})

describe('reviewWindow', () => {
  it("covers yesterday's full Dublin day", () => {
    // 2026-08-25 12:00 UTC → review date 2026-08-24, window = the Dublin day.
    const w = reviewWindow(Date.parse('2026-08-25T12:00:00Z'))
    expect(w.reviewDate).toBe('2026-08-24')
    // Irish Summer Time: Dublin midnight = 23:00 UTC the previous day.
    expect(w.startIso).toBe('2026-08-23T23:00:00.000Z')
    expect(w.endIso).toBe('2026-08-24T23:00:00.000Z')
  })
})

describe('isHandoffSummaryReason', () => {
  it('rejects mechanical reasons and accepts free-text handoff summaries', () => {
    expect(isHandoffSummaryReason('handed_off')).toBe(false)
    expect(isHandoffSummaryReason('agent_paused')).toBe(false)
    expect(isHandoffSummaryReason('model_error')).toBe(false)
    expect(isHandoffSummaryReason(null)).toBe(false)
    expect(isHandoffSummaryReason('Customer Fernanda has a billing issue, emails unanswered.')).toBe(true)
  })
})

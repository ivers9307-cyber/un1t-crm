// AGENT-FOLLOWUP.1 — pure decision logic for Mia's proactive
// follow-ups. The ladder: in-window nudge (3-20h quiet) → ONE
// approved marketing template outside the window (24-48h) whose only
// job is earning a reply that re-opens the window → stop.
import { describe, it, expect } from 'vitest'
import {
  classifyFollowupCandidate,
  withinDublinDaytime,
  deriveFollowupTopic,
  buildFollowupComponents,
  renderFollowupBody,
  classifyCheckinCandidate,
  attendedClassName,
  proactiveWindowOpen,
  countCheckinSends,
} from './followups'

const H = 3600_000
const now = Date.UTC(2026, 5, 12, 14, 0, 0) // 15:00 Dublin

function candidate(overrides = {}) {
  return {
    stage: 0,
    lastInboundAtMs: now - 5 * H,
    agentSpokeAfterInbound: true,
    humanSpokeAfterInbound: false,
    sensitiveIntent: false,
    intentClosed: false,
    nowMs: now,
    nudgeAfterHours: 3,
    ...overrides,
  }
}

describe('classifyFollowupCandidate', () => {
  it('nudges a quiet open thread inside the window', () => {
    expect(classifyFollowupCandidate(candidate())).toEqual({ action: 'nudge' })
  })
  it('is patient before the nudge age', () => {
    expect(classifyFollowupCandidate(candidate({ lastInboundAtMs: now - 1 * H })).action).toBeNull()
  })
  it('leaves margin before the 24h window shuts (20-24h = no free-form)', () => {
    expect(classifyFollowupCandidate(candidate({ lastInboundAtMs: now - 22 * H })).action).toBeNull()
  })
  it('sends the template once outside the window (24-48h), even if the nudge was missed', () => {
    expect(classifyFollowupCandidate(candidate({ lastInboundAtMs: now - 30 * H })).action).toBe('template')
    expect(classifyFollowupCandidate(candidate({ stage: 1, lastInboundAtMs: now - 30 * H })).action).toBe('template')
  })
  it('never nudges twice and never chases past 48h', () => {
    expect(classifyFollowupCandidate(candidate({ stage: 1 })).action).toBeNull()
    expect(classifyFollowupCandidate(candidate({ lastInboundAtMs: now - 60 * H })).action).toBeNull()
  })
  it('skips when a human is handling, the intent concluded, or it is a pause/cancel cycle', () => {
    expect(classifyFollowupCandidate(candidate({ humanSpokeAfterInbound: true })).reason).toBe('human_active')
    expect(classifyFollowupCandidate(candidate({ intentClosed: true })).reason).toBe('concluded')
    expect(classifyFollowupCandidate(candidate({ sensitiveIntent: true })).reason).toBe('sensitive_intent')
  })
  it('skips threads where the agent never made an open offer', () => {
    expect(classifyFollowupCandidate(candidate({ agentSpokeAfterInbound: false })).reason).toBe('no_open_offer')
  })
})

describe('withinDublinDaytime', () => {
  it('allows Dublin daytime and blocks the evening/night', () => {
    expect(withinDublinDaytime(Date.UTC(2026, 5, 12, 13, 0))).toBe(true)  // 14:00 Dublin
    expect(withinDublinDaytime(Date.UTC(2026, 5, 12, 21, 30))).toBe(false) // 22:30 Dublin
    expect(withinDublinDaytime(Date.UTC(2026, 5, 12, 6, 0))).toBe(false)  // 07:00 Dublin
  })
})

// MIA-REVIEW.3 (3.17) — a Mia-INITIATED message must respect the operator's
// quiet_hours, which only the live reply path honoured. A studio configured to
// go quiet at 18:00 was still getting nudges and check-ins until 20:00.
describe('proactiveWindowOpen', () => {
  const noon = Date.UTC(2026, 5, 12, 13, 0)   // 14:00 Dublin
  it('opens in Dublin daytime with no quiet hours configured', () => {
    expect(proactiveWindowOpen(noon, {})).toEqual({ open: true })
    expect(proactiveWindowOpen(noon, null)).toEqual({ open: true })
  })
  it('closes inside the operator quiet-hours window', () => {
    const quiet = { quiet_hours: { start: '13:00', end: '09:00', tz: 'Europe/Dublin' } }
    expect(proactiveWindowOpen(noon, quiet)).toEqual({ open: false, reason: 'operator_quiet_hours' })
  })
  it('still closes outside the hard daytime band regardless of settings', () => {
    expect(proactiveWindowOpen(Date.UTC(2026, 5, 12, 21, 30), {}))
      .toEqual({ open: false, reason: 'outside_daytime' })
  })
  it('an incomplete quiet_hours config never blocks a send', () => {
    expect(proactiveWindowOpen(noon, { quiet_hours: { start: '21:00' } })).toEqual({ open: true })
  })
})

// MIA-REVIEW.3 (3.19) — the daily cap must count SENDS. stampCheckin also
// stamps the once-ever marker for skips ('skipped — no marketing consent'),
// which used to eat the cap and stop genuine check-ins early.
describe('countCheckinSends', () => {
  it('counts real sends and ignores skip stamps', () => {
    expect(countCheckinSends([
      { note: 'ARENA (in-window)' },
      { note: 'ARENA (template)' },
      { note: 'ARENA (skipped — no marketing consent)' },
      { note: 'ARENA (skipped — already discussed)' },
    ])).toBe(2)
  })
  it('handles empty / missing input', () => {
    expect(countCheckinSends([])).toBe(0)
    expect(countCheckinSends(null)).toBe(0)
    expect(countCheckinSends([{}])).toBe(1)
  })
})

describe('deriveFollowupTopic', () => {
  it('maps the last agent messages to a short topic', () => {
    expect(deriveFollowupTopic(['Here are the consultation slots for tomorrow…'])).toBe('booking a consultation')
    expect(deriveFollowupTopic(['ARENA has spaces at 7am — want me to book you in?'])).toBe('booking a class')
    expect(deriveFollowupTopic(['Our membership starts at…'])).toBe('membership options')
    expect(deriveFollowupTopic(['Anything else?'])).toBe('your question')
  })
})

describe('template components + recorded body', () => {
  const template = { components: [{ type: 'BODY', text: 'Hi {{1}}, Mia here — you were asking about {{2}}. Want me to pick it back up?' }] }
  it('builds positional params and renders the recorded body', () => {
    const comps = buildFollowupComponents(2, ['Sarah', 'booking a class'])
    expect(comps).toEqual([{ type: 'body', parameters: [
      { type: 'text', text: 'Sarah' }, { type: 'text', text: 'booking a class' },
    ]}])
    expect(renderFollowupBody(template, ['Sarah', 'booking a class']))
      .toBe('Hi Sarah, Mia here — you were asking about booking a class. Want me to pick it back up?')
  })
  it('handles zero-var templates and pads missing params', () => {
    expect(buildFollowupComponents(0, ['Sarah'])).toEqual([])
    const comps = buildFollowupComponents(3, ['Sarah', 'classes'])
    expect(comps[0].parameters.map(p => p.text)).toEqual(['Sarah', 'classes', 'classes'])
  })
})

// AGENT-CHECKIN.1 — eligibility for the post-first-class check-in.
describe('classifyCheckinCandidate', () => {
  const base = {
    stage: 'first_class',
    lastAttendedAtMs: now - 3 * H,
    checkinSentAt: null,
    nowMs: now,
    delayHours: 2,
  }
  it('sends for a lead-stage contact, after the delay, once ever', () => {
    expect(classifyCheckinCandidate(base)).toEqual({ action: 'checkin' })
  })
  it('waits for the delay and expires after 24h', () => {
    expect(classifyCheckinCandidate({ ...base, lastAttendedAtMs: now - 1 * H }).reason).toBe('too_soon')
    expect(classifyCheckinCandidate({ ...base, lastAttendedAtMs: now - 30 * H }).reason).toBe('expired')
  })
  it('never repeats and never targets established members', () => {
    expect(classifyCheckinCandidate({ ...base, checkinSentAt: '2026-06-01T00:00:00Z' }).reason).toBe('already_sent')
    expect(classifyCheckinCandidate({ ...base, stage: 'member' }).reason).toBe('not_new')
    expect(classifyCheckinCandidate({ ...base, stage: null }).reason).toBe('not_new')
  })
})

describe('attendedClassName', () => {
  const attendedSec = Math.floor((now - 3 * H) / 1000)
  it('finds the attended booking nearest the attendance stamp', () => {
    const name = attendedClassName([
      { event_name: 'ARENA', time_start: attendedSec - 86400 * 3, attended: true },
      { event_name: 'FUS1ON - HYBRID', time_start: attendedSec, attended: true },
      { event_name: 'HYROX', time_start: attendedSec + 86400, attended: false },
    ], now - 3 * H)
    expect(name).toBe('FUS1ON - HYBRID')
  })
  it('falls back to null on no attended bookings', () => {
    expect(attendedClassName([{ event_name: 'X', attended: false }], now)).toBeNull()
    expect(attendedClassName(null, now)).toBeNull()
  })
})

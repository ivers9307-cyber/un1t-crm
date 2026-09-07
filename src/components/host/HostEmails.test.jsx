import { describe, it, expect } from 'vitest'
import {
  buildTestSendBody, statsLine, rowSubline, schedulePanelDefaults, audienceSummary, sendConfirmCopy,
} from './HostEmails.jsx'

// HOST-EMAIL.10 — the Test button prompts for an address and posts it to
// /api/host/emails/[id]/send-test. Pure-function test only (the repo's host
// component convention, and jsdom cannot tell us anything useful about a
// prompt anyway): buildTestSendBody is the whole decision the click makes.
//
// A BLANK prompt must post {} rather than { to: '' }. The route treats a
// missing `to` as "use the host session's own email", but an empty string is
// a malformed address and 400s — so trimming to {} is what makes "just send
// it to me" work.

describe('buildTestSendBody', () => {
  it('posts the typed address', () => {
    expect(buildTestSendBody('richard@example.com')).toEqual({ to: 'richard@example.com' })
  })

  it('trims surrounding whitespace off a pasted address', () => {
    expect(buildTestSendBody('  richard@example.com  ')).toEqual({ to: 'richard@example.com' })
  })

  it('posts an empty body when the prompt is left blank, so the server uses the host email', () => {
    expect(buildTestSendBody('')).toEqual({})
  })

  it('treats a whitespace-only prompt as blank', () => {
    expect(buildTestSendBody('   ')).toEqual({})
  })

  it('treats a null prompt (cancelled dialog) as blank rather than throwing', () => {
    expect(buildTestSendBody(null)).toEqual({})
  })
})

describe('statsLine', () => {
  it('joins the headline stats for the list-row subline', () => {
    expect(statsLine({ sent: 124, delivered: 118, opened: 41, clicked: 9 })).toBe('124 sent · 118 delivered · 41 opened · 9 clicked')
  })

  it('returns null when there are no stats yet (old rows)', () => {
    expect(statsLine(undefined)).toBe(null)
  })
})

// HOST-SCHEDULE.1 — the list row's subline is one pure decision over the
// campaign row, and the schedule panel opens either on the row's own time
// (Change time) or on the next quarter hour (a fresh schedule).
describe('rowSubline', () => {
  it('a plain draft', () => {
    expect(rowSubline({ status: 'draft' })).toBe('Not sent yet')
  })
  it('a draft the sweeper refused reads the reason in plain words', () => {
    expect(rowSubline({ status: 'draft', schedule_error: 'daily_cap' })).toBe('Not sent. Daily send limit was reached. Schedule it again or send it now.')
  })
  it('a scheduled row shows the Dublin time', () => {
    expect(rowSubline({ status: 'scheduled', scheduled_for: '2026-09-09T08:00:00.000Z' })).toBe('Scheduled for Wed 9 Sep, 09:00')
  })
  it('a sent row with stats keeps the stats line', () => {
    expect(rowSubline({ status: 'sent', stats: { sent: 124, delivered: 118, opened: 41, clicked: 9 } })).toBe('124 sent · 118 delivered · 41 opened · 9 clicked')
  })
  it('a sent row without stats falls back to the coarse count', () => {
    expect(rowSubline({ status: 'sent', sent_count: 120, recipient_count: 124 })).toBe('120/124 sent')
  })
})

describe('schedulePanelDefaults', () => {
  it('prefills a scheduled row with its own time', () => {
    expect(schedulePanelDefaults({ scheduled_for: '2026-09-09T08:00:00.000Z' }, Date.parse('2026-09-07T10:03:00Z'))).toEqual({ date: '2026-09-09', time: '09:00' })
  })
  it('defaults a draft to the next quarter hour at least 15 minutes out', () => {
    expect(schedulePanelDefaults({ scheduled_for: null }, Date.parse('2026-09-07T10:03:00Z'))).toEqual({ date: '2026-09-07', time: '11:30' })
  })
  it('falls back to the next quarter hour when scheduled_for is garbage', () => {
    expect(schedulePanelDefaults({ scheduled_for: 'nope' }, Date.parse('2026-09-07T10:03:00Z'))).toEqual({ date: '2026-09-07', time: '11:30' })
  })
})

describe('rowSubline — paused (HOST-EMAILS.2)', () => {
  it('a sending row with a paused_reason says why and who to ask', () => {
    expect(rowSubline({ status: 'sending', paused_reason: 'no_stream' })).toBe('Paused. Marketing sending is not set up yet. Ask UN1T.')
  })
  it('a sending row without a reason keeps the stats line fallback', () => {
    expect(rowSubline({ status: 'sending', sent_count: 3, recipient_count: 10 })).toBe('3/10 sent')
  })
})

describe('audienceSummary', () => {
  const byId = new Map([['p1', { id: 'p1', subject: 'Race week' }]])
  it('names the parent for a reminder draft', () => {
    expect(audienceSummary({ audience_kind: 'non_openers', audience_campaign_id: 'p1' }, byId)).toBe("People who didn't open 'Race week'")
  })
  it('falls back when the parent is gone', () => {
    expect(audienceSummary({ audience_kind: 'non_openers', audience_campaign_id: 'zz' }, byId)).toBe("People who didn't open the original email")
  })
  it('is empty for ordinary audiences (the select shows those)', () => {
    expect(audienceSummary({ audience_kind: 'all' }, byId)).toBe('')
  })
})

describe('sendConfirmCopy', () => {
  it('reminder drafts confirm against the parent subject', () => {
    expect(sendConfirmCopy({ audience_kind: 'non_openers', audience_campaign_id: 'p1', email_type: 'marketing' }, 'attendees', new Map([['p1', { subject: 'Race week' }]])))
      .toBe("Send this email to people who didn't open 'Race week'?")
  })
  it('ordinary drafts keep the audience label and the utility note', () => {
    expect(sendConfirmCopy({ audience_kind: 'all', email_type: 'utility' }, 'all 10 contacts (where emailable)', new Map()))
      .toBe('Send this email to all 10 contacts (where emailable) as a UTILITY email (reaches attendees regardless of marketing opt-in)?')
  })
})

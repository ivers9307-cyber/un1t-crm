import { describe, it, expect } from 'vitest'
import { buildTestSendBody, statsLine, rowSubline, schedulePanelDefaults } from './HostEmails.jsx'

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
})

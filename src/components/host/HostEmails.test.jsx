import { describe, it, expect } from 'vitest'
import { buildTestSendBody, statsLine } from './HostEmails.jsx'

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

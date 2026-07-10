// EMAIL-INBOX.1 — pure helpers behind the inbound-email webhook's
// threading resolution + the inbox reply composer. TDD: these tests
// were written before the implementation.

import { describe, it, expect } from 'vitest'
import {
  normalizeEmail,
  getHeader,
  extractCandidateMessageIds,
  extractRfcMessageId,
  recipientEmails,
  matchLocationByRecipient,
  pickContact,
  replySubject,
  buildReplyHeaders,
  inboundPreview,
  truncateHtmlBody,
  HTML_BODY_MAX_CHARS,
} from './email-inbox'

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  John.Doe@Example.COM ')).toBe('john.doe@example.com')
  })
  it('returns null for falsy / non-string / non-address input', () => {
    expect(normalizeEmail(null)).toBe(null)
    expect(normalizeEmail(undefined)).toBe(null)
    expect(normalizeEmail(42)).toBe(null)
    expect(normalizeEmail('not-an-email')).toBe(null)
    expect(normalizeEmail('')).toBe(null)
  })
})

describe('getHeader', () => {
  const headers = [
    { Name: 'In-Reply-To', Value: '<abc@mtasv.net>' },
    { Name: 'REFERENCES', Value: '<one@x> <two@y>' },
  ]
  it('finds a header case-insensitively', () => {
    expect(getHeader(headers, 'in-reply-to')).toBe('<abc@mtasv.net>')
    expect(getHeader(headers, 'References')).toBe('<one@x> <two@y>')
  })
  it('returns null when missing or headers malformed', () => {
    expect(getHeader(headers, 'Message-ID')).toBe(null)
    expect(getHeader(null, 'In-Reply-To')).toBe(null)
    expect(getHeader('nope', 'In-Reply-To')).toBe(null)
  })
})

describe('extractCandidateMessageIds', () => {
  it('parses In-Reply-To first, then References newest-first', () => {
    const headers = [
      { Name: 'References', Value: '<root@a.com> <mid@b.com>' },
      { Name: 'In-Reply-To', Value: '<last@c.com>' },
    ]
    const ids = extractCandidateMessageIds(headers)
    // In-Reply-To id leads; References walk newest → oldest.
    expect(ids[0]).toBe('last@c.com')
    expect(ids).toContain('mid@b.com')
    expect(ids).toContain('root@a.com')
    expect(ids.indexOf('mid@b.com')).toBeLessThan(ids.indexOf('root@a.com'))
  })
  it('emits the local part before @ as an extra candidate (Postmark MessageID match)', () => {
    const headers = [{ Name: 'In-Reply-To', Value: '<11111111-2222-3333-4444-555555555555@mtasv.net>' }]
    const ids = extractCandidateMessageIds(headers)
    expect(ids).toContain('11111111-2222-3333-4444-555555555555@mtasv.net')
    expect(ids).toContain('11111111-2222-3333-4444-555555555555')
  })
  it('dedupes and handles missing headers', () => {
    expect(extractCandidateMessageIds([])).toEqual([])
    expect(extractCandidateMessageIds(null)).toEqual([])
    const headers = [
      { Name: 'In-Reply-To', Value: '<same@x.com>' },
      { Name: 'References', Value: '<same@x.com>' },
    ]
    const ids = extractCandidateMessageIds(headers)
    expect(ids.filter(i => i === 'same@x.com')).toHaveLength(1)
  })
})

describe('extractRfcMessageId', () => {
  it('returns the Message-ID header with angle brackets stripped', () => {
    expect(extractRfcMessageId([{ Name: 'Message-ID', Value: '<abc@gmail.com>' }])).toBe('abc@gmail.com')
    expect(extractRfcMessageId([{ Name: 'Message-Id', Value: 'noAngle@x' }])).toBe('noAngle@x')
  })
  it('returns null when absent', () => {
    expect(extractRfcMessageId([])).toBe(null)
  })
})

describe('recipientEmails', () => {
  it('collects ToFull, CcFull and OriginalRecipient, normalized + deduped', () => {
    const payload = {
      ToFull: [{ Email: 'Replies@Mail.un1t.ie', Name: 'UN1T' }],
      CcFull: [{ Email: 'other@x.com' }],
      OriginalRecipient: 'replies@mail.un1t.ie',
    }
    expect(recipientEmails(payload)).toEqual(['replies@mail.un1t.ie', 'other@x.com'])
  })
  it('falls back to parsing the To display string', () => {
    const payload = { To: '"Front Desk" <desk@un1t.ie>, hello@un1t.ie' }
    expect(recipientEmails(payload)).toEqual(['desk@un1t.ie', 'hello@un1t.ie'])
  })
  it('returns [] for an empty payload', () => {
    expect(recipientEmails({})).toEqual([])
    expect(recipientEmails(null)).toEqual([])
  })
})

describe('matchLocationByRecipient', () => {
  const locations = [
    { id: 'loc-1', email_inbox_reply_to: 'Replies@stillorgan.un1t.ie' },
    { id: 'loc-2', email_inbox_reply_to: 'replies@hatch.un1t.ie' },
    { id: 'loc-3', email_inbox_reply_to: null },
  ]
  it('matches case-insensitively against email_inbox_reply_to', () => {
    expect(matchLocationByRecipient(locations, ['replies@stillorgan.un1t.ie'])?.id).toBe('loc-1')
    expect(matchLocationByRecipient(locations, ['nope@x.com', 'REPLIES@HATCH.UN1T.IE'])?.id).toBe('loc-2')
  })
  it('returns null when nothing matches', () => {
    expect(matchLocationByRecipient(locations, ['unknown@x.com'])).toBe(null)
    expect(matchLocationByRecipient([], ['replies@stillorgan.un1t.ie'])).toBe(null)
  })
})

describe('pickContact', () => {
  const contacts = [
    { id: 'c-newer', location_id: 'loc-2', created_at: '2026-02-01T00:00:00Z' },
    { id: 'c-older', location_id: 'loc-2', created_at: '2026-01-01T00:00:00Z' },
    { id: 'c-other-loc', location_id: 'loc-1', created_at: '2026-03-01T00:00:00Z' },
  ]
  it('prefers contacts at the resolved location', () => {
    expect(pickContact(contacts, 'loc-1')?.id).toBe('c-other-loc')
  })
  it('is deterministic: oldest created_at wins, id tiebreak', () => {
    expect(pickContact(contacts, 'loc-2')?.id).toBe('c-older')
    expect(pickContact(contacts, null)?.id).toBe('c-older')
    const tie = [
      { id: 'b', location_id: 'x', created_at: '2026-01-01T00:00:00Z' },
      { id: 'a', location_id: 'x', created_at: '2026-01-01T00:00:00Z' },
    ]
    expect(pickContact(tie, null)?.id).toBe('a')
  })
  it('returns null for empty input', () => {
    expect(pickContact([], 'loc-1')).toBe(null)
    expect(pickContact(null, 'loc-1')).toBe(null)
  })
})

describe('replySubject', () => {
  it('prefixes Re: once', () => {
    expect(replySubject('Your trial class')).toBe('Re: Your trial class')
    expect(replySubject('Re: Your trial class')).toBe('Re: Your trial class')
    expect(replySubject('RE: Your trial class')).toBe('RE: Your trial class')
  })
  it('handles empty subjects', () => {
    expect(replySubject('')).toBe('Re: (no subject)')
    expect(replySubject(null)).toBe('Re: (no subject)')
  })
})

describe('buildReplyHeaders', () => {
  it('builds In-Reply-To + References with angle brackets', () => {
    const headers = buildReplyHeaders({ rfcMessageId: 'abc@gmail.com', referencesHeader: '<root@x> <mid@y>' })
    expect(headers).toContainEqual({ Name: 'In-Reply-To', Value: '<abc@gmail.com>' })
    expect(headers).toContainEqual({ Name: 'References', Value: '<root@x> <mid@y> <abc@gmail.com>' })
  })
  it('starts References fresh when the inbound had none', () => {
    const headers = buildReplyHeaders({ rfcMessageId: 'abc@gmail.com', referencesHeader: null })
    expect(headers).toContainEqual({ Name: 'References', Value: '<abc@gmail.com>' })
  })
  it('returns [] when there is nothing to thread on', () => {
    expect(buildReplyHeaders({ rfcMessageId: null, referencesHeader: null })).toEqual([])
  })
})

describe('inboundPreview', () => {
  it('collapses whitespace and caps at 100 chars', () => {
    expect(inboundPreview('Hi,\n\nCan I  book a class?\n')).toBe('Hi, Can I book a class?')
    const long = 'x'.repeat(300)
    expect(inboundPreview(long)).toHaveLength(100)
  })
  it('returns empty string for falsy input', () => {
    expect(inboundPreview(null)).toBe('')
  })
})

describe('truncateHtmlBody', () => {
  it('passes small bodies through and truncates giant ones', () => {
    expect(truncateHtmlBody('<p>hi</p>')).toBe('<p>hi</p>')
    const giant = 'a'.repeat(HTML_BODY_MAX_CHARS + 1000)
    expect(truncateHtmlBody(giant)).toHaveLength(HTML_BODY_MAX_CHARS)
    expect(truncateHtmlBody(null)).toBe(null)
  })
})

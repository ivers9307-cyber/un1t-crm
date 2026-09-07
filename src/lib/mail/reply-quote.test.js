import { describe, it, expect } from 'vitest'
import {
  selectReplyAnchor, anchorMessageId, replyReferences, replyThreadingHeaders,
  attributionStamp, attributionLine, quotedTextBlock, buildReplyText, buildReplyHtml,
  escapeHtml,
} from './reply-quote'
import { FORWARD_QUOTE_MAX_CHARS, FORWARD_TRUNCATED_NOTE } from '@/lib/email-forward'

const inbound = {
  id: 'in-1', direction: 'inbound', from_email: 'Richard@richardivers.com', subject: 'Re: test',
  text_body: 'Test test 2\n> test', rfc_message_id: 'CANz@mail.gmail.com', postmark_message_id: 'pm-in',
  in_reply_to: '<80d4@mtasv.net>', references_header: '<80d4@mtasv.net>', created_at: '2026-09-07T12:34:15Z',
}
const outboundPostmark = {
  id: 'out-1', direction: 'outbound', from_email: 'accounts@hatchstreetfitness.com', subject: 'test',
  text_body: 'test\n\n-- \nRichard', rfc_message_id: null, postmark_message_id: '80d4bc38-22a5-4462-b93e-5dd29704d473',
  in_reply_to: null, references_header: null, created_at: '2026-09-07T12:33:47Z', is_internal_note: false,
}
const outboundSmtp = { ...outboundPostmark, id: 'out-2', rfc_message_id: 'e6c4@un1t.com', postmark_message_id: null }
const note = { id: 'n-1', direction: 'outbound', is_internal_note: true, text_body: 'staff only', created_at: '2026-09-07T12:40:00Z' }
const conversation = { requester_email: 'richard@richardivers.com', requester_name: 'Richard Ivers' }
const mailbox = { address: 'accounts@hatchstreetfitness.com', label: 'Hatch Street Fitness Accounts' }

describe('selectReplyAnchor', () => {
  it('picks the newest message by created_at in either direction', () => {
    expect(selectReplyAnchor([outboundPostmark, inbound]).id).toBe('in-1')
    expect(selectReplyAnchor([inbound, { ...outboundPostmark, created_at: '2026-09-07T12:50:00Z' }]).id).toBe('out-1')
  })
  it('skips internal notes', () => {
    expect(selectReplyAnchor([inbound, note]).id).toBe('in-1')
  })
  it('includes forwards', () => {
    const fwd = { ...outboundPostmark, id: 'fwd', forwarded_message_id: 'in-1', created_at: '2026-09-07T12:50:00Z' }
    expect(selectReplyAnchor([inbound, fwd]).id).toBe('fwd')
  })
  it('returns null for an empty or note-only list', () => {
    expect(selectReplyAnchor([])).toBeNull()
    expect(selectReplyAnchor([note])).toBeNull()
    expect(selectReplyAnchor(null)).toBeNull()
  })
})

describe('anchorMessageId', () => {
  it('brackets a stored rfc id', () => {
    expect(anchorMessageId(inbound)).toBe('<CANz@mail.gmail.com>')
    expect(anchorMessageId({ rfc_message_id: '<already@x>' })).toBe('<already@x>')
  })
  it('derives the mtasv id for a Postmark-sent outbound row', () => {
    expect(anchorMessageId(outboundPostmark)).toBe('<80d4bc38-22a5-4462-b93e-5dd29704d473@mtasv.net>')
  })
  it('prefers the rfc id on an SMTP-sent row', () => {
    expect(anchorMessageId(outboundSmtp)).toBe('<e6c4@un1t.com>')
  })
  it('is null with neither, and never derives mtasv for an inbound row', () => {
    expect(anchorMessageId({ direction: 'outbound' })).toBeNull()
    expect(anchorMessageId({ direction: 'inbound', postmark_message_id: 'pm' })).toBeNull()
  })
})

describe('replyReferences / replyThreadingHeaders', () => {
  it('appends the anchor id to its References chain', () => {
    expect(replyReferences(inbound)).toBe('<80d4@mtasv.net> <CANz@mail.gmail.com>')
  })
  it('falls back to In-Reply-To when the anchor has no References', () => {
    expect(replyReferences({ ...inbound, references_header: null })).toBe('<80d4@mtasv.net> <CANz@mail.gmail.com>')
    expect(replyReferences({ ...inbound, references_header: '', in_reply_to: '80d4@mtasv.net' })).toBe('<80d4@mtasv.net> <CANz@mail.gmail.com>')
  })
  it('is just the anchor id when it has neither', () => {
    expect(replyReferences(outboundPostmark)).toBe('<80d4bc38-22a5-4462-b93e-5dd29704d473@mtasv.net>')
  })
  it('emits both headers, or none when there is no id', () => {
    expect(replyThreadingHeaders(inbound)).toEqual([
      { Name: 'In-Reply-To', Value: '<CANz@mail.gmail.com>' },
      { Name: 'References', Value: '<80d4@mtasv.net> <CANz@mail.gmail.com>' },
    ])
    expect(replyThreadingHeaders({ direction: 'outbound' })).toEqual([])
    expect(replyThreadingHeaders(null)).toEqual([])
  })
})

describe('attributionStamp', () => {
  it('renders Dublin time as "Mon 7 Sep 2026 at 13:34"', () => {
    expect(attributionStamp('2026-09-07T12:34:15Z')).toBe('Mon 7 Sep 2026 at 13:34')
  })
  it('is empty for a missing or unparseable timestamp', () => {
    expect(attributionStamp(null)).toBe('')
    expect(attributionStamp('nope')).toBe('')
  })
})

describe('attributionLine', () => {
  it('names the sender when the inbound address is the requester', () => {
    expect(attributionLine(inbound, { conversation, mailbox }))
      .toBe('On Mon 7 Sep 2026 at 13:34, Richard Ivers <Richard@richardivers.com> wrote:')
  })
  it('uses the bare address for an inbound from someone else', () => {
    expect(attributionLine({ ...inbound, from_email: 'colm@x.ie' }, { conversation, mailbox }))
      .toBe('On Mon 7 Sep 2026 at 13:34, colm@x.ie wrote:')
  })
  it('uses the mailbox label for an outbound from that mailbox', () => {
    expect(attributionLine(outboundPostmark, { conversation, mailbox }))
      .toBe('On Mon 7 Sep 2026 at 13:33, Hatch Street Fitness Accounts <accounts@hatchstreetfitness.com> wrote:')
  })
  it('falls back to the address alone for an outbound with no matching mailbox', () => {
    expect(attributionLine(outboundPostmark, { conversation, mailbox: null }))
      .toBe('On Mon 7 Sep 2026 at 13:33, accounts@hatchstreetfitness.com wrote:')
  })
  it('drops the stamp when there is none', () => {
    expect(attributionLine({ ...inbound, created_at: null, sent_at: null }, { conversation, mailbox }))
      .toBe('Richard Ivers <Richard@richardivers.com> wrote:')
  })
})

describe('quotedTextBlock', () => {
  it('prefixes every line with "> " and cascades an existing quote', () => {
    expect(quotedTextBlock({ text_body: 'a\n\n> b' })).toEqual({ text: '> a\n> \n>> b', truncated: false })
  })
  it('quotes a placeholder for an empty body', () => {
    expect(quotedTextBlock({ text_body: '' })).toEqual({ text: '> (no text content)', truncated: false })
  })
  it('caps at FORWARD_QUOTE_MAX_CHARS and says so', () => {
    const out = quotedTextBlock({ text_body: 'x'.repeat(FORWARD_QUOTE_MAX_CHARS + 5) })
    expect(out.truncated).toBe(true)
    expect(out.text.length).toBeLessThanOrEqual(FORWARD_QUOTE_MAX_CHARS + 2)
  })
})

describe('buildReplyText', () => {
  it('lays out words, signature, attribution, quote', () => {
    const text = buildReplyText({ signedText: 'test test 3\n\n-- \nRichard', anchor: inbound, conversation, mailbox })
    expect(text).toBe(
      'test test 3\n\n-- \nRichard\n\n'
      + 'On Mon 7 Sep 2026 at 13:34, Richard Ivers <Richard@richardivers.com> wrote:\n'
      + '> Test test 2\n>> test',
    )
  })
  it('appends the truncation note unquoted after the quote', () => {
    const text = buildReplyText({ signedText: 'ok', anchor: { ...inbound, text_body: 'y'.repeat(FORWARD_QUOTE_MAX_CHARS + 1) }, conversation, mailbox })
    expect(text.endsWith(`\n\n${FORWARD_TRUNCATED_NOTE}`)).toBe(true)
  })
  it('returns the signed text alone with no anchor', () => {
    expect(buildReplyText({ signedText: 'ok', anchor: null, conversation, mailbox })).toBe('ok')
  })
})

describe('buildReplyHtml', () => {
  it('appends an attribution div and a cite blockquote with escaped text', () => {
    const html = buildReplyHtml({ bodyHtml: '<div>body</div>', anchor: { ...inbound, text_body: '<script>x</script>\n& more' }, conversation, mailbox })
    expect(html.startsWith('<div>body</div>')).toBe(true)
    expect(html).toContain('On Mon 7 Sep 2026 at 13:34, Richard Ivers &lt;Richard@richardivers.com&gt; wrote:')
    expect(html).toContain('<blockquote type="cite"')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;\n&amp; more')
    expect(html).not.toContain('<script>')
  })
  it('returns the body alone with no anchor', () => {
    expect(buildReplyHtml({ bodyHtml: '<div>b</div>', anchor: null, conversation, mailbox })).toBe('<div>b</div>')
  })
})

describe('escapeHtml', () => {
  it('escapes the three characters textToHtml escapes, and quotes', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
  })
})

// EMAIL-FORWARD.1 — the forward's pure rules.
//
// THE BCC BLOCK IS A MUTATION CHECK, NOT A HAPPY PATH, and it is written the
// same way email-recipients.test.js writes its own: the guard is NEGATIVE SPACE
// (a header block that does not name `bcc_emails`), negative space is what a
// test suite normally fails to notice disappearing, so every fixture here
// carries bcc addresses and every assertion is on their ABSENCE.
//
// Two of these tests read SOURCE FILES rather than call functions. That is
// deliberate and it is the strongest check available for a rule of the form
// "this column is never read": a behavioural test only proves the addresses did
// not come out THIS time, while a source scan fails the moment the column is
// named at all — including in a branch no fixture reaches. Same technique as
// email-html.test.js's "no client component imports this module".

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FORWARD_QUOTE_MAX_CHARS,
  FORWARD_SEPARATOR,
  FORWARD_TRUNCATED_NOTE,
  FORWARD_PLAIN_TEXT_NOTE,
  forwardSubject,
  forwardTimestamp,
  forwardedHeaderLines,
  forwardedBody,
  buildForwardText,
  forwardableAttachments,
  forwardBudget,
  selectForwardAttachments,
  defaultForwardSelection,
  forwardSizeError,
  forwardRefusal,
} from './email-forward'
import { MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES } from './email-outbound-attachments'

// Every message fixture in this file carries a Bcc. That is the point.
const BCC = ['secret@example.com', 'auditor@example.com']

const INBOUND = {
  id: 'm1',
  direction: 'inbound',
  from_email: 'ada@example.com',
  to_email: 'studio@un1tdublin.com',
  to_emails: ['studio@un1tdublin.com'],
  cc_emails: ['bob@example.com'],
  bcc_emails: BCC,
  subject: 'Refund for my membership',
  text_body: 'Hi, I was charged twice in July.\nCan you check?',
  html_body: null,
  is_internal_note: false,
  sent_at: null,
  created_at: '2026-08-07T09:30:00Z',
}

describe('forwardSubject', () => {
  it('prefixes exactly once', () => {
    expect(forwardSubject('Refund')).toBe('Fwd: Refund')
  })

  it('does not stack on a subject that is already forwarded, in any client’s spelling', () => {
    for (const already of ['Fwd: Refund', 'FW: Refund', 'Fw: Refund', 'fwd: Refund', '  FWD:  Refund']) {
      expect(forwardSubject(already)).toBe(already.trim())
    }
  })

  // Rewriting someone else's subject loses the thread they recognise.
  it('keeps a Re: rather than rewriting it', () => {
    expect(forwardSubject('Re: Refund')).toBe('Fwd: Re: Refund')
  })

  it('has a stand-in for an empty subject', () => {
    expect(forwardSubject('')).toBe('Fwd: (no subject)')
    expect(forwardSubject(null)).toBe('Fwd: (no subject)')
  })
})

describe('forwardTimestamp', () => {
  // A bare toLocaleString() renders in whatever zone the server runs in, so a
  // 09:30 Dublin email would be forwarded as 08:30 all summer.
  it('renders in Europe/Dublin whatever zone the process is in', () => {
    const out = forwardTimestamp('2026-08-07T09:30:00Z')
    // 09:30 UTC in August is 10:30 in Dublin (IST).
    expect(out).toContain('10:30')
    expect(out).toContain('2026')
  })

  it('is empty for a missing or unparseable timestamp, so the line is omitted', () => {
    expect(forwardTimestamp(null)).toBe('')
    expect(forwardTimestamp('not a date')).toBe('')
  })
})

// ══ THE MUTATION CHECK ═══════════════════════════════════════════════
describe('the quoted header block NEVER contains a bcc', () => {
  it('produces exactly the five headers a forward reproduces', () => {
    const labels = forwardedHeaderLines(INBOUND).map(l => l.label)
    expect(labels).toEqual(['From', 'Date', 'Subject', 'To', 'Cc'])
  })

  it('has no line whose label mentions bcc, however it is spelled', () => {
    for (const line of forwardedHeaderLines(INBOUND)) {
      expect(line.label).not.toMatch(/bcc/i)
    }
  })

  it('omits every bcc address from the header lines', () => {
    const rendered = forwardedHeaderLines(INBOUND).map(l => `${l.label}: ${l.value}`).join('\n')
    for (const address of BCC) expect(rendered).not.toContain(address)
  })

  // The one that catches a "helpfully" merged implementation: a bcc address
  // that is ALSO the only other plausible header value must still not appear.
  it('omits a bcc address even when To and Cc are both empty', () => {
    const bccOnly = { ...INBOUND, to_email: null, to_emails: [], cc_emails: [] }
    const rendered = forwardedHeaderLines(bccOnly).map(l => l.value).join(' ')
    for (const address of BCC) expect(rendered).not.toContain(address)
    expect(forwardedHeaderLines(bccOnly).map(l => l.label)).toEqual(['From', 'Date', 'Subject'])
  })

  it('omits every bcc address from the WHOLE forwarded body, not just the headers', () => {
    const body = buildForwardText({ note: 'Passing this to you', message: INBOUND })
    for (const address of BCC) expect(body).not.toContain(address)
  })

  // A forward of an OUTBOUND message is the dangerous direction: that is the
  // message whose bcc_emails WE wrote, and it is the one an operator is most
  // likely to forward to a third party.
  it('omits our own bcc when forwarding a message we sent', () => {
    const outbound = {
      ...INBOUND,
      direction: 'outbound',
      from_email: 'studio@un1tdublin.com',
      to_emails: ['ada@example.com'],
      cc_emails: [],
      bcc_emails: ['manager@un1tdublin.com', 'legal@example.com'],
      text_body: 'We have refunded the duplicate charge.',
    }
    const body = buildForwardText({ note: '', message: outbound })
    expect(body).not.toContain('manager@un1tdublin.com')
    expect(body).not.toContain('legal@example.com')
    expect(body).toContain('ada@example.com')
  })

  // THE SOURCE SCAN. A behavioural test only proves these fixtures did not leak;
  // this fails the moment the column is NAMED, including on a path no fixture
  // reaches.
  it('email-forward.js does not name bcc_emails anywhere', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/email-forward.js'), 'utf8')
    // The word appears in prose in the header comment, which is fine and
    // deliberate — what must not exist is a read of the property.
    const code = source.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code).not.toMatch(/bcc/i)
  })

  // The route is the other half: even a perfect pure function leaks if the
  // handler fetches the column and hands it to something else.
  //
  // The route DOES write bcc_emails — the forward's OWN blind copies, typed by
  // the operator, onto the forward's own row, exactly as the reply route does.
  // What it must never do is READ the column off the message being quoted. So
  // the assertion is that the string appears EXACTLY ONCE and in that one
  // shape: adding a read adds an occurrence, and changing the write to derive
  // from stored correspondence changes the shape.
  it('the forward route mentions bcc_emails exactly once, and only to WRITE its own', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/app/api/email/tickets/[id]/forward/route.js'),
      'utf8',
    )
    const code = source.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code.match(/bcc_emails/g) || []).toHaveLength(1)
    expect(code).toContain('bcc_emails: recipients.bcc')
  })

  // The columns the quoted header block is built FROM. A column that is never
  // fetched cannot be reproduced by any amount of carelessness downstream.
  it('the forward route does not fetch bcc_emails off the message it quotes', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/app/api/email/tickets/[id]/forward/route.js'),
      'utf8',
    )
    const block = source.match(/const SOURCE_COLUMNS = \[([\s\S]*?)\]/)
    expect(block).toBeTruthy()
    expect(block[1]).not.toMatch(/bcc/i)
    // …and it really is the list the source message is read with.
    expect(source).toContain('.select(SOURCE_COLUMNS)')
  })

  it('the forward’s attachment IO never touches a recipient column', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/email-forward-server.js'), 'utf8')
    const code = source.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code).not.toMatch(/bcc/i)
  })
})

describe('forwardedBody', () => {
  it('is the stored plain text, normalised', () => {
    expect(forwardedBody(INBOUND)).toEqual({
      text: 'Hi, I was charged twice in July.\nCan you check?',
      truncated: false,
    })
  })

  it('bounds a very long body and says it did', () => {
    const long = { ...INBOUND, text_body: 'x'.repeat(FORWARD_QUOTE_MAX_CHARS + 500) }
    const out = forwardedBody(long)
    expect(out.truncated).toBe(true)
    expect(out.text.length).toBeLessThanOrEqual(FORWARD_QUOTE_MAX_CHARS)
  })

  it('never reaches for html_body', () => {
    const htmlOnly = { ...INBOUND, text_body: '', html_body: '<p>hello <script>alert(1)</script></p>' }
    expect(forwardedBody(htmlOnly).text).toBe('')
  })
})

describe('buildForwardText', () => {
  it('puts the operator’s note first, then the separator, then the headers, then the body', () => {
    const out = buildForwardText({ note: 'Sarah — can you look at this?', message: INBOUND })
    const noteAt = out.indexOf('Sarah — can you look at this?')
    const sepAt = out.indexOf(FORWARD_SEPARATOR)
    const fromAt = out.indexOf('From: ada@example.com')
    const bodyAt = out.indexOf('I was charged twice')
    expect(noteAt).toBeGreaterThanOrEqual(0)
    expect(sepAt).toBeGreaterThan(noteAt)
    expect(fromAt).toBeGreaterThan(sepAt)
    expect(bodyAt).toBeGreaterThan(fromAt)
  })

  it('works with no note at all', () => {
    const out = buildForwardText({ message: INBOUND })
    expect(out.startsWith(FORWARD_SEPARATOR)).toBe(true)
  })

  it('says so when the original was formatted HTML', () => {
    const withHtml = { ...INBOUND, html_body: '<p>Hi</p>' }
    expect(buildForwardText({ message: withHtml })).toContain(FORWARD_PLAIN_TEXT_NOTE)
    expect(buildForwardText({ message: INBOUND })).not.toContain(FORWARD_PLAIN_TEXT_NOTE)
  })

  it('marks a truncated quote in the mail itself', () => {
    const long = { ...INBOUND, text_body: 'x'.repeat(FORWARD_QUOTE_MAX_CHARS + 1) }
    expect(buildForwardText({ message: long })).toContain(FORWARD_TRUNCATED_NOTE)
  })

  it('never emits a stranger’s markup as markup', () => {
    const hostile = {
      ...INBOUND,
      text_body: '<script>alert(1)</script> plain words',
      html_body: '<img src=x onerror=alert(1)>',
    }
    const out = buildForwardText({ message: hostile })
    // The text is quoted verbatim (it is TEXT — the route escapes it before it
    // becomes HTML), but nothing from html_body is anywhere in the output.
    expect(out).toContain('plain words')
    expect(out).not.toContain('onerror')
  })

  it('has a stand-in for a message with no text at all', () => {
    expect(buildForwardText({ message: { ...INBOUND, text_body: null } }))
      .toContain('(no text content)')
  })
})

describe('forwardableAttachments', () => {
  const rows = [
    { id: 'a', filename: 'invoice.pdf', storage_path: 'loc/msg/0.pdf', size_bytes: 1000 },
    { id: 'b', filename: 'huge.zip', storage_path: null, skipped_reason: 'too_large', size_bytes: 40_000_000 },
    { id: 'c', filename: 'old.pdf', storage_path: null, skipped_reason: 'pruned', size_bytes: 2000 },
  ]

  // A row with no bytes must never be offered — a checkbox for it would promise
  // a file that cannot be sent.
  it('drops every row with no bytes, whatever the reason', () => {
    expect(forwardableAttachments(rows).map(r => r.id)).toEqual(['a'])
  })

  // The browser never sees storage_path (the bucket is private and the path is
  // signed server-side only), so the composer asks the same question through
  // the `stored` boolean the detail route computes from it.
  it('answers the same question off the client-side `stored` flag', () => {
    const clientShape = [
      { id: 'a', filename: 'invoice.pdf', stored: true, size_bytes: 1000 },
      { id: 'b', filename: 'gone.pdf', stored: false, skipped_reason: 'pruned', size_bytes: 2000 },
    ]
    expect(forwardableAttachments(clientShape).map(r => r.id)).toEqual(['a'])
  })

  it('never throws on junk', () => {
    expect(forwardableAttachments(null)).toEqual([])
    expect(forwardableAttachments([null, undefined])).toEqual([])
  })
})

describe('forwardBudget / defaultForwardSelection', () => {
  const small = [{ id: 'a', size_bytes: 1_000 }, { id: 'b', size_bytes: 2_000 }]
  const huge = [{ id: 'a', size_bytes: MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES }, { id: 'b', size_bytes: 1 }]

  it('adds the stored sizes up against the outbound ceiling', () => {
    expect(forwardBudget(small)).toMatchObject({ used: 3_000, over: false })
    expect(forwardBudget(huge).over).toBe(true)
  })

  it('pre-ticks everything when everything fits', () => {
    expect(defaultForwardSelection(small)).toEqual(['a', 'b'])
  })

  // A greedy subset would be a set of files the operator did not decide to
  // leave out — the silent drop this feature exists to avoid.
  it('pre-ticks NOTHING when the set does not fit, rather than choosing for them', () => {
    expect(defaultForwardSelection(huge)).toEqual([])
  })
})

describe('selectForwardAttachments', () => {
  const rows = [
    { id: 'a', filename: 'one.pdf', storage_path: 'p/0.pdf', size_bytes: 10 },
    { id: 'b', filename: 'two.pdf', storage_path: 'p/1.pdf', size_bytes: 20 },
    { id: 'c', filename: 'gone.pdf', storage_path: null, skipped_reason: 'quota', size_bytes: 30 },
  ]

  it('returns nothing for an empty choice', () => {
    expect(selectForwardAttachments(rows, [])).toEqual({ ok: true, rows: [] })
    expect(selectForwardAttachments(rows, undefined)).toEqual({ ok: true, rows: [] })
  })

  it('keeps the ORIGINAL’s order, not the order the ids arrived in', () => {
    const out = selectForwardAttachments(rows, ['b', 'a'])
    expect(out.ok).toBe(true)
    expect(out.rows.map(r => r.id)).toEqual(['a', 'b'])
  })

  it('dedupes a repeated id', () => {
    const out = selectForwardAttachments(rows, ['a', 'a'])
    expect(out.rows.map(r => r.id)).toEqual(['a'])
  })

  // Dropping it silently would send a forward missing a file the operator
  // ticked, and they would never learn.
  it('REFUSES an id that is not on this message', () => {
    const out = selectForwardAttachments(rows, ['a', 'not-mine'])
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/nothing was sent/i)
  })

  it('REFUSES a file whose bytes were never stored, and names it', () => {
    const out = selectForwardAttachments(rows, ['c'])
    expect(out.ok).toBe(false)
    expect(out.error).toContain('gone.pdf')
  })
})

describe('forwardSizeError', () => {
  it('names what they have AND the limit, so it is not retried unchanged', () => {
    const msg = forwardSizeError(9_000_000)
    expect(msg).toContain('8.6 MB')
    expect(msg).toContain('7.0 MB')
    expect(msg).toMatch(/nothing was sent/i)
    // The remedy differs from the reply composer's: there you remove a file you
    // attached, here you untick one of theirs.
    expect(msg).toMatch(/untick/i)
  })
})

describe('forwardRefusal — an internal note is not mail', () => {
  it('refuses an internal note', () => {
    const refusal = forwardRefusal({ ...INBOUND, is_internal_note: true })
    expect(refusal).toMatch(/internal note/i)
    expect(refusal).toMatch(/cannot be forwarded/i)
  })

  it('allows an ordinary inbound or outbound message', () => {
    expect(forwardRefusal(INBOUND)).toBeNull()
    expect(forwardRefusal({ ...INBOUND, direction: 'outbound' })).toBeNull()
  })

  it('refuses a message that is not there', () => {
    expect(forwardRefusal(null)).toMatch(/not on this ticket/i)
  })
})

// IMAP-CONN.3.3 — the mapper's test suite.
//
// This is the file that has to be thorough. The mapper is pure and the whole
// pipeline behind it is inherited from the Postmark webhook, so if the payload
// is right the feature is right — and if the payload is subtly wrong, the
// symptom is a member's email filed against the wrong studio, or a reply that
// opens a second ticket, and nothing errors anywhere.
//
// Every fixture below is shaped the way imapflow really returns things:
// envelope addresses as { name, address } objects, envelope.date as a Date,
// and msg.headers as a Buffer of raw header lines (FetchMessageObject.headers
// is a Buffer, NOT a parsed object — that is exactly why parseHeaderBlock
// exists).

import { describe, it, expect } from 'vitest'
import { syntheticMessageId, toInboundPayload, SYNTHETIC_ID_RE } from './imap-message'
import { recipientEmails, senderEmail, getHeader, extractRfcMessageId, extractCandidateMessageIds, parseEmailDate } from '../email-inbox'
import { resolveMailboxByRecipient } from '../email-mailboxes'

const MAILBOX_ID = '9b1c1f2e-4d5a-4a19-9f0e-2c7f6a1b3d44'
const MAILBOX_ADDRESS = 'hatchstreet@un1t.com'

/** Raw header lines as imapflow hands them over: a Buffer, CRLF-delimited. */
const headerBuffer = (lines) => Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'utf8')

/** A minimal but realistic fetched message. */
function fixture(overrides = {}) {
  const { envelope, ...rest } = overrides
  return {
    uid: 4321,
    envelope: {
      date: new Date('2026-08-26T09:15:00.000Z'),
      subject: 'Trial class question',
      messageId: '<CAF=abc123@mail.gmail.com>',
      from: [{ name: 'Ada Member', address: 'ada@example.com' }],
      to: [{ name: null, address: MAILBOX_ADDRESS }],
      ...envelope,
    },
    internalDate: new Date('2026-08-26T09:15:30.000Z'),
    headers: headerBuffer(['Message-ID: <CAF=abc123@mail.gmail.com>']),
    text: 'Hi, is there a class on Saturday?',
    ...rest,
  }
}

const map = (msg, opts = {}) =>
  toInboundPayload(msg, { mailboxAddress: MAILBOX_ADDRESS, mailboxId: MAILBOX_ID, ...opts })

/* ───────────────────────────── syntheticMessageId ──────────────────────── */

describe('syntheticMessageId', () => {
  it('is `imap-<8 hex of mailboxId>-<40 hex digest>`', () => {
    const id = syntheticMessageId(MAILBOX_ID, 'CAF=abc123@mail.gmail.com')
    // MAILBOX_ID starts 9b1c1f2e — the mailbox stays greppable in the clear.
    expect(id).toMatch(/^imap-9b1c1f2e-[0-9a-f]{40}$/)
    expect(id).toHaveLength(54)
  })

  it('🔴 ALWAYS matches PATH_SEGMENT — it is a Storage object path segment', () => {
    // THE ASSERTION WHOSE ABSENCE LET THE FIRST CUT SHIP BROKEN. The route
    // hands body.MessageID on as `postmarkMessageId`, which becomes
    // `inbound/<postmark_message_id>/<n>.<ext>`; stagedAttachmentPath() /
    // stagedPathMatches() (src/lib/email-attachment-staging.js:81) validate
    // that segment against /^[A-Za-z0-9_-]{1,64}$/. The originally-pinned
    // `imap:<uuid>:<rfc-id>` form failed on the colons, the `@`, the dots AND
    // the length, so every IMAP attachment would have read back as
    // rehost_failed with its bytes orphaned in a metered bucket.
    const nasty = [
      'CAF=abc123@mail.gmail.com',
      '<already.bracketed@x.com>',
      'weird/slash..dots@x.com',
      'спам@пример.рф',
      'x'.repeat(400),
      'a b\tc',
      '../../etc/passwd',
    ]
    for (const rfc of nasty) {
      const id = syntheticMessageId(MAILBOX_ID, rfc)
      expect(id).toMatch(SYNTHETIC_ID_RE)
      expect(id.length).toBeLessThanOrEqual(64)
    }
    // And with a mailboxId that is not a uuid at all.
    expect(syntheticMessageId('not-a-uuid!!', 'x@y.com')).toMatch(SYNTHETIC_ID_RE)
  })

  it('is DETERMINISTIC — the same message on a re-poll produces the same id', () => {
    // Dedupe rests entirely on this: the unique partial index on
    // email_inbox_messages.postmark_message_id is the completion marker.
    expect(syntheticMessageId(MAILBOX_ID, 'CAF=abc123@mail.gmail.com'))
      .toBe(syntheticMessageId(MAILBOX_ID, 'CAF=abc123@mail.gmail.com'))
  })

  it('two different messages in one mailbox get different ids', () => {
    expect(syntheticMessageId(MAILBOX_ID, 'a@x.com'))
      .not.toBe(syntheticMessageId(MAILBOX_ID, 'b@x.com'))
  })

  it('cannot collide with a real Postmark MessageID', () => {
    // Postmark ids are lowercase-hex uuids. `i`, `m` and `p` are not hex
    // digits, so the `imap-` prefix makes a collision structurally impossible
    // — a Postmark delivery webhook can never correlate against an IMAP row.
    const id = syntheticMessageId(MAILBOX_ID, 'x@y.com')
    expect(id.startsWith('imap-')).toBe(true)
    expect(id).not.toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('namespaces per mailbox, so two mailboxes copied on one email get two tickets', () => {
    const a = syntheticMessageId('mailbox-a', 'same@id.com')
    const b = syntheticMessageId('mailbox-b', 'same@id.com')
    expect(a).not.toBe(b)
  })

  it('the digest covers the FULL mailboxId, not just the visible prefix', () => {
    // Two mailboxes sharing the first 8 hex characters must still differ —
    // uniqueness must not rest on the truncated, human-facing part.
    const a = syntheticMessageId('9b1c1f2e-0000-0000-0000-000000000001', 'x@y.com')
    const b = syntheticMessageId('9b1c1f2e-0000-0000-0000-000000000002', 'x@y.com')
    expect(a.slice(0, 14)).toBe(b.slice(0, 14))
    expect(a).not.toBe(b)
  })

  it('is unambiguous about where the mailbox ends and the message begins', () => {
    // The separator in the preimage: without it ('ab' + 'c') and ('a' + 'bc')
    // would digest identically.
    expect(syntheticMessageId('ab', 'c')).not.toBe(syntheticMessageId('a', 'bc'))
  })

  it('is null rather than a guess when either half is missing', () => {
    expect(syntheticMessageId(MAILBOX_ID, '')).toBeNull()
    expect(syntheticMessageId(MAILBOX_ID, null)).toBeNull()
    expect(syntheticMessageId('', 'x@y.com')).toBeNull()
    expect(syntheticMessageId(null, null)).toBeNull()
  })
})

/* ───────────────────────────────── routing ─────────────────────────────── */

describe('toInboundPayload — OriginalRecipient (the field that routes the mail)', () => {
  it('sets OriginalRecipient to the connected mailbox address', () => {
    expect(map(fixture()).OriginalRecipient).toBe(MAILBOX_ADDRESS)
  })

  it('files the mail against the connected mailbox with ZERO route changes', () => {
    // The end-to-end proof of §3.1, run through the REAL route helpers rather
    // than a restatement of them: recipientEmails() collects OriginalRecipient
    // and resolveMailboxByRecipient() matches it.
    const mailboxes = [
      { id: MAILBOX_ID, location_id: 'loc-hatch', address: MAILBOX_ADDRESS, active: true },
      { id: 'other', location_id: 'loc-still', address: 'stillorgan@un1t.com', active: true },
    ]
    // Envelope To is a mailing list — nothing of ours in the visible headers.
    const payload = map(fixture({
      envelope: { to: [{ name: null, address: 'members-list@example.com' }] },
    }))
    const resolved = resolveMailboxByRecipient(mailboxes, recipientEmails(payload))
    expect(resolved.id).toBe(MAILBOX_ID)
  })

  it('⚠️ pins the documented precedence: a To: naming ANOTHER of our mailboxes wins', () => {
    // §3.1's known sharp edge, pinned rather than discovered in production.
    // recipientEmails' order is ToFull → CcFull → To → OriginalRecipient, so a
    // message addressed to stillorgan@ but DELIVERED to hatchstreet@ files
    // into Stillorgan. That is the existing route's behaviour and the mapper
    // does not fight it — it emits the truth of the headers.
    const mailboxes = [
      { id: MAILBOX_ID, location_id: 'loc-hatch', address: MAILBOX_ADDRESS, active: true },
      { id: 'still', location_id: 'loc-still', address: 'stillorgan@un1t.com', active: true },
    ]
    const payload = map(fixture({
      envelope: { to: [{ name: null, address: 'stillorgan@un1t.com' }] },
    }))
    expect(resolveMailboxByRecipient(mailboxes, recipientEmails(payload)).id).toBe('still')
  })
})

/* ────────────────────────────── From / FromFull ────────────────────────── */

describe('toInboundPayload — From', () => {
  it('renders the display form and the typed pair from an envelope address', () => {
    const p = map(fixture())
    expect(p.From).toBe('Ada Member <ada@example.com>')
    expect(p.FromFull).toEqual({ Email: 'ada@example.com', Name: 'Ada Member' })
  })

  it('accepts a raw display-form address string ("Ada <a@b.com>")', () => {
    const p = map(fixture({ envelope: { from: ['Ada <a@b.com>'] } }))
    expect(p.From).toBe('Ada <a@b.com>')
    expect(p.FromFull).toEqual({ Email: 'a@b.com', Name: 'Ada' })
    expect(senderEmail(p)).toBe('a@b.com')
  })

  it('accepts a quoted display-form address', () => {
    const p = map(fixture({ envelope: { from: ['"Smith, John" <j@x.com>'] } }))
    expect(p.FromFull).toEqual({ Email: 'j@x.com', Name: 'Smith, John' })
    // …and re-quotes it on the way out, so the route's comma-split on the
    // display string cannot cut the name in half.
    expect(p.From).toBe('"Smith, John" <j@x.com>')
  })

  it('recovers an address stranded in the name field', () => {
    // Some servers answer a malformed From with the whole display string in
    // `name` and no `address`. Dropping it would dead-letter a message whose
    // sender is sitting in plain sight — the lesson senderEmail() learned.
    const p = map(fixture({ envelope: { from: [{ name: 'Ada <ada@example.com>', address: '' }] } }))
    expect(p.FromFull.Email).toBe('ada@example.com')
    expect(senderEmail(p)).toBe('ada@example.com')
  })

  it('keeps a bare address with no display name', () => {
    const p = map(fixture({ envelope: { from: [{ address: 'bare@example.com' }] } }))
    expect(p.From).toBe('bare@example.com')
    expect(p.FromFull).toEqual({ Email: 'bare@example.com', Name: null })
  })

  it('survives a message with no From at all — the route dead-letters it', () => {
    const p = map(fixture({ envelope: { from: [] } }))
    expect(p.FromFull).toEqual({ Email: '', Name: null })
    // senderEmail() returns null → the route's `no_sender` dead-letter door.
    expect(senderEmail(p)).toBeNull()
  })

  it('carries a + tag through untouched', () => {
    // Sub-addressing is legal and common (and normalizeEmail keeps it), so the
    // mapper must not "clean" it — stripping the tag would merge two distinct
    // senders onto one contact.
    const p = map(fixture({ envelope: { from: [{ name: 'Ada', address: 'ada+gym@example.com' }] } }))
    expect(p.FromFull.Email).toBe('ada+gym@example.com')
    expect(senderEmail(p)).toBe('ada+gym@example.com')
  })
})

/* ───────────────────────────────── To / Cc ─────────────────────────────── */

describe('toInboundPayload — To and Cc', () => {
  it('carries multiple To recipients as both typed and display forms', () => {
    const p = map(fixture({
      envelope: {
        to: [
          { name: 'Hatch Street', address: MAILBOX_ADDRESS },
          { name: null, address: 'coach@example.com' },
        ],
      },
    }))
    expect(p.ToFull).toEqual([
      { Email: MAILBOX_ADDRESS, Name: 'Hatch Street' },
      { Email: 'coach@example.com', Name: null },
    ])
    expect(p.To).toBe(`Hatch Street <${MAILBOX_ADDRESS}>, coach@example.com`)
  })

  it('carries multiple Cc recipients', () => {
    const p = map(fixture({
      envelope: {
        cc: [
          { name: 'Head Office', address: 'ho@example.com' },
          { name: null, address: 'accounts+billing@example.com' },
        ],
      },
    }))
    expect(p.CcFull).toEqual([
      { Email: 'ho@example.com', Name: 'Head Office' },
      { Email: 'accounts+billing@example.com', Name: null },
    ])
  })

  it('collects every To and Cc through the route’s own recipientEmails()', () => {
    const p = map(fixture({
      envelope: {
        to: [{ name: null, address: MAILBOX_ADDRESS }, { name: null, address: 'coach@example.com' }],
        cc: [{ name: null, address: 'ho@example.com' }],
      },
    }))
    expect(recipientEmails(p)).toEqual([MAILBOX_ADDRESS, 'coach@example.com', 'ho@example.com'])
  })

  it('emits empty To/ToFull/CcFull for an envelope-only (Bcc) delivery', () => {
    const p = map(fixture({ envelope: { to: undefined, cc: undefined } }))
    expect(p.To).toBe('')
    expect(p.ToFull).toEqual([])
    expect(p.CcFull).toEqual([])
    // OriginalRecipient is then the ONLY thing that routes it — which is
    // precisely why it is set unconditionally.
    expect(recipientEmails(p)).toEqual([MAILBOX_ADDRESS])
  })
})

/* ─────────────────────────────── threading ─────────────────────────────── */

describe('toInboundPayload — Headers (threading)', () => {
  it('emits Message-ID, In-Reply-To and References as {Name, Value}', () => {
    const p = map(fixture({
      headers: headerBuffer([
        'Message-ID: <child@mail.gmail.com>',
        'In-Reply-To: <parent@mtasv.net>',
        'References: <root@mtasv.net> <parent@mtasv.net>',
      ]),
    }))
    expect(p.Headers).toEqual([
      { Name: 'Message-ID', Value: '<child@mail.gmail.com>' },
      { Name: 'In-Reply-To', Value: '<parent@mtasv.net>' },
      { Name: 'References', Value: '<root@mtasv.net> <parent@mtasv.net>' },
    ])
  })

  it('threads onto one of our sends through the route’s own resolver', () => {
    // The end-to-end proof: extractCandidateMessageIds() is what the route
    // matches against email_sends.postmark_message_id, and Postmark's outbound
    // RFC id embeds its API MessageID as the local part — so the bare uuid has
    // to come out of our Headers array.
    const p = map(fixture({
      headers: headerBuffer([
        'Message-ID: <child@mail.gmail.com>',
        'In-Reply-To: <7c9f1f6a-1111-2222-3333-444455556666@mtasv.net>',
        'References: <7c9f1f6a-1111-2222-3333-444455556666@mtasv.net>',
      ]),
    }))
    expect(extractCandidateMessageIds(p.Headers))
      .toContain('7c9f1f6a-1111-2222-3333-444455556666')
  })

  it('unfolds a References header split across lines', () => {
    // 🔴 The regression that would thread shallow replies and silently fail
    // deep ones: References is routinely folded, and only the LAST id in it is
    // usually ours.
    const p = map(fixture({
      headers: headerBuffer([
        'Message-ID: <child@x.com>',
        'References: <a@mtasv.net>',
        '\t<b@mtasv.net>',
        ' <c@mtasv.net>',
      ]),
    }))
    expect(getHeader(p.Headers, 'References'))
      .toBe('<a@mtasv.net> <b@mtasv.net> <c@mtasv.net>')
    expect(extractCandidateMessageIds(p.Headers)).toContain('c@mtasv.net')
  })

  it('falls back to the envelope for Message-ID and In-Reply-To when headers are absent', () => {
    // imapflow's ENVELOPE carries both; only References is envelope-less.
    const p = map(fixture({
      headers: undefined,
      envelope: { messageId: '<env@x.com>', inReplyTo: '<envparent@x.com>' },
    }))
    expect(getHeader(p.Headers, 'Message-ID')).toBe('<env@x.com>')
    expect(getHeader(p.Headers, 'In-Reply-To')).toBe('<envparent@x.com>')
    expect(getHeader(p.Headers, 'References')).toBeNull()
  })

  it('OMITS a missing References rather than emitting an empty one', () => {
    // An empty header value would be stored as '' in
    // email_inbox_messages.references_header, and '' is a claim where NULL is
    // the truth.
    const p = map(fixture())
    expect(p.Headers.some(h => h.Name === 'References')).toBe(false)
    expect(getHeader(p.Headers, 'References')).toBeNull()
  })

  it('OMITS a missing Message-ID rather than fabricating one', () => {
    // A fabricated rfc_message_id is what a later reply's In-Reply-To would
    // have to match — and no mail client has ever seen it. Absent is honest.
    const p = map(fixture({ headers: undefined, envelope: { messageId: undefined } }))
    expect(p.Headers).toEqual([])
    expect(extractRfcMessageId(p.Headers)).toBeNull()
  })

  it('accepts a plain string header block and an already-parsed array', () => {
    const asString = map(fixture({ headers: 'Message-ID: <s@x.com>\r\nReferences: <r@x.com>\r\n' }))
    expect(getHeader(asString.Headers, 'References')).toBe('<r@x.com>')

    const asArray = map(fixture({ headers: [{ Name: 'References', Value: '<r@x.com>' }] }))
    expect(getHeader(asArray.Headers, 'References')).toBe('<r@x.com>')
  })
})

/* ──────────────────────────── the dedupe key ───────────────────────────── */

describe('toInboundPayload — MessageID', () => {
  it('seeds the id with the RFC Message-ID, brackets stripped', () => {
    // Asserted THROUGH syntheticMessageId rather than against a literal digest:
    // the point under test is which SEED the mapper chose, and pinning a hash
    // here would only pin the hash.
    expect(map(fixture()).MessageID).toBe(syntheticMessageId(MAILBOX_ID, 'CAF=abc123@mail.gmail.com'))
    expect(map(fixture()).MessageID).toMatch(SYNTHETIC_ID_RE)
  })

  it('is stable across re-polls of the same message', () => {
    const a = map(fixture()).MessageID
    const b = map(fixture({ uid: 4321 })).MessageID
    expect(a).toBe(b)
  })

  it('falls back to a UID+date surrogate when the message has NO Message-ID', () => {
    const p = map(fixture({ headers: undefined, envelope: { messageId: undefined } }))
    expect(p.MessageID)
      .toBe(syntheticMessageId(MAILBOX_ID, 'no-message-id.uid-4321.2026-08-26T09:15:00.000Z'))
  })

  it('the surrogate binds the DATE as well as the UID', () => {
    // 🔴 UID alone is not stable enough. A UIDVALIDITY change re-anchors and
    // starts a fresh UID space from 1 (§3.3), so a NEW message can take a UID
    // an already-ingested message once held. Dedupe would then swallow it —
    // silent mail loss. Same uid, different message ⇒ different key.
    const first = map(fixture({ headers: undefined, envelope: { messageId: undefined } }))
    const laterReuseOfTheSameUid = map(fixture({
      headers: undefined,
      envelope: { messageId: undefined, date: new Date('2027-01-04T11:00:00.000Z') },
    }))
    expect(first.MessageID).not.toBe(laterReuseOfTheSameUid.MessageID)
  })

  it('uses internalDate in the surrogate when the message has no Date either', () => {
    const p = map(fixture({
      headers: undefined,
      envelope: { messageId: undefined, date: undefined },
    }))
    expect(p.MessageID)
      .toBe(syntheticMessageId(MAILBOX_ID, 'no-message-id.uid-4321.2026-08-26T09:15:30.000Z'))
  })

  it('is null when there is neither a Message-ID nor a usable UID', () => {
    // The route answers 400 for a falsy MessageID; the poller isolates the
    // message. Honest — without a stable id there is nothing to dedupe on.
    const p = map(fixture({ uid: 0, headers: undefined, envelope: { messageId: undefined } }))
    expect(p.MessageID).toBeNull()
  })

  it('strips a NUL out of the RFC Message-ID rather than letting it stall the mailbox', () => {
    // The route does NOT sanitise body.MessageID — it goes straight into
    // dedupeEventId() and the postmark_message_id column. A NUL there fails
    // the INSERT on every attempt, the route 5xxes forever, and the poller's
    // watermark never advances past it: one junk message stalls the mailbox.
    const p = map(fixture({ headers: headerBuffer(['Message-ID: <ab\u0000cd@x.com>']) }))
    expect(p.MessageID).toBe(syntheticMessageId(MAILBOX_ID, 'abcd@x.com'))
  })

  it('drops embedded whitespace and CR/LF from the RFC Message-ID', () => {
    // A folded or space-bearing id would otherwise be stored verbatim and
    // never match the same message again on a re-poll.
    const p = map(fixture({ headers: headerBuffer(['Message-ID: <ab cd@x.com>']) }))
    expect(p.MessageID).toBe(syntheticMessageId(MAILBOX_ID, 'abcd@x.com'))
  })

  it('drops a lone surrogate out of the RFC Message-ID', () => {
    // Taken off the ENVELOPE, not off a Buffer: Node's utf8 decoder already
    // replaces a lone surrogate with U+FFFD on the Buffer path, so the only
    // route by which one can reach here is a JS string — envelope.messageId
    // (imapflow decodes MIME words into one) or a pre-parsed header array.
    // Unstripped it would fail the INSERT deterministically and stall the
    // mailbox, exactly like a NUL.
    const p = map(fixture({ headers: undefined, envelope: { messageId: '<a\ud800b@x.com>' } }))
    expect(p.MessageID).toBe(syntheticMessageId(MAILBOX_ID, 'ab@x.com'))
    expect(getHeader(p.Headers, 'Message-ID')).toBe('<ab@x.com>')
  })

  it('caps an absurdly long Message-ID before it reaches a stored column', () => {
    // The digest makes the MessageID fixed-width whatever arrives, but the raw
    // id also rides into email_inbox_messages.rfc_message_id via the Headers
    // array and is re-read on every render of the ticket. Bound it.
    const long = 'x'.repeat(5000)
    const p = map(fixture({ headers: headerBuffer([`Message-ID: <${long}@x.com>`]) }))
    expect(p.MessageID).toBe(syntheticMessageId(MAILBOX_ID, 'x'.repeat(400)))
    expect(p.MessageID).toMatch(SYNTHETIC_ID_RE)
    expect(getHeader(p.Headers, 'Message-ID')).toBe(`<${'x'.repeat(400)}>`)
  })
})

/* ───────────────────────── subject, bodies, date ───────────────────────── */

describe('toInboundPayload — Subject', () => {
  it('passes a charset-decoded subject through verbatim', () => {
    // imapflow decodes MIME encoded-words itself (lib/charsets.js), so what
    // arrives on envelope.subject is already unicode. The mapper's job is to
    // NOT touch it.
    const p = map(fixture({ envelope: { subject: 'Grüße aus München — 5€ Angebot 日本語' } }))
    expect(p.Subject).toBe('Grüße aus München — 5€ Angebot 日本語')
  })

  it('does not re-decode: a literal "=?" in a subject survives', () => {
    // Running our own encoded-word decoder here could only corrupt a subject
    // that legitimately contains the sequence. Pinned so nobody adds one.
    const raw = 'Is =?UTF-8?B?...?= a valid header?'
    expect(map(fixture({ envelope: { subject: raw } })).Subject).toBe(raw)
  })

  it('emits an empty string for a subjectless message', () => {
    expect(map(fixture({ envelope: { subject: undefined } })).Subject).toBe('')
  })
})

describe('toInboundPayload — bodies', () => {
  it('text-only: TextBody set, HtmlBody null', () => {
    const p = map(fixture({ text: 'plain words', html: undefined }))
    expect(p.TextBody).toBe('plain words')
    expect(p.HtmlBody).toBeNull()
  })

  it('html-only: HtmlBody set, TextBody empty (the route derives plain text)', () => {
    const p = map(fixture({ text: undefined, html: '<p>rich words</p>' }))
    expect(p.TextBody).toBe('')
    expect(p.HtmlBody).toBe('<p>rich words</p>')
  })

  it('both: both carried, neither preferred', () => {
    const p = map(fixture({ text: 'plain', html: '<p>rich</p>' }))
    expect(p.TextBody).toBe('plain')
    expect(p.HtmlBody).toBe('<p>rich</p>')
  })

  it('accepts the Postmark spelling (textBody / htmlBody) as well', () => {
    const p = map(fixture({ text: undefined, textBody: 'plain', htmlBody: '<p>rich</p>' }))
    expect(p.TextBody).toBe('plain')
    expect(p.HtmlBody).toBe('<p>rich</p>')
  })

  it('a bodyless message is empty, not undefined', () => {
    const p = map(fixture({ text: undefined }))
    expect(p.TextBody).toBe('')
    expect(p.HtmlBody).toBeNull()
  })
})

describe('toInboundPayload — Date', () => {
  it('emits the envelope Date as an ISO STRING the route can parse', () => {
    // parseEmailDate() takes a string; a Date instance handed over verbatim
    // would be discarded and every message would carry the poller's clock.
    const p = map(fixture())
    expect(p.Date).toBe('2026-08-26T09:15:00.000Z')
    expect(parseEmailDate(p.Date)).toBe('2026-08-26T09:15:00.000Z')
  })

  it('missing Date falls back to the server’s internalDate, not to null', () => {
    // Better than the route's `|| now`: a poller runs up to five minutes late
    // and a mailbox draining a backlog would otherwise stamp every message
    // with the moment it was drained.
    const p = map(fixture({ envelope: { date: undefined } }))
    expect(p.Date).toBe('2026-08-26T09:15:30.000Z')
  })

  it('missing Date AND internalDate is null — the route then uses its own now', () => {
    const p = map(fixture({ envelope: { date: undefined }, internalDate: undefined }))
    expect(p.Date).toBeNull()
    expect(parseEmailDate(p.Date)).toBeNull()
  })

  it('an unparseable Date is null rather than "Invalid Date"', () => {
    const p = map(fixture({ envelope: { date: 'not a date' }, internalDate: undefined }))
    expect(p.Date).toBeNull()
  })

  it('accepts a date that arrives as a string', () => {
    const p = map(fixture({ envelope: { date: 'Wed, 26 Aug 2026 09:15:00 +0000' } }))
    expect(p.Date).toBe('2026-08-26T09:15:00.000Z')
  })
})

/* ─────────────────────────── shape + robustness ────────────────────────── */

describe('toInboundPayload — payload shape', () => {
  it('emits exactly the pinned key set', () => {
    expect(Object.keys(map(fixture())).sort()).toEqual([
      'Attachments', 'CcFull', 'Date', 'From', 'FromFull', 'Headers', 'HtmlBody',
      'MessageID', 'OriginalRecipient', 'Subject', 'TextBody', 'To', 'ToFull',
    ])
  })

  it('passes Attachments through untouched', () => {
    const attachments = [{ Name: 'invoice.pdf', ContentType: 'application/pdf', Content: '_un1t_staged:abc' }]
    expect(map(fixture(), { attachments }).Attachments).toBe(attachments)
  })

  it('defaults Attachments to an empty array', () => {
    expect(map(fixture()).Attachments).toEqual([])
    expect(map(fixture(), { attachments: null }).Attachments).toEqual([])
  })

  it('never throws on junk input', () => {
    expect(() => toInboundPayload(null, { mailboxAddress: MAILBOX_ADDRESS, mailboxId: MAILBOX_ID })).not.toThrow()
    expect(() => toInboundPayload(undefined)).not.toThrow()
    expect(() => toInboundPayload({ envelope: 'nope', headers: 42 }, {})).not.toThrow()
    expect(() => map({ envelope: { from: [null, 7, {}], to: 'not-an-array' } })).not.toThrow()
  })

  it('is pure — the input message is not mutated', () => {
    const msg = fixture()
    const before = JSON.stringify(msg, (k, v) => (Buffer.isBuffer(v) ? v.toString('utf8') : v))
    map(msg)
    const after = JSON.stringify(msg, (k, v) => (Buffer.isBuffer(v) ? v.toString('utf8') : v))
    expect(after).toBe(before)
  })

  it('is deterministic — two calls on the same input agree', () => {
    expect(map(fixture())).toEqual(map(fixture()))
  })
})

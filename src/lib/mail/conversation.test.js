// Tests for the pure ticket identity + lifecycle rules.
// No DB, no env — every function here is a pure decision function so the
// webhook can be reasoned about without a database.

import { describe, it, expect } from 'vitest'
import {
  resolveTicketAction,
  shouldStampFirstResponse,
  ticketSubject,
  pickThreadedTicket,
  joinPointsByMessage,
} from './email-tickets'

describe('resolveTicketAction', () => {
  it('creates a fresh ticket when nothing threaded', () => {
    expect(resolveTicketAction(null)).toEqual({ action: 'create', reopenedFrom: null })
  })

  it('creates a fresh ticket when the threaded row has no id', () => {
    expect(resolveTicketAction({ status: 'open' })).toEqual({ action: 'create', reopenedFrom: null })
  })

  it('appends to an open ticket without reopening it', () => {
    expect(resolveTicketAction({ id: 't1', status: 'open' }))
      .toEqual({ action: 'append', ticketId: 't1', reopen: false })
  })

  it('appends to a pending ticket and reopens it', () => {
    expect(resolveTicketAction({ id: 't2', status: 'pending' }))
      .toEqual({ action: 'append', ticketId: 't2', reopen: true })
  })

  it('appends to a solved ticket and reopens it', () => {
    expect(resolveTicketAction({ id: 't3', status: 'solved' }))
      .toEqual({ action: 'append', ticketId: 't3', reopen: true })
  })

  it('REOPENS a closed ticket rather than forking a new one', () => {
    // Richard, 2026-08-07. Closing is internal bookkeeping — the member is never
    // told, so replying to their own old email is just continuing the
    // conversation. Forking here would make our record disagree with the thread
    // in their mail client. A genuinely new enquiry threads to nothing and takes
    // the create branch above, which is what actually separates issues.
    expect(resolveTicketAction({ id: 't4', status: 'closed' }))
      .toEqual({ action: 'append', ticketId: 't4', reopen: true })
  })

  it('only ever creates when nothing threaded — never from a status', () => {
    for (const status of ['open', 'pending', 'solved', 'closed']) {
      expect(resolveTicketAction({ id: 't9', status }).action).toBe('append')
    }
    expect(resolveTicketAction(null).action).toBe('create')
  })
})

describe('shouldStampFirstResponse', () => {
  it('stamps on the first outbound reply', () => {
    expect(shouldStampFirstResponse({
      firstResponseAt: null, direction: 'outbound', isInternalNote: false,
    })).toBe(true)
  })

  it('does not stamp twice', () => {
    expect(shouldStampFirstResponse({
      firstResponseAt: '2026-08-05T10:00:00Z', direction: 'outbound', isInternalNote: false,
    })).toBe(false)
  })

  it('does not stamp on inbound', () => {
    expect(shouldStampFirstResponse({
      firstResponseAt: null, direction: 'inbound', isInternalNote: false,
    })).toBe(false)
  })

  it('does not stamp on an internal note — the member never saw it', () => {
    expect(shouldStampFirstResponse({
      firstResponseAt: null, direction: 'outbound', isInternalNote: true,
    })).toBe(false)
  })
})

describe('ticketSubject', () => {
  it('takes the inbound subject for a new ticket', () => {
    expect(ticketSubject(null, 'Billing question')).toBe('Billing question')
  })

  it('KEEPS the original subject on an existing ticket', () => {
    // Deliberately unlike mig 394, where subject tracked the most recent inbound.
    // A ticket is named by the issue that opened it.
    expect(ticketSubject('Billing question', 'Re: Billing question')).toBe('Billing question')
  })

  it('falls back for an empty inbound subject', () => {
    expect(ticketSubject(null, '   ')).toBe('(no subject)')
    expect(ticketSubject(null, null)).toBe('(no subject)')
  })
})

describe('pickThreadedTicket', () => {
  const a = { ticket_id: 'T1', created_at: '2026-08-01T10:00:00Z' }
  const b = { ticket_id: 'T2', created_at: '2026-08-05T10:00:00Z' }

  it('picks the most recent message’s ticket, whatever order the rows arrive in', () => {
    expect(pickThreadedTicket([a, b])).toBe('T2')
    expect(pickThreadedTicket([b, a])).toBe('T2')
  })

  it('ignores rows with no ticket_id, however recent', () => {
    expect(pickThreadedTicket([{ ticket_id: null, created_at: '2026-08-09T10:00:00Z' }, a]))
      .toBe('T1')
  })

  it('returns null when nothing threads', () => {
    expect(pickThreadedTicket([])).toBeNull()
    expect(pickThreadedTicket(null)).toBeNull()
    expect(pickThreadedTicket(undefined)).toBeNull()
    expect(pickThreadedTicket([{ ticket_id: null, created_at: '2026-08-01T10:00:00Z' }])).toBeNull()
  })

  it('is deterministic when timestamps tie — lowest id wins', () => {
    // Rows written in one transaction share a created_at. Falling back to
    // array order there is routing by database row order, which is the bug
    // class this whole module exists to refuse.
    const t = '2026-08-05T10:00:00Z'
    expect(pickThreadedTicket([{ ticket_id: 'B', created_at: t }, { ticket_id: 'A', created_at: t }]))
      .toBe('A')
    expect(pickThreadedTicket([{ ticket_id: 'A', created_at: t }, { ticket_id: 'B', created_at: t }]))
      .toBe('A')
  })

  it('skips an unparseable created_at rather than choosing it', () => {
    expect(pickThreadedTicket([{ ticket_id: 'X', created_at: 'nonsense' }, b])).toBe('T2')
    expect(pickThreadedTicket([{ ticket_id: 'X', created_at: null }])).toBeNull()
    expect(pickThreadedTicket([{ ticket_id: 'X' }])).toBeNull()
  })
})

// EMAIL-PARTICIPANTS.8 — WHERE each address first appears on the thread.
//
// The bug: a ticket opened by ratesoffice@dublincity.ie was forwarded
// internally to eleanor.brennan@dublincity.ie, who replied. Every message from
// then on was with Eleanor, and nothing on screen said so. This is the derived
// fact the thread needs to render "eleanor… joined this thread" against the
// message she actually arrived on.
describe('joinPointsByMessage', () => {
  it('reports nobody for the message that OPENED the thread', () => {
    // The people on the first message did not join a conversation — they
    // started one. "Joined this thread" claims an arrival at something that
    // already existed, and firing it on every ticket's first message turns the
    // marker into "is present", which is neither what it says nor what it is
    // for: its whole job is to make a NEW arrival impossible to miss.
    expect(joinPointsByMessage([
      { id: 'm1', from_email: 'rates@council.ie', to_emails: ['studio@x.com'], cc_emails: ['clerk@council.ie'] },
    ])).toEqual(new Map())
  })

  it('marks the message a NEW counterparty arrived on — the whole point', () => {
    const points = joinPointsByMessage([
      { id: 'm1', from_email: 'studio@x.com', to_emails: ['rates@council.ie'] },
      { id: 'm2', from_email: 'eleanor@council.ie', to_emails: ['studio@x.com'] },
    ])
    expect(points.has('m1')).toBe(false)
    expect(points.get('m2')).toEqual(['eleanor@council.ie'])
  })

  it('attributes an address to the FIRST message it arrives on, and only that one', () => {
    const points = joinPointsByMessage([
      { id: 'm1', from_email: 'a@x.com', to_emails: ['b@x.com'] },
      { id: 'm2', from_email: 'c@x.com', to_emails: ['a@x.com'] },
      { id: 'm3', from_email: 'c@x.com', to_emails: ['a@x.com', 'b@x.com'] },
    ])
    expect(points.get('m2')).toEqual(['c@x.com'])
    // m3 introduces nobody, so it gets no entry at all — a marker on every
    // message would say nothing and hide the one that does.
    expect(points.has('m3')).toBe(false)
  })

  it('reads Cc as an arrival too — a copied colleague is on the thread', () => {
    const points = joinPointsByMessage([
      { id: 'm1', from_email: 'a@x.com', to_emails: ['b@x.com'] },
      { id: 'm2', from_email: 'b@x.com', to_emails: ['a@x.com'], cc_emails: ['c@x.com'] },
    ])
    expect(points.get('m2')).toEqual(['c@x.com'])
  })

  it('skips an internal note, and does not let one consume an address', () => {
    const points = joinPointsByMessage([
      { id: 'm1', from_email: 'a@x.com', to_emails: ['b@x.com'] },
      { id: 'm2', is_internal_note: true, from_email: 'staff@x.com', to_emails: ['boss@x.com'] },
      { id: 'm3', from_email: 'staff@x.com', to_emails: ['b@x.com'] },
    ])
    // A note names nobody: it never left the building, so it cannot be where
    // somebody joined the conversation.
    expect(points.has('m2')).toBe(false)
    // And because the note was skipped rather than counted, staff@x.com joins
    // on m3 — the message they actually sent.
    expect(points.get('m3')).toEqual(['staff@x.com'])
  })

  it('skips a forward, and does not let one consume an address', () => {
    const points = joinPointsByMessage([
      { id: 'm1', from_email: 'a@x.com', to_emails: ['b@x.com'] },
      { id: 'm2', forwarded_message_id: 'm1', from_email: 'b@x.com', to_emails: ['acct@z.com'] },
      { id: 'm3', from_email: 'acct@z.com', to_emails: ['b@x.com'] },
    ])
    // A forward SHOWS the thread to someone rather than adding them to it —
    // the same rule the reply audience uses, for the same reason.
    expect(points.has('m2')).toBe(false)
    // So the accountant joins when they write in, not when they were shown it.
    expect(points.get('m3')).toEqual(['acct@z.com'])
  })

  it('does not let a note or a forward count as the opening message', () => {
    const points = joinPointsByMessage([
      { id: 'm1', is_internal_note: true, from_email: 'staff@x.com' },
      { id: 'm2', forwarded_message_id: 'zz', from_email: 'staff@x.com' },
      { id: 'm3', from_email: 'a@x.com', to_emails: ['b@x.com'] },
      { id: 'm4', from_email: 'eleanor@council.ie', to_emails: ['b@x.com'] },
    ])
    // m3 is the first real correspondence, so IT opened the thread. Letting
    // the skipped rows above claim that would put an "a@x.com joined" marker
    // on the opening message — the noise this rule exists to remove.
    expect(points.has('m3')).toBe(false)
    expect(points.get('m4')).toEqual(['eleanor@council.ie'])
  })

  it('matches case-insensitively and reports the normalised address', () => {
    const points = joinPointsByMessage([
      { id: 'm1', from_email: 'a@x.com' },
      { id: 'm2', from_email: '  Eleanor@Council.IE  ' },
      { id: 'm3', from_email: 'eleanor@council.ie' },
    ])
    // Mail addresses arrive however the sender's client wrote them. "Eleanor
    // joined twice" is the same defect as not noticing she joined at all.
    expect(points.get('m2')).toEqual(['eleanor@council.ie'])
    expect(points.has('m3')).toBe(false)
  })

  it('NEVER reads bcc_emails', () => {
    const points = joinPointsByMessage([
      { id: 'm1', from_email: 'a@x.com' },
      { id: 'm2', from_email: 'b@x.com', to_emails: ['a@x.com'], bcc_emails: ['secret@x.com'] },
    ])
    // A Bcc'd person is not visibly on the thread, and announcing them leaks
    // the Bcc to everyone reading the ticket.
    expect(points.get('m2')).toEqual(['b@x.com'])
  })

  it("lets a previously-Bcc'd address join when it appears openly", () => {
    const points = joinPointsByMessage([
      { id: 'm1', from_email: 'a@x.com', bcc_emails: ['secret@x.com'] },
      { id: 'm2', from_email: 'secret@x.com', to_emails: ['a@x.com'] },
    ])
    // The Bcc was not merely unannounced, it was not consumed: when they write
    // in openly, that IS where the thread learns about them.
    expect(points.get('m2')).toEqual(['secret@x.com'])
  })

  it('treats the first message that NAMES anybody as the opening one', () => {
    const points = joinPointsByMessage([
      { id: 'm1' },
      { id: 'm2', from_email: 'a@x.com', to_emails: ['b@x.com'] },
      { id: 'm3', from_email: 'eleanor@council.ie' },
    ])
    // A row with no addresses at all opens nothing — there is nobody on it to
    // have started the conversation. Counting it would hand the opening
    // message's markers to the real first message instead.
    expect(points.has('m2')).toBe(false)
    expect(points.get('m3')).toEqual(['eleanor@council.ie'])
  })

  it('falls back to the legacy scalar to_email, exactly as its siblings do', () => {
    const points = joinPointsByMessage([
      // A pre-EMAIL-CC.1 row: only the scalar. messageEnvelope() reads it too,
      // and this must agree with it.
      { id: 'm1', from_email: 'studio@x.com', to_email: 'rates@council.ie' },
      { id: 'm2', from_email: 'rates@council.ie', to_emails: ['studio@x.com'] },
      { id: 'm3', from_email: 'eleanor@council.ie', to_emails: ['studio@x.com'] },
    ])
    // Left unread, the opener's recipient would be UNCONSUMED, and the
    // requester's own first reply would raise a false "joined this thread" —
    // exactly the noise the opening-message rule exists to remove.
    expect(points.has('m2')).toBe(false)
    // And a genuinely new arrival after it is still reported.
    expect(points.get('m3')).toEqual(['eleanor@council.ie'])
  })

  it('prefers to_emails over the scalar when both are present', () => {
    const points = joinPointsByMessage([
      { id: 'm1', from_email: 'a@x.com' },
      { id: 'm2', from_email: 'b@x.com', to_emails: ['c@x.com'], to_email: 'stale@x.com' },
    ])
    // The array is the current column; the scalar is a legacy shadow of it and
    // can be stale. Reading both would announce somebody who is not there.
    expect(points.get('m2')).toEqual(['b@x.com', 'c@x.com'])
  })

  it('returns an empty map for empty, null and malformed input', () => {
    expect(joinPointsByMessage([])).toEqual(new Map())
    expect(joinPointsByMessage(null)).toEqual(new Map())
    expect(joinPointsByMessage(undefined)).toEqual(new Map())
    expect(joinPointsByMessage('nope')).toEqual(new Map())
    expect(joinPointsByMessage([null, { id: 'm1' }, { id: 'm2', from_email: '' }])).toEqual(new Map())
  })
})

// ── MAIL-REFINE.1 — normalizedSubjectKey ──────────────────────────────
// The auto-merge-at-ingest key: two fresh threads with the "same" subject
// from the same sender are one conversation whose reply chain broke. The key
// must be forgiving about reply-prefix noise and strict about everything
// else — a false match files a stranger topic into the wrong thread.
import { normalizedSubjectKey } from './email-tickets'

describe('normalizedSubjectKey', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizedSubjectKey('  Flogas   Bill\tfor Hatch  ')).toBe('flogas bill for hatch')
  })

  it('strips reply/forward prefixes, repeatedly and case-insensitively', () => {
    expect(normalizedSubjectKey('RE: Flogas bill')).toBe('flogas bill')
    expect(normalizedSubjectKey('Re: FW: Fwd: Flogas bill')).toBe('flogas bill')
    expect(normalizedSubjectKey('re[2]: Flogas bill')).toBe('flogas bill')
  })

  it('answers null when nothing meaningful remains — a null key never matches', () => {
    expect(normalizedSubjectKey('')).toBeNull()
    expect(normalizedSubjectKey('   ')).toBeNull()
    expect(normalizedSubjectKey('Re:')).toBeNull()
    expect(normalizedSubjectKey(null)).toBeNull()
    expect(normalizedSubjectKey(undefined)).toBeNull()
  })

  it('does NOT equate genuinely different subjects', () => {
    expect(normalizedSubjectKey('Flogas bill')).not.toBe(normalizedSubjectKey('Flogas account setup'))
  })

  it('leaves a subject that merely CONTAINS "re:" alone', () => {
    expect(normalizedSubjectKey('More re: less')).toBe('more re: less')
  })
})

// EMAIL-TICKET.4 — the three ticket-inbox display rules that are silently
// wrong when they break: the wire vocabulary for ?view=, the internal-note
// classification, and the light-theme chip ramp.

import { describe, it, expect } from 'vitest'
import {
  TICKET_VIEWS,
  DEFAULT_VIEW_ID,
  ticketView,
  viewWireValue,
  buildTicketsUrl,
  STATUS_META,
  STATUS_ORDER,
  statusMeta,
  isArchivedStatus,
  priorityMeta,
  messageKind,
  messageEnvelope,
  canForwardMessage,
  forwardedMarker,
  replyActionLabel,
  deliveryMeta,
  sendOriginMeta,
  deliveryTimestamp,
  requesterLabel,
  initialsOf,
  assigneeLabel,
  mailboxLabel,
  threadRefreshMs,
  threadSignature,
  newestMessageAt,
  THREAD_SETTLE_MS,
  THREAD_STEADY_MS,
  THREAD_SETTLE_WINDOW_MS,
  NO_MAILBOX_EMPTY,
  MAILBOXES_ON_MAIL_EMPTY,
  relativeTime,
  messageTimestamp,
} from './ticket-display'

// The route whitelists exactly these and 400s on anything else.
const WIRE_WHITELIST = ['unassigned', 'mine', 'needs_reply', 'closed']

describe('views', () => {
  it('only ever puts a route-whitelisted string on the wire', () => {
    for (const v of TICKET_VIEWS) {
      if (v.wire === null) continue
      expect(WIRE_WHITELIST, `view "${v.id}" would 400`).toContain(v.wire)
    }
  })

  it('omits the view param for the default view (open + pending)', () => {
    expect(viewWireValue(DEFAULT_VIEW_ID)).toBeNull()
    expect(buildTicketsUrl({ locationId: 'loc-1', viewId: DEFAULT_VIEW_ID }))
      .not.toContain('view=')
  })

  it('keeps the human label "Closed" on the wire word `closed`', () => {
    const closed = ticketView('closed')
    expect(closed.label).toBe('Closed')
    expect(closed.wire).toBe('closed')
  })

  it('falls back to the default view rather than undefined for an unknown id', () => {
    expect(ticketView('nonsense').id).toBe(DEFAULT_VIEW_ID)
    expect(viewWireValue(undefined)).toBeNull()
  })

  it('gives every view its own empty-state copy', () => {
    const titles = TICKET_VIEWS.map(v => v.emptyTitle)
    expect(new Set(titles).size).toBe(titles.length)
  })
})

describe('buildTicketsUrl', () => {
  it('encodes location, mailbox and view', () => {
    const url = buildTicketsUrl({ locationId: 'loc-1', mailboxId: 'mb-2', viewId: 'needs_reply' })
    expect(url).toBe('/api/email/tickets?location_id=loc-1&mailbox_id=mb-2&view=needs_reply')
  })

  it('omits mailbox_id when no tab is selected (all visible mailboxes)', () => {
    expect(buildTicketsUrl({ locationId: 'loc-1', mailboxId: null, viewId: 'mine' }))
      .toBe('/api/email/tickets?location_id=loc-1&view=mine')
  })

  it('survives a missing location without emitting "undefined"', () => {
    expect(buildTicketsUrl()).not.toContain('undefined')
  })
})

describe('messageKind — the safety-critical one', () => {
  it('calls an internal note a note even though it is stored as outbound', () => {
    // The reply route writes notes with direction='outbound'. Testing
    // direction first would paint staff-only text as a sent reply.
    expect(messageKind({ direction: 'outbound', is_internal_note: true })).toBe('note')
  })

  it('separates a real sent reply from a note', () => {
    expect(messageKind({ direction: 'outbound', is_internal_note: false })).toBe('outbound')
  })

  it('treats member mail as inbound', () => {
    expect(messageKind({ direction: 'inbound', is_internal_note: false })).toBe('inbound')
  })

  it('never guesses "sent" for a malformed row', () => {
    expect(messageKind(null)).toBe('inbound')
    expect(messageKind({})).toBe('inbound')
  })

  // MAILBOX-COEXIST.1 — a reply typed in Gmail IS an outbound message: it went
  // to the member and it is not a note. The three-case shape of this function
  // is the safety property of the whole thread pane, and where a message came
  // FROM is not a fact about the shape of its bubble. It is answered by
  // sendOriginMeta, beside this, not by a fourth value in here.
  it('calls a mail-client reply outbound — it does NOT grow a fourth kind', () => {
    expect(messageKind({
      direction: 'outbound', is_internal_note: false, source: 'mail_client',
    })).toBe('outbound')
  })
})

// MAILBOX-COEXIST.1 — Phase 8 files a connected mailbox's Sent folder, so an
// outbound row can now be a reply somebody typed in Gmail, with no CRM author
// to name. The failure the phase exists to remove is two people answering one
// member; a thread that cannot say a reply came from outside the CRM can say
// THAT the member was answered but not by whom or from where, which leaves the
// second person with nothing to check.
describe('sendOriginMeta (MAILBOX-COEXIST.1)', () => {
  const mailClient = (extra) => ({
    direction: 'outbound',
    is_internal_note: false,
    source: 'mail_client',
    postmark_message_id: null,
    rfc_message_id: 'CAF=9x@mail.gmail.com',
    author_profile_id: null,
    ...extra,
  })

  it('marks a reply sent from someone’s own mail client', () => {
    const origin = sendOriginMeta(mailClient())
    expect(origin).not.toBeNull()
    expect(origin.source).toBe('mail_client')
    expect(origin.label).toBe('Sent from the mail client')
    // It must not claim to know WHO: author_profile_id is deliberately null on
    // these rows, and inventing an author is the one thing worse than saying
    // nothing about them.
    expect(origin.detail).toMatch(/cannot say which person/i)
  })

  // The distinction the whole rule is for. Both rows are outbound, both went
  // to the member, and before Phase 8 they were indistinguishable on screen.
  it('says NOTHING about a reply composed in the CRM', () => {
    expect(sendOriginMeta(mailClient({ source: 'operator' }))).toBeNull()
    // Every outbound row written before Phase 8 — source is nullable and was
    // never stamped for them.
    expect(sendOriginMeta(mailClient({ source: null }))).toBeNull()
    expect(sendOriginMeta(mailClient({ source: undefined }))).toBeNull()
  })

  it('says nothing about inbound mail — the member’s own mail app is not ours to report', () => {
    expect(sendOriginMeta({ direction: 'inbound', source: 'mail_client' })).toBeNull()
  })

  it('says nothing about an internal note, which was never sent from anywhere', () => {
    expect(sendOriginMeta(mailClient({ is_internal_note: true }))).toBeNull()
  })

  it('does not throw on a malformed row', () => {
    expect(sendOriginMeta(null)).toBeNull()
    expect(sendOriginMeta({})).toBeNull()
  })
})

describe('status + priority chips', () => {
  it('covers every lifecycle status in walk order', () => {
    expect(STATUS_ORDER).toEqual(['open', 'pending', 'solved', 'closed'])
    for (const s of STATUS_ORDER) expect(STATUS_META[s]).toBeTruthy()
  })

  it('uses the light-theme chip idiom (bg-*-500/10 + the -700 text ramp)', () => {
    for (const s of STATUS_ORDER) {
      expect(STATUS_META[s].chip).toMatch(/^bg-[a-z]+-500\/10 text-[a-z]+-700$/)
    }
    expect(priorityMeta('high').chip).toMatch(/^bg-[a-z]+-500\/10 text-[a-z]+-700$/)
  })

  it('gives an unknown status a readable fallback instead of blank classes', () => {
    expect(statusMeta('weird').chip).toContain('text-')
    expect(statusMeta(undefined).label).toBe('Unknown')
  })

  it('shows no chip for normal priority', () => {
    expect(priorityMeta('normal')).toBeNull()
    expect(priorityMeta(undefined)).toBeNull()
    expect(priorityMeta('high').label).toBe('High')
  })

  it('counts solved and closed as archived', () => {
    expect(isArchivedStatus('solved')).toBe(true)
    expect(isArchivedStatus('closed')).toBe(true)
    expect(isArchivedStatus('open')).toBe(false)
    expect(isArchivedStatus('pending')).toBe(false)
  })

  // A reply to a CLOSED ticket REOPENS it — it does not fork (Richard,
  // 2026-08-07, reversing an earlier draft). The hint predated that call and
  // still promised a new ticket, which teaches operators the wrong model.
  it('tells operators a member reply reopens an archived ticket — both statuses', () => {
    for (const s of ['solved', 'closed']) {
      expect(STATUS_META[s].hint).toMatch(/reopens/)
      expect(STATUS_META[s].hint).not.toMatch(/new ticket/i)
    }
  })
})

describe('labels', () => {
  it('prefers a requester name, falls back to the address', () => {
    expect(requesterLabel({ requester_name: 'Aoife', requester_email: 'a@x.ie' })).toBe('Aoife')
    expect(requesterLabel({ requester_email: 'a@x.ie' })).toBe('a@x.ie')
    expect(requesterLabel(null)).toBe('Unknown sender')
  })

  it('builds two-letter initials and never renders empty', () => {
    expect(initialsOf('Aoife Byrne')).toBe('AB')
    expect(initialsOf('cher')).toBe('C')
    expect(initialsOf('')).toBe('?')
  })

  it('distinguishes yours / somebody else / nobody without inventing a name', () => {
    expect(assigneeLabel({ assigned_to: 'u1' }, 'u1')).toBe('Assigned to you')
    expect(assigneeLabel({ assigned_to: 'u2' }, 'u1')).toBe('Assigned')
    expect(assigneeLabel({ assigned_to: null }, 'u1')).toBe('Unassigned')
    // EMAIL-ASSIGN.1 — a resolved name beats the anonymous 'Assigned', and
    // 'you' still beats the name (the viewer knows their own name).
    expect(assigneeLabel({ assigned_to: 'u2', assignee_name: 'Sarah' }, 'u1')).toBe('Assigned to Sarah')
    expect(assigneeLabel({ assigned_to: 'u1', assignee_name: 'Casey' }, 'u1')).toBe('Assigned to you')
  })

  it('names a mailbox by label, then address', () => {
    expect(mailboxLabel({ label: 'Accounts', address: 'accounts@x.ie' })).toBe('Accounts')
    expect(mailboxLabel({ address: 'accounts@x.ie' })).toBe('accounts@x.ie')
    expect(mailboxLabel(null)).toBe('No mailbox')
  })

  it('keeps the no-mailbox copy distinct from an empty queue', () => {
    for (const v of TICKET_VIEWS) {
      expect(NO_MAILBOX_EMPTY.title).not.toBe(v.emptyTitle)
    }
  })

  // INBOX-SURFACE.E — when a studio's mailbox MOVED to Mail rather than
  // genuinely having none, NO_MAILBOX_EMPTY's "no access granted" copy is
  // simply false and reads as a revoked grant. MAILBOXES_ON_MAIL_EMPTY names
  // what actually happened instead.
  describe('MAILBOXES_ON_MAIL_EMPTY', () => {
    it('is a different situation from NO_MAILBOX_EMPTY and says so', () => {
      const copy = MAILBOXES_ON_MAIL_EMPTY(['Accounts'])
      expect(copy.title).not.toBe(NO_MAILBOX_EMPTY.title)
      expect(copy.description).not.toBe(NO_MAILBOX_EMPTY.description)
      // The whole point: never suggest access was revoked — NO_MAILBOX_EMPTY's
      // "you have not been given access" framing must not leak in here.
      expect(copy.description.toLowerCase()).not.toContain('have not been given')
      expect(copy.description.toLowerCase()).not.toContain('grant')
    })

    it('names the single moved account and points at Mail', () => {
      const copy = MAILBOXES_ON_MAIL_EMPTY(['accounts@hatchstreetfitness.com'])
      expect(copy.description).toContain('accounts@hatchstreetfitness.com')
      expect(copy.description).toMatch(/Mail/)
    })

    it('names every moved account when there is more than one', () => {
      const copy = MAILBOXES_ON_MAIL_EMPTY(['Accounts', 'Sales'])
      expect(copy.description).toContain('Accounts')
      expect(copy.description).toContain('Sales')
    })

    it('never crashes and still points at Mail when handed an empty list', () => {
      const copy = MAILBOXES_ON_MAIL_EMPTY([])
      expect(typeof copy.title).toBe('string')
      expect(copy.title.length).toBeGreaterThan(0)
      expect(copy.description).toMatch(/Mail/)
    })

    it('never crashes when handed undefined (absent-flag defensive call)', () => {
      const copy = MAILBOXES_ON_MAIL_EMPTY(undefined)
      expect(typeof copy.title).toBe('string')
      expect(copy.description).toMatch(/Mail/)
    })
  })
})

describe('time', () => {
  const now = Date.parse('2026-08-06T12:00:00.000Z')

  it('buckets recent ages compactly', () => {
    expect(relativeTime('2026-08-06T11:59:40.000Z', now)).toBe('now')
    expect(relativeTime('2026-08-06T11:48:00.000Z', now)).toBe('12m')
    expect(relativeTime('2026-08-06T09:00:00.000Z', now)).toBe('3h')
    expect(relativeTime('2026-08-04T12:00:00.000Z', now)).toBe('2d')
  })

  it('returns empty rather than "Invalid Date" for missing or junk values', () => {
    expect(relativeTime(null, now)).toBe('')
    expect(relativeTime('not-a-date', now)).toBe('')
    expect(messageTimestamp(null)).toBe('')
    expect(messageTimestamp('not-a-date')).toBe('')
  })

  it('does not render a negative age for a clock-skewed future stamp', () => {
    expect(relativeTime('2026-08-06T12:00:30.000Z', now)).toBe('now')
  })
})

// EMAIL-DELIVERY.1 — the three outcomes and the silence.
//
// The silence is the one that gets broken by accident: `delivery_status` is
// NULL on every message sent before mig 498, on every message the instant it
// goes out, and forever on any message whose webhook never arrives. Rendering
// it as either "delivered" or "failed" would be a lie in one direction or the
// other, and the second one is the lie this whole feature exists to stop.
describe('deliveryMeta (EMAIL-DELIVERY.1)', () => {
  // The default fixture is a POSTMARK send, which is what EMAIL-DELIVERY.1 is
  // about: it carries an API MessageID, so an event can still arrive for it.
  // MAILBOX-CONNECT.7 made that field load-bearing — an outbound row WITHOUT
  // one was sent over the mailbox's own SMTP and no event ever can arrive.
  const outbound = (extra) => ({
    direction: 'outbound',
    is_internal_note: false,
    postmark_message_id: 'a8c1040e-db1c-4e18-ac79-bc5f64c7ce2c',
    ...extra,
  })

  it('says NOTHING about a message with no provider event yet', () => {
    expect(deliveryMeta(outbound({ delivery_status: null }))).toBeNull()
    expect(deliveryMeta(outbound({}))).toBeNull()
  })

  // MAILBOX-CONNECT.7 — the two NULL states are different facts. "Sent, heard
  // nothing YET" and "sent, and nothing can ever arrive" render identically
  // without this, and the difference is exactly what an operator needs when a
  // member says they never got a reply.
  it('says NOT TRACKED for an SMTP send, which can never get an event', () => {
    const meta = deliveryMeta(outbound({
      delivery_status: null, postmark_message_id: null, rfc_message_id: 'a@theirgym.ie',
    }))
    expect(meta).not.toBeNull()
    expect(meta.label).toBe('Not tracked')
    expect(meta.tone).toBe('quiet')
    expect(meta.detail).toMatch(/does not report delivery/i)
  })

  // 🔴 MAILBOX-COEXIST.1 — THE HONESTY CASE. A mail-client row matches the
  // SMTP predicate exactly (outbound, no status, no Postmark id, an rfc id),
  // so without its own branch it would inherit the SMTP branch's copy and tell
  // the operator this was "sent from this mailbox's own server". It was not
  // sent from any server of ours: the poller found a copy of it in a folder.
  // Naming a send path we did not use is a specific falsehood, and it would
  // send anyone chasing a message a member says never arrived to the wrong
  // place. These three tests are the whole reason the branch exists.
  it('does NOT tell an operator a mail-client reply was sent from our SMTP', () => {
    const meta = deliveryMeta(outbound({
      delivery_status: null,
      source: 'mail_client',
      postmark_message_id: null,
      rfc_message_id: 'CAF=9x@mail.gmail.com',
    }))
    expect(meta).not.toBeNull()
    // The SMTP branch's sentence, which is FALSE for this row.
    expect(meta.detail).not.toMatch(/mailbox.s own server/i)
    expect(meta.detail).not.toMatch(/does not report delivery/i)
  })

  it('says NOT TRACKED for a mail-client reply, because nothing can ever arrive', () => {
    const meta = deliveryMeta(outbound({
      delivery_status: null,
      source: 'mail_client',
      postmark_message_id: null,
      rfc_message_id: 'CAF=9x@mail.gmail.com',
    }))
    // Same LABEL as the SMTP case on purpose — the delivery fact an operator
    // reads is identical, and one fact does not need two words. Only the
    // reason differs, and the reason is what `detail` carries.
    expect(meta.label).toBe('Not tracked')
    expect(meta.tone).toBe('quiet')
    // What it actually says: we did not send it, and no event is coming.
    expect(meta.detail).toMatch(/did not send this/i)
    expect(meta.detail).toMatch(/Sent folder/i)
    expect(meta.detail).toMatch(/none can arrive/i)
  })

  // The branch is keyed on `source`, which is the direct evidence, so it must
  // still fire on a row that does NOT match the SMTP shape — a Sent copy whose
  // Message-ID header the mapper could not read, say. The point of keying on
  // source rather than the null-pair is that it does not depend on the pair.
  it('reads a mail-client row by its source, not by the shape of its ids', () => {
    const meta = deliveryMeta(outbound({
      delivery_status: null, source: 'mail_client',
      postmark_message_id: null, rfc_message_id: null,
    }))
    expect(meta?.label).toBe('Not tracked')
    expect(meta.detail).toMatch(/did not send this/i)
  })

  // BOTH ORDERINGS THE BRANCH DEPENDS ON, pinned because nothing else would
  // notice if someone moved it. It must sit BELOW the status branches (so a
  // real outcome is never swallowed) and ABOVE the SMTP branch (so the more
  // specific fact wins over the one inferred from the id shape).
  it('keeps a real outcome on a mail-client row, and beats the SMTP branch', () => {
    const bounced = deliveryMeta(outbound({
      delivery_status: 'bounced', source: 'mail_client',
      postmark_message_id: null, rfc_message_id: 'a@b.com',
    }))
    expect(bounced.label).toBe('Not delivered')

    const quiet = deliveryMeta(outbound({
      delivery_status: null, source: 'mail_client',
      postmark_message_id: null, rfc_message_id: 'a@b.com',
    }))
    expect(quiet.detail).toMatch(/did not send this/i)
  })

  it('still reports a real outcome on an SMTP row if one somehow exists', () => {
    // Defensive: the not-tracked branch must sit BELOW the status branches, so
    // a genuine bounce is never swallowed by the absence of a Postmark id.
    const meta = deliveryMeta(outbound({
      delivery_status: 'bounced', postmark_message_id: null, rfc_message_id: 'a@theirgym.ie',
    }))
    expect(meta.label).toBe('Not delivered')
  })

  // AUDIT FIX — keying on a missing Postmark id ALONE also matched every
  // historical row whose id was never captured, and the degraded plannedFroms
  // path, and told the operator those had been sent over SMTP. Asserting a
  // false fact about how a message was sent is worse than saying nothing.
  it('says NOTHING about a row with neither id — it does not invent provenance', () => {
    expect(deliveryMeta(outbound({
      delivery_status: null, postmark_message_id: null, rfc_message_id: null,
    }))).toBeNull()
    expect(deliveryMeta(outbound({ delivery_status: null, postmark_message_id: null }))).toBeNull()
  })

  it('does not claim not-tracked for an inbound message or an internal note', () => {
    expect(deliveryMeta({
      direction: 'inbound', postmark_message_id: null, rfc_message_id: 'a@b.com',
    })).toBeNull()
    expect(deliveryMeta(outbound({
      is_internal_note: true, postmark_message_id: null, rfc_message_id: 'a@b.com',
    }))).toBeNull()
  })

  it('says nothing about an unrecognised status rather than guessing', () => {
    expect(deliveryMeta(outbound({ delivery_status: 'opened' }))).toBeNull()
  })

  it('never claims anything about an INTERNAL NOTE — nothing was ever sent', () => {
    // A note is stored with direction='outbound', so testing direction alone
    // would put "Delivered" on staff-only text that went to nobody.
    expect(deliveryMeta({ direction: 'outbound', is_internal_note: true, delivery_status: 'delivered' })).toBeNull()
  })

  it('never claims anything about an INBOUND message', () => {
    expect(deliveryMeta({ direction: 'inbound', delivery_status: 'delivered' })).toBeNull()
  })

  it('renders a delivery QUIETLY — one word, no panel, no colour', () => {
    const m = deliveryMeta(outbound({ delivery_status: 'delivered' }))
    expect(m).toMatchObject({ status: 'delivered', tone: 'quiet', label: 'Delivered' })
    // No headline and no chip: a delivered message must not grow a panel.
    expect(m.headline).toBeUndefined()
    expect(m.chip).toBeUndefined()
  })

  it('renders a bounce LOUDLY, and says the member never got it', () => {
    const m = deliveryMeta(outbound({
      delivery_status: 'bounced',
      delivery_bounce_type: 'hard',
      delivery_detail: 'smtp;550 5.1.1 User unknown',
    }))
    expect(m.tone).toBe('alarm')
    expect(m.headline).toMatch(/never got this reply/i)
    expect(m.detail).toBe('smtp;550 5.1.1 User unknown')
    // Light-theme chip ramp (CLAUDE.md) — never -300/-400.
    expect(m.chip).toBe('bg-red-500/10 text-red-700')
  })

  it('gives HARD and SOFT bounces different advice — they call for different actions', () => {
    const hard = deliveryMeta(outbound({ delivery_status: 'bounced', delivery_bounce_type: 'hard' }))
    const soft = deliveryMeta(outbound({ delivery_status: 'bounced', delivery_bounce_type: 'soft' }))
    expect(hard.advice).not.toBe(soft.advice)
    expect(hard.advice).toMatch(/does not exist/i)
    expect(soft.advice).toMatch(/mailbox full/i)
  })

  it('falls back to transient advice for an unknown or missing bounce type', () => {
    const m = deliveryMeta(outbound({ delivery_status: 'bounced' }))
    expect(m.tone).toBe('alarm')
    expect(m.advice).toBeTruthy()
  })

  it('treats a spam complaint as its own problem — they DID receive it', () => {
    const m = deliveryMeta(outbound({ delivery_status: 'complained' }))
    expect(m.tone).toBe('warn')
    expect(m.chip).toBe('bg-amber-500/10 text-amber-700')
    expect(m.headline).toMatch(/spam/i)
    // Must not claim non-delivery: that is the bounce's story, not this one.
    expect(m.headline).not.toMatch(/never got/i)
  })

  it('deliveryTimestamp is empty when there is no stamp', () => {
    expect(deliveryTimestamp({})).toBe('')
    expect(deliveryTimestamp(null)).toBe('')
    expect(deliveryTimestamp({ delivery_status_at: '2026-08-07T09:15:00Z' })).toBeTruthy()
  })
})

// ── The message envelope (EMAIL-CC.1 → ENVELOPE-ONE.1) ───────────────
describe('messageEnvelope', () => {
  it('leads with From — the line that says who actually sent it', () => {
    const [line] = messageEnvelope({ from_email: 'ada@example.com' })
    expect(line).toMatchObject({ key: 'from', label: 'From', staffOnly: false })
    expect(line.addresses).toEqual(['ada@example.com'])
  })

  // INVERTED BY ENVELOPE-ONE.1. This used to assert the opposite — a lone To
  // was dropped because the bubble's own "Sent to …" line already said it.
  // EMAIL-PARTICIPANTS.8 is why that was wrong: with no From and no
  // single-recipient To to read, a reply from a different person at the same
  // organisation looks identical to one from the requester.
  it('renders a single To — an envelope that sometimes omits it is not one', () => {
    const [line] = messageEnvelope({ to_emails: ['ada@example.com'] })
    expect(line).toMatchObject({ key: 'to', label: 'To', staffOnly: false })
    expect(line.addresses).toEqual(['ada@example.com'])
  })

  it('renders every address on a multi-party To', () => {
    const [line] = messageEnvelope({ to_emails: ['ada@example.com', 'bob@example.com'] })
    expect(line.addresses).toEqual(['ada@example.com', 'bob@example.com'])
  })

  it('shows Cc, which every recipient of the email could see', () => {
    const lines = messageEnvelope({ to_emails: ['ada@x.com'], cc_emails: ['bob@x.com'] })
    expect(lines.map(l => l.key)).toEqual(['to', 'cc'])
    expect(lines[1]).toMatchObject({ key: 'cc', staffOnly: false })
  })

  // BCC MUST BE MARKED. Rendered beside To and Cc with no distinction it
  // implies the other recipients saw it. They did not, and never will.
  it('marks Bcc staffOnly and explains why', () => {
    const lines = messageEnvelope({ to_emails: ['a@x.com'], bcc_emails: ['secret@x.com'] })
    const line = lines.find(l => l.key === 'bcc')
    expect(line).toMatchObject({ key: 'bcc', staffOnly: true })
    expect(line.note).toMatch(/only staff/i)
  })

  it('puts the lines in header order', () => {
    const lines = messageEnvelope({
      from_email: 'ada@x.com',
      to_emails: ['bob@x.com'],
      cc_emails: ['cara@x.com'],
      bcc_emails: ['dan@x.com'],
    })
    expect(lines.map(l => l.key)).toEqual(['from', 'to', 'cc', 'bcc'])
  })

  // INVERTED BY ENVELOPE-ONE.1: this used to expect [] for a lone scalar To.
  it('reads the scalar to_email on a row written before mig 499', () => {
    const [line] = messageEnvelope({ to_email: 'ada@x.com' })
    expect(line).toMatchObject({ key: 'to' })
    expect(line.addresses).toEqual(['ada@x.com'])
  })

  // EMAIL-PARTICIPANTS.12 — a NON-EMPTY array of nothing is still nothing.
  // Four readers of to_emails must agree about this row, and this one could
  // not be asserted while it lived in TicketThread.jsx.
  it('takes the scalar fallback for a to_emails array holding nothing usable', () => {
    const [line] = messageEnvelope({ to_emails: [null], to_email: 'ada@x.com' })
    expect(line.addresses).toEqual(['ada@x.com'])
  })

  it('omits empty lists rather than rendering a blank Cc', () => {
    expect(messageEnvelope({ to_emails: ['a@x.com'], cc_emails: [], bcc_emails: [] }))
      .toEqual([{ key: 'to', label: 'To', addresses: ['a@x.com'], staffOnly: false }])
  })

  it('is empty when there is no envelope to show', () => {
    expect(messageEnvelope({})).toEqual([])
    expect(messageEnvelope(null)).toEqual([])
  })
})

describe('replyActionLabel', () => {
  // A bare "Reply" on a four-person thread is what causes the mistake the
  // derived-mode rule exists to prevent.
  it('names the count on a multi-party thread', () => {
    expect(replyActionLabel({ to: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'], mode: 'reply_all' }))
      .toBe('Reply All (4 people)')
  })

  it('is a plain Reply for one person', () => {
    expect(replyActionLabel({ to: ['a@x.com'], mode: 'reply' })).toBe('Reply')
  })

  it('counts addresses the operator added on top', () => {
    expect(replyActionLabel({ to: ['a@x.com'], mode: 'reply' }, 2)).toBe('Reply All (3 people)')
  })

  // Null means the server could not work the set out. Inventing a count we do
  // not have would be worse than not showing one.
  it('degrades to the plain label when the set is unknown', () => {
    expect(replyActionLabel(null)).toBe('Reply')
  })
})

// EMAIL-ATTACH-RACE.1 — the cadence an open thread re-reads itself at.
//
// WHAT THESE TESTS PROVE: the schedule, and only the schedule. That a young
// thread asks to be read again in seconds and a quiet one in a minute is the
// decision that closes the attachment race, and it is the part that can be
// pinned down without a browser. What they do NOT prove is that the component
// honours it, that the request goes out, or that the row is there when it
// arrives — that is a live check (see the PR notes).
describe('threadRefreshMs', () => {
  const NOW = Date.parse('2026-08-07T21:00:00.000Z')
  const at = (iso) => [{ id: 'm1', created_at: iso }]

  // The whole point. A message that just landed may still be growing
  // attachment rows, so the next read has to be soon enough that a member's
  // photo appears while the operator is still looking at the message.
  it('polls fast while the newest message is still settling', () => {
    expect(threadRefreshMs(at('2026-08-07T20:59:58.000Z'), NOW)).toBe(THREAD_SETTLE_MS)
  })

  it('drops to the steady cadence once nothing is recent', () => {
    expect(threadRefreshMs(at('2026-08-07T20:00:00.000Z'), NOW)).toBe(THREAD_STEADY_MS)
  })

  // The boundary itself, both sides — an off-by-one here is a thread that
  // stops looking exactly when it should still be looking.
  it('treats the settle window as exclusive at its far edge', () => {
    const justInside = new Date(NOW - THREAD_SETTLE_WINDOW_MS + 1).toISOString()
    const exactlyOut = new Date(NOW - THREAD_SETTLE_WINDOW_MS).toISOString()
    expect(threadRefreshMs(at(justInside), NOW)).toBe(THREAD_SETTLE_MS)
    expect(threadRefreshMs(at(exactlyOut), NOW)).toBe(THREAD_STEADY_MS)
  })

  // Clock skew between the browser and the database is real and small. Reading
  // again costs one request; not reading again is the bug back.
  it('treats a future timestamp as brand new rather than ancient', () => {
    expect(threadRefreshMs(at('2026-08-07T21:00:30.000Z'), NOW)).toBe(THREAD_SETTLE_MS)
  })

  it('uses the steady cadence for an empty or unparseable thread', () => {
    expect(threadRefreshMs([], NOW)).toBe(THREAD_STEADY_MS)
    expect(threadRefreshMs(at('not a date'), NOW)).toBe(THREAD_STEADY_MS)
    expect(threadRefreshMs(undefined, NOW)).toBe(THREAD_STEADY_MS)
  })

  // The route returns messages oldest first. If that ever changes, a cadence
  // derived from the last element would silently go slow — which is exactly
  // the failure this feature exists to remove, so it scans instead.
  it('finds the newest message wherever it sits in the array', () => {
    const rows = [
      { id: 'b', created_at: '2026-08-07T20:59:59.000Z' },
      { id: 'a', created_at: '2026-08-07T18:00:00.000Z' },
    ]
    expect(newestMessageAt(rows)).toBe(Date.parse('2026-08-07T20:59:59.000Z'))
    expect(threadRefreshMs(rows, NOW)).toBe(THREAD_SETTLE_MS)
  })
})

describe('threadSignature', () => {
  // An attachment row landing on a message already on screen is the whole
  // point of the poll — and the one case where the view must NOT scroll.
  it('is unchanged when a re-read only fills in an attachment', () => {
    const before = [{ id: 'm1', attachments: [] }]
    const after = [{ id: 'm1', attachments: [{ id: 'a1' }] }]
    expect(threadSignature(after)).toBe(threadSignature(before))
  })

  it('changes when a message is actually added', () => {
    const before = [{ id: 'm1' }]
    const after = [{ id: 'm1' }, { id: 'm2' }]
    expect(threadSignature(after)).not.toBe(threadSignature(before))
  })

  // Same length, different newest message — a poll that raced a send could
  // land on this, and treating it as "no change" would strand the operator
  // above their own reply.
  it('changes when the newest message is replaced', () => {
    expect(threadSignature([{ id: 'm2' }])).not.toBe(threadSignature([{ id: 'm1' }]))
  })

  it('survives an empty thread', () => {
    expect(threadSignature([])).toBe(threadSignature([]))
    expect(threadSignature(undefined)).toBe(threadSignature([]))
  })
})

// EMAIL-FORWARD.1 — the two rules the thread must not get wrong about a
// forward: a note may never offer the action, and a forward must never be
// mistaken for an ordinary reply.
describe('canForwardMessage', () => {
  it('allows an ordinary inbound or outbound message', () => {
    expect(canForwardMessage({ direction: 'inbound', is_internal_note: false })).toBe(true)
    expect(canForwardMessage({ direction: 'outbound', is_internal_note: false })).toBe(true)
  })

  // The affordance half of the rule the route enforces: a note was sent to
  // nobody and is written assuming only colleagues read it.
  it('never allows an internal note', () => {
    expect(canForwardMessage({ direction: 'outbound', is_internal_note: true })).toBe(false)
  })

  it('never throws on nothing', () => {
    expect(canForwardMessage(null)).toBe(false)
    expect(canForwardMessage(undefined)).toBe(false)
  })
})

describe('forwardedMarker', () => {
  const SOURCE = {
    id: 'm-1', direction: 'inbound', from_email: 'ada@example.com',
    created_at: '2026-08-07T09:00:00Z',
  }
  const byId = new Map([[SOURCE.id, SOURCE]])

  it('is null for anything that is not a forward', () => {
    expect(forwardedMarker({ id: 'm-2', direction: 'outbound' }, byId)).toBeNull()
    expect(forwardedMarker(null, byId)).toBeNull()
  })

  it('names who the quoted message was from', () => {
    const label = forwardedMarker({ id: 'm-2', forwarded_message_id: 'm-1' }, byId)
    expect(label).toContain('ada@example.com')
  })

  // A thread over the 200-message cap, or a source row deleted (the FK is ON
  // DELETE SET NULL). It is still a forward, and dropping the marker would
  // silently reclassify it as an ordinary reply.
  it('still says it was a forward when the quoted message is not loaded', () => {
    const label = forwardedMarker({ id: 'm-2', forwarded_message_id: 'gone' }, byId)
    expect(label).toMatch(/forwarded/i)
  })

  it('never throws without a lookup map', () => {
    expect(forwardedMarker({ forwarded_message_id: 'm-1' })).toMatch(/forwarded/i)
  })
})

import { describe, it, expect } from 'vitest'
import {
  TICKET_STATUS_ORDER,
  TICKET_VIEW_TABS,
  DEFAULT_TICKET_VIEW,
  ticketStatusMeta,
  ticketViewTab,
  ticketViewWire,
  isArchivedStatus,
  ticketMessageKind,
  ticketMessageRecipients,
  sentToLabel,
  ticketReplyAudienceMeta,
  ticketReplyPlaceholder,
  ticketThreadAudienceLines,
  ticketDeliveryMeta,
  ticketSendOriginMeta,
  requesterLabel,
  mailboxLabel,
  ticketToInboxRow,
  ticketsToInboxRows,
  formatAttachmentSize,
  ticketAttachmentSkippedLabel,
  ticketAttachmentIcon,
  threadRefreshMs,
  newestMessageAt,
  THREAD_SETTLE_MS,
  THREAD_STEADY_MS,
  THREAD_SETTLE_WINDOW_MS,
} from './email-tickets'

describe('ticketMessageKind', () => {
  // THE regression guard for this surface. A note is written with
  // direction='outbound' (the reply route), so testing direction first would
  // paint staff-only text exactly like a reply the member received.
  it('calls an internal note a note even though it is stored as outbound', () => {
    expect(ticketMessageKind({ direction: 'outbound', is_internal_note: true })).toBe('note')
  })

  it('calls an inbound-flagged note a note too', () => {
    expect(ticketMessageKind({ direction: 'inbound', is_internal_note: true })).toBe('note')
  })

  it('calls a real reply outbound', () => {
    expect(ticketMessageKind({ direction: 'outbound', is_internal_note: false })).toBe('outbound')
  })

  it('calls the member inbound', () => {
    expect(ticketMessageKind({ direction: 'inbound' })).toBe('inbound')
  })

  it('defaults to inbound for junk', () => {
    expect(ticketMessageKind(null)).toBe('inbound')
    expect(ticketMessageKind({})).toBe('inbound')
  })

  // MAILBOX-COEXIST.1 — a reply typed in Gmail IS outbound: it reached the
  // member and it is not a note. Where it came FROM is a separate rule
  // (ticketSendOriginMeta), deliberately not a fourth value in the one
  // function on this screen whose three-case ordering is the safety property.
  it('calls a mail-client reply outbound — no fourth kind', () => {
    expect(ticketMessageKind({
      direction: 'outbound', is_internal_note: false, source: 'mail_client',
    })).toBe('outbound')
  })
})

// MAILBOX-COEXIST.1 — rule 3 in the module header, and a mirror of
// sendOriginMeta's block in src/lib/ticket-display.test.js. Phase 8 polls a
// connected mailbox's Sent folder, so an outbound row can now be a reply
// somebody typed in Gmail with no CRM author on it. The phase exists to stop
// two people answering one member, and this screen is where the second of them
// would start typing — so it has to be able to say a reply came from outside.
describe('ticketSendOriginMeta (MAILBOX-COEXIST.1)', () => {
  const mailClient = (extra) => ({
    direction: 'outbound',
    is_internal_note: false,
    source: 'mail_client',
    postmark_message_id: null,
    rfc_message_id: 'CAF=9x@mail.gmail.com',
    author_profile_id: null,
    ...extra,
  })

  it('marks a reply sent from someone’s own mail client, in the same words as web', () => {
    const origin = ticketSendOriginMeta(mailClient())
    expect(origin).not.toBeNull()
    expect(origin.source).toBe('mail_client')
    expect(origin.label).toBe('Sent from the mail client')
    expect(origin.detail).toMatch(/cannot say which person/i)
    // An Ionicons name, so the screen can render it without choosing one.
    expect(origin.icon).toBe('open-outline')
  })

  it('says NOTHING about a reply composed in the CRM', () => {
    expect(ticketSendOriginMeta(mailClient({ source: 'operator' }))).toBeNull()
    // Every outbound row written before Phase 8 stamped a source.
    expect(ticketSendOriginMeta(mailClient({ source: null }))).toBeNull()
    expect(ticketSendOriginMeta(mailClient({ source: undefined }))).toBeNull()
  })

  it('says nothing about inbound mail or an internal note', () => {
    expect(ticketSendOriginMeta({ direction: 'inbound', source: 'mail_client' })).toBeNull()
    expect(ticketSendOriginMeta(mailClient({ is_internal_note: true }))).toBeNull()
  })

  it('does not throw on a malformed row', () => {
    expect(ticketSendOriginMeta(null)).toBeNull()
    expect(ticketSendOriginMeta({})).toBeNull()
  })
})

describe('status', () => {
  it('keeps all four lifecycle states, closing included', () => {
    expect(TICKET_STATUS_ORDER).toEqual(['open', 'pending', 'solved', 'closed'])
  })

  it('uses the light-theme chip recipe on every known status', () => {
    for (const s of TICKET_STATUS_ORDER) {
      const { cls, text } = ticketStatusMeta(s)
      expect(cls).toMatch(/^bg-[a-z]+-500\/10$/)
      expect(text).toMatch(/^text-[a-z]+-700$/)
    }
  })

  it('falls back readably on an unknown status', () => {
    expect(ticketStatusMeta('exploded').label).toBe('exploded')
    expect(ticketStatusMeta('exploded').text).toBe('text-slate-700')
    expect(ticketStatusMeta(undefined).label).toBe('Unknown')
  })

  it('treats solved and closed as archived', () => {
    expect(isArchivedStatus('solved')).toBe(true)
    expect(isArchivedStatus('closed')).toBe(true)
    expect(isArchivedStatus('open')).toBe(false)
    expect(isArchivedStatus('pending')).toBe(false)
  })
})

describe('views', () => {
  // The route 400s on anything outside this set, and an absent param is the
  // live queue — so the default view MUST send no param at all.
  const WIRE_WHITELIST = ['unassigned', 'mine', 'needs_reply', 'closed']

  it('only ever puts a route-whitelisted value on the wire', () => {
    for (const v of TICKET_VIEW_TABS) {
      if (v.wire === null) continue
      expect(WIRE_WHITELIST).toContain(v.wire)
    }
  })

  it('sends no view param for the default (live) queue', () => {
    expect(DEFAULT_TICKET_VIEW).toBe('open')
    expect(ticketViewWire(DEFAULT_TICKET_VIEW)).toBeNull()
    expect(TICKET_VIEW_TABS.filter(v => v.wire === null)).toHaveLength(1)
  })

  it('gives every view its own empty copy — an empty queue must say which one', () => {
    const titles = TICKET_VIEW_TABS.map(v => v.emptyTitle)
    expect(new Set(titles).size).toBe(titles.length)
    for (const v of TICKET_VIEW_TABS) {
      expect(v.label.length).toBeGreaterThan(0)
      expect(v.emptyBody.length).toBeGreaterThan(0)
    }
  })

  it('falls back to the live queue rather than undefined on a junk id', () => {
    expect(ticketViewTab('nonsense').id).toBe('open')
    expect(ticketViewWire(undefined)).toBeNull()
  })

  it('labels the archive "Closed" while the wire word covers solved too', () => {
    expect(ticketViewTab('closed').wire).toBe('closed')
    expect(ticketViewTab('closed').label).toBe('Closed')
  })
})

describe('requesterLabel', () => {
  it('prefers the name, falls back to the address', () => {
    expect(requesterLabel({ requester_name: 'Ada', requester_email: 'ada@x.com' })).toBe('Ada')
    expect(requesterLabel({ requester_email: 'ada@x.com' })).toBe('ada@x.com')
    expect(requesterLabel({})).toBe('Unknown sender')
    expect(requesterLabel(null)).toBe('Unknown sender')
  })
})

describe('mailboxLabel', () => {
  it('prefers the label, then the address', () => {
    expect(mailboxLabel({ label: 'Accounts', address: 'accounts@x.com' })).toBe('Accounts')
    expect(mailboxLabel({ address: 'sales@x.com' })).toBe('sales@x.com')
    expect(mailboxLabel({})).toBe('Mailbox')
  })

  it('names the orphaned case rather than rendering nothing', () => {
    // mailbox_id is ON DELETE SET NULL — an elevated caller still sees the
    // correspondence of a deleted address.
    expect(mailboxLabel(null)).toBe('No mailbox')
  })
})

describe('ticketToInboxRow', () => {
  const base = {
    id: 't1',
    status: 'open',
    subject: 'Membership question',
    requester_name: 'Ada Lovelace',
    requester_email: 'ada@x.com',
    last_message_at: '2026-08-07T10:00:00Z',
    last_message_direction: 'inbound',
    last_message_preview: 'Can I freeze?',
    unread_count: 2,
    mailbox_id: 'mb1',
  }

  it('carries the fields the merged Messages list renders', () => {
    const row = ticketToInboxRow(base)
    expect(row).toMatchObject({
      id: 't1',
      channel: 'email',
      status: 'open',
      subject: 'Membership question',
      last_message_direction: 'inbound',
      last_message_preview: 'Can I freeze?',
      unread_count: 2,
    })
  })

  it('never carries a pending approval — there is no agent on email', () => {
    expect(ticketToInboxRow(base).pending_approval).toBe(false)
  })

  it('leaves an open ticket unresolved so it lands in the needs-reply queue', () => {
    expect(ticketToInboxRow(base).resolved_at).toBeNull()
    expect(ticketToInboxRow({ ...base, status: 'pending' }).resolved_at).toBeNull()
  })

  it('maps solved/closed onto resolved_at so an archived ticket never reads as needing a reply', () => {
    expect(ticketToInboxRow({ ...base, status: 'solved', solved_at: 'S' }).resolved_at).toBe('S')
    expect(ticketToInboxRow({ ...base, status: 'closed', closed_at: 'C' }).resolved_at).toBe('C')
    // No stamp on disk still has to read as resolved, not as unresolved.
    expect(ticketToInboxRow({ ...base, status: 'closed', updated_at: 'U' }).resolved_at).toBe('U')
  })

  it('falls back to created_at when a ticket has no message yet', () => {
    const row = ticketToInboxRow({ id: 't2', created_at: '2026-01-01T00:00:00Z' })
    expect(row.last_message_at).toBe('2026-01-01T00:00:00Z')
    expect(row.unread_count).toBe(0)
  })

  it('survives a null ticket rather than throwing in a list render', () => {
    expect(ticketToInboxRow(null).channel).toBe('email')
  })
})

describe('ticketsToInboxRows', () => {
  const mailboxes = [
    { id: 'mb1', label: 'Accounts', address: 'accounts@x.com' },
    { id: 'mb2', label: 'Sales', address: 'sales@x.com' },
  ]
  const tickets = [
    { id: 't1', mailbox_id: 'mb1', status: 'open' },
    { id: 't2', mailbox_id: 'mb2', status: 'open' },
  ]

  it('labels each row with the account it arrived at when there is more than one', () => {
    const rows = ticketsToInboxRows({ tickets, mailboxes })
    expect(rows.map(r => r.mailbox_label)).toEqual(['Accounts', 'Sales'])
  })

  it('omits the chip when there is only one account to see', () => {
    const rows = ticketsToInboxRows({ tickets: [tickets[0]], mailboxes: [mailboxes[0]] })
    expect(rows[0].mailbox_label).toBeNull()
  })

  it('says "No mailbox" for an orphaned ticket in a multi-account studio', () => {
    const rows = ticketsToInboxRows({ tickets: [{ id: 't3', mailbox_id: null }], mailboxes })
    expect(rows[0].mailbox_label).toBe('No mailbox')
  })

  it('handles the empty payload a studio with no addresses returns', () => {
    expect(ticketsToInboxRows({})).toEqual([])
    expect(ticketsToInboxRows({ tickets: [], mailboxes: [] })).toEqual([])
  })
})

// EMAIL-DELIVERY.1 — mobile's copy of the delivery rules.
//
// This surface's tests exist because the web and mobile helpers are a
// deliberate RE-STATEMENT, not an import (mobile cannot reach into src/lib).
// A re-statement drifts unless both sides are pinned, and the two rules that
// must never drift are the ones asserted here: NULL says nothing, and a note
// never claims delivery.
describe('ticketDeliveryMeta (EMAIL-DELIVERY.1)', () => {
  const outbound = (extra) => ({ direction: 'outbound', is_internal_note: false, ...extra })

  it('says NOTHING about a message with no provider event yet', () => {
    expect(ticketDeliveryMeta(outbound({ delivery_status: null }))).toBeNull()
    expect(ticketDeliveryMeta(outbound({}))).toBeNull()
    expect(ticketDeliveryMeta(null)).toBeNull()
  })

  it('never claims anything about an internal note or an inbound message', () => {
    expect(ticketDeliveryMeta({ direction: 'outbound', is_internal_note: true, delivery_status: 'delivered' })).toBeNull()
    expect(ticketDeliveryMeta({ direction: 'inbound', delivery_status: 'delivered' })).toBeNull()
  })

  // MAILBOX-CONNECT.7 — web/mobile parity on the SMTP case. The first pass
  // shipped this branch on web only, so the same message read "Not tracked" on
  // a desktop and said nothing on a phone. The header of this section lists the
  // rules that must not diverge; this is one of them.
  it('says NOT TRACKED for an SMTP send, matching web', () => {
    const meta = ticketDeliveryMeta(outbound({
      delivery_status: null, postmark_message_id: null, rfc_message_id: 'a@theirgym.ie',
    }))
    expect(meta).not.toBeNull()
    expect(meta.label).toBe('Not tracked')
    expect(meta.tone).toBe('quiet')
  })

  // 🔴 MAILBOX-COEXIST.1 — THE HONESTY CASE, and rule 3 of the module header.
  // A mail-client row matches the SMTP predicate byte for byte, so without its
  // own branch it would inherit that branch's copy and tell an operator this
  // was sent from the mailbox's own server. Nothing of ours sent it: the
  // poller read a copy of it out of a folder.
  it('does NOT tell an operator a mail-client reply went out over our SMTP', () => {
    const meta = ticketDeliveryMeta(outbound({
      delivery_status: null, source: 'mail_client',
      postmark_message_id: null, rfc_message_id: 'CAF=9x@mail.gmail.com',
    }))
    expect(meta).not.toBeNull()
    expect(meta.detail).not.toMatch(/mailbox.s own server/i)
    expect(meta.detail).not.toMatch(/does not report delivery/i)
  })

  it('says NOT TRACKED for a mail-client reply, in web’s words', () => {
    const meta = ticketDeliveryMeta(outbound({
      delivery_status: null, source: 'mail_client',
      postmark_message_id: null, rfc_message_id: 'CAF=9x@mail.gmail.com',
    }))
    // Same label as the SMTP case deliberately: the delivery fact is identical
    // (nothing known, nothing coming), only the reason differs.
    expect(meta.label).toBe('Not tracked')
    expect(meta.tone).toBe('quiet')
    expect(meta.detail).toMatch(/did not send this/i)
    expect(meta.detail).toMatch(/Sent folder/i)
    expect(meta.detail).toMatch(/none can arrive/i)
  })

  it('reads a mail-client row by its source, not by the shape of its ids', () => {
    const meta = ticketDeliveryMeta(outbound({
      delivery_status: null, source: 'mail_client',
      postmark_message_id: null, rfc_message_id: null,
    }))
    expect(meta?.label).toBe('Not tracked')
  })

  // Both orderings the branch rests on: below the status branches, above the
  // SMTP one. Nothing else would notice if it moved.
  it('keeps a real outcome on a mail-client row, and beats the SMTP branch', () => {
    expect(ticketDeliveryMeta(outbound({
      delivery_status: 'bounced', source: 'mail_client',
      postmark_message_id: null, rfc_message_id: 'a@b.com',
    })).label).toBe('Not delivered')

    expect(ticketDeliveryMeta(outbound({
      delivery_status: null, source: 'mail_client',
      postmark_message_id: null, rfc_message_id: 'a@b.com',
    })).detail).toMatch(/did not send this/i)
  })

  it('does not invent provenance for a row carrying neither id', () => {
    // Keying on the missing Postmark id alone would also match the whole
    // back-catalogue and the degraded-sender path, and tell the operator those
    // went out over SMTP. Saying nothing is the honest answer.
    expect(ticketDeliveryMeta(outbound({
      delivery_status: null, postmark_message_id: null, rfc_message_id: null,
    }))).toBeNull()
  })

  it('renders a delivery quietly — no panel classes at all', () => {
    const m = ticketDeliveryMeta(outbound({ delivery_status: 'delivered' }))
    expect(m).toMatchObject({ tone: 'quiet', label: 'Delivered' })
    expect(m.cls).toBeUndefined()
    expect(m.headline).toBeUndefined()
  })

  it('renders a bounce loudly, with the light-theme chip ramp and an icon', () => {
    const m = ticketDeliveryMeta(outbound({
      delivery_status: 'bounced', delivery_bounce_type: 'hard', delivery_detail: 'User unknown',
    }))
    expect(m.tone).toBe('alarm')
    expect(m.headline).toMatch(/never got this reply/i)
    expect(m.detail).toBe('User unknown')
    // RN does not inherit text colour through a View, so background and
    // foreground are separate — never the -300/-400 ramp.
    expect(m.cls).toContain('bg-red-500/10')
    expect(m.text).toBe('text-red-700')
    expect(m.icon).toBeTruthy()
  })

  it('gives hard and soft bounces different advice', () => {
    const hard = ticketDeliveryMeta(outbound({ delivery_status: 'bounced', delivery_bounce_type: 'hard' }))
    const soft = ticketDeliveryMeta(outbound({ delivery_status: 'bounced', delivery_bounce_type: 'soft' }))
    expect(hard.advice).not.toBe(soft.advice)
    expect(soft.advice).toMatch(/mailbox full/i)
  })

  it('treats a spam complaint as its own problem, not as non-delivery', () => {
    const m = ticketDeliveryMeta(outbound({ delivery_status: 'complained' }))
    expect(m.tone).toBe('warn')
    expect(m.text).toBe('text-amber-700')
    expect(m.headline).not.toMatch(/never got/i)
  })

  it('says nothing about an unrecognised status', () => {
    expect(ticketDeliveryMeta(outbound({ delivery_status: 'opened' }))).toBeNull()
  })
})

// ── EMAIL-CC.1 — recipient lines on mobile ───────────────────────────
//
// Mobile SHOWS recipients and does not edit them: the reply box posts
// `{ text, internal }`, so the server derives everybody on the thread and a
// mobile reply on a multi-party thread is automatically a reply-all. What this
// screen must get right is the RENDERING, and specifically that a Bcc line is
// never mistaken for something the other recipients could see.
describe('ticketMessageRecipients', () => {
  // MOBILE-ENV.1 — the two bubbles carry DIFFERENT headers, and the old rule
  // was written as though they carried the same one.
  it('shows a single To on the INBOUND bubble — its header names the sender, not us', () => {
    const [line] = ticketMessageRecipients({ to_emails: ['ada@example.com'] })
    expect(line).toMatchObject({ key: 'to', label: 'To', staffOnly: false })
    expect(line.addresses).toEqual(['ada@example.com'])
  })

  it('omits a single To on the OUTBOUND bubble — "Sent to …" already names it in full', () => {
    expect(ticketMessageRecipients({ to_emails: ['ada@example.com'] }, { toShownInHeader: true }))
      .toEqual([])
  })

  it('shows the To on the OUTBOUND bubble once the header can only name the first', () => {
    const [line] = ticketMessageRecipients(
      { to_emails: ['ada@x.com', 'bob@x.com'] },
      { toShownInHeader: true },
    )
    expect(line).toMatchObject({ key: 'to', label: 'To', staffOnly: false })
    expect(line.addresses).toEqual(['ada@x.com', 'bob@x.com'])
  })

  it('shows the member’s Cc — the reason inbound capture exists', () => {
    const lines = ticketMessageRecipients({ to_emails: ['a@x.com'], cc_emails: ['bob@x.com'] })
    const line = lines.find(l => l.key === 'cc')
    expect(line).toMatchObject({ key: 'cc', staffOnly: false })
    expect(line.addresses).toEqual(['bob@x.com'])
  })

  it('marks Bcc staffOnly so the screen can say no recipient could see it', () => {
    const lines = ticketMessageRecipients({ to_emails: ['a@x.com'], bcc_emails: ['secret@x.com'] })
    expect(lines.find(l => l.key === 'bcc')).toMatchObject({ key: 'bcc', staffOnly: true })
  })

  it('reads the scalar to_email on a row written before mig 499', () => {
    const [line] = ticketMessageRecipients({ to_email: 'a@x.com', cc_emails: ['b@x.com'] })
    expect(line).toMatchObject({ key: 'to' })
    expect(line.addresses).toEqual(['a@x.com'])
  })

  // EMAIL-PARTICIPANTS.12 — a NON-EMPTY array of nothing is still nothing.
  // Every reader of this field filters before measuring; this one always did,
  // and now says so out loud.
  it('takes the scalar fallback for a to_emails array holding nothing usable', () => {
    const [line] = ticketMessageRecipients({ to_emails: [null], to_email: 'a@x.com' })
    expect(line.addresses).toEqual(['a@x.com'])
  })

  it('omits empty lists rather than rendering a blank Cc', () => {
    expect(ticketMessageRecipients({ to_emails: ['a@x.com'], cc_emails: [], bcc_emails: [] }))
      .toEqual([{ key: 'to', label: 'To', addresses: ['a@x.com'], staffOnly: false }])
    expect(ticketMessageRecipients({ to_emails: [], cc_emails: [], bcc_emails: [] })).toEqual([])
    expect(ticketMessageRecipients(null)).toEqual([])
  })
})

// ── MOBILE-ENV.1 — the outbound bubble's "Sent to …" header ───────────
//
// The reply route writes `to_email: recipients.to[0]` and `to_emails:
// recipients.to`, so the scalar is the FIRST recipient, not the audience. The
// bubble rendered the scalar, which on a four-person reply read "Sent to
// alice@x.com" — one name for a reply that reached four. Nothing was hidden
// (the To line below listed them all) but the header contradicted it.
describe('sentToLabel', () => {
  it('names the one recipient when there is only one', () => {
    expect(sentToLabel({ to_emails: ['ada@x.com'] })).toBe('ada@x.com')
  })

  it('says how many more there are rather than naming only the first', () => {
    expect(sentToLabel({ to_emails: ['ada@x.com', 'bob@x.com', 'cara@x.com', 'dan@x.com'] }))
      .toBe('ada@x.com +3 more')
  })

  it('reads the scalar to_email on a pre-mig-499 row', () => {
    expect(sentToLabel({ to_email: 'ada@x.com' })).toBe('ada@x.com')
  })

  it('takes the scalar fallback for a to_emails array holding nothing usable', () => {
    expect(sentToLabel({ to_emails: [null], to_email: 'ada@x.com' })).toBe('ada@x.com')
  })

  it('falls back to the generic phrase rather than rendering "Sent to "', () => {
    expect(sentToLabel({})).toBe('the member')
    expect(sentToLabel(null)).toBe('the member')
    expect(sentToLabel({ to_emails: [null] })).toBe('the member')
  })
})

// ── Reply audience (EMAIL-PARTICIPANTS.9) ─────────────────────────────
//
// GET .../[id] now derives the reply audience from the WHOLE thread
// (reply_recipients = { to, mode, over_cap, empty } — the same shape
// TicketReplyBox.jsx reads on web). Before this, mobile's composer footer
// said "Sends an email to <requester>" unconditionally, even though a reply
// from this screen has always reached everyone the server derives (the file
// header's RECIPIENTS note — mobile posts { text, internal } only). That
// understated the true audience on every multi-party thread, a known
// standing defect as of the 2026-08-09 audit.
describe('ticketReplyAudienceMeta (EMAIL-PARTICIPANTS.9)', () => {
  const ticket = (extra) => ({ requester_email: 'ada@x.com', ...extra })
  const audience = (to, extra) => ({ to, mode: to.length > 1 ? 'reply_all' : 'reply', over_cap: false, empty: false, ...extra })

  it('names the one recipient on a one-person thread', () => {
    const m = ticketReplyAudienceMeta(ticket(), audience(['ada@x.com']))
    expect(m).toEqual({ disabled: false, text: 'Sends an email to ada@x.com' })
  })

  it('names the first and counts the rest on a wider thread — the first is the live counterparty, server-ordered', () => {
    const m = ticketReplyAudienceMeta(ticket(), audience(['bob@x.com', 'ada@x.com', 'carol@x.com']))
    expect(m).toEqual({ disabled: false, text: 'Sends an email to bob@x.com and 2 others' })
  })

  it('says "1 other" rather than "1 others" for exactly two people', () => {
    const m = ticketReplyAudienceMeta(ticket(), audience(['bob@x.com', 'ada@x.com']))
    expect(m.text).toBe('Sends an email to bob@x.com and 1 other')
  })

  it('names where replies land when the ticket has a mailbox', () => {
    const m = ticketReplyAudienceMeta(
      ticket({ mailbox: { address: 'accounts@x.com' } }),
      audience(['ada@x.com']),
    )
    expect(m.text).toBe('Sends an email to ada@x.com · replies come back to accounts@x.com')
  })

  it('disables send and says there is nobody to reply to once every recipient has been removed', () => {
    const m = ticketReplyAudienceMeta(ticket(), audience([], { empty: true }))
    expect(m).toEqual({
      disabled: true,
      text: 'Every recipient has been removed from this thread, so there is nobody to reply to. '
        + 'You can still add an internal note.',
    })
  })

  it('disables send and explains the recipient cap — an enabled button here would be a dead click (the route 400s)', () => {
    const wide = Array.from({ length: 30 }, (_, i) => `p${i}@x.com`)
    const m = ticketReplyAudienceMeta(ticket(), audience(wide, { mode: 'reply_all', over_cap: true }))
    expect(m).toEqual({
      disabled: true,
      text: 'This thread has 30 recipients — too many for one reply. Remove some on the web before replying.',
    })
  })

  it('disables send when the ticket has no requester address, regardless of what reply_recipients says', () => {
    const m = ticketReplyAudienceMeta(ticket({ requester_email: null }), audience(['ada@x.com']))
    expect(m.disabled).toBe(true)
    expect(m.text).toBe(
      'This ticket has no requester address, so it cannot be replied to. You can still add an internal note.',
    )
  })

  it('falls back to the requester address when the route could not derive one (null) — same as web', () => {
    const m = ticketReplyAudienceMeta(ticket(), null)
    expect(m).toEqual({ disabled: false, text: 'Sends an email to ada@x.com' })
  })

  it('never invents an over_cap/empty refusal off a null reply_recipients', () => {
    // null means "we don't know", not "we checked and it's fine" — but it must
    // ALSO not be misread as a refusal. The one-person fallback above is the
    // only safe reading, same as TicketReplyBox.jsx's lockedTo on web.
    expect(ticketReplyAudienceMeta(ticket(), null).disabled).toBe(false)
  })
})

// ── The screen's OTHER two requester_email sites (EMAIL-PARTICIPANTS.12) ──
//
// EMAIL-PARTICIPANTS.9 moved mobile's composer FOOTER onto the real audience
// and left the two most prominent strings on the screen still reading
// `ticket.requester_email` raw: the header line under the ticket subject, and
// the composer's own placeholder. Web changed both in .8, citing this exact
// defect. On the 2026-08-12 ticket that left the phone saying "Reply to
// ratesoffice@dublincity.ie" in the box an operator types into, directly above
// a footer saying the mail goes to Eleanor and one other — the composer
// contradicting itself in two adjacent lines.
//
// MOBILE STAYS READ-ONLY. These describe the audience the server settled on;
// there is no remove/restore on this screen and these add none.
describe('ticketReplyPlaceholder (EMAIL-PARTICIPANTS.12)', () => {
  const ticket = (extra) => ({ requester_email: 'rates@council.ie', ...extra })
  const audience = (to, extra) => ({ to, mode: to.length > 1 ? 'reply_all' : 'reply', over_cap: false, empty: false, ...extra })

  it('names the live counterparty, not the address the ticket arrived from', () => {
    const p = ticketReplyPlaceholder(ticket(), audience(['eleanor@council.ie', 'rates@council.ie']))
    expect(p).toBe('Reply to eleanor@council.ie and 1 other…')
  })

  it('names the only recipient on a one-person thread', () => {
    expect(ticketReplyPlaceholder(ticket(), audience(['rates@council.ie'])))
      .toBe('Reply to rates@council.ie…')
  })

  it('says "others" once there are more than two', () => {
    expect(ticketReplyPlaceholder(ticket(), audience(['a@x.com', 'b@x.com', 'c@x.com'])))
      .toBe('Reply to a@x.com and 2 others…')
  })

  // The same rule TicketReplyBox.jsx's lockedTo enforces on web: an emptied
  // audience must never put the removed person back into a prompt, because the
  // route would refuse the send to them.
  it('names NOBODY once every recipient has been removed', () => {
    const p = ticketReplyPlaceholder(ticket(), audience([], { empty: true }))
    expect(p).toBe('Reply…')
    expect(p).not.toContain('rates@council.ie')
  })

  it('falls back to the requester when the route derived no audience (null)', () => {
    expect(ticketReplyPlaceholder(ticket(), null)).toBe('Reply to rates@council.ie…')
  })

  it('says a ticket with no requester address cannot be replied to at all', () => {
    expect(ticketReplyPlaceholder(ticket({ requester_email: null }), audience(['a@x.com'])))
      .toBe('No requester address — add an internal note instead')
  })
})

describe('ticketThreadAudienceLines (EMAIL-PARTICIPANTS.12)', () => {
  const ticket = (extra) => ({
    requester_email: 'rates@council.ie', requester_name: 'Rates Office', ...extra,
  })
  const audience = (to, extra) => ({ to, mode: to.length > 1 ? 'reply_all' : 'reply', over_cap: false, empty: false, ...extra })

  it('names the live audience in the header, with the requester demoted to "Opened by"', () => {
    const lines = ticketThreadAudienceLines(
      ticket(), audience(['eleanor@council.ie', 'rates@council.ie']),
    )
    expect(lines).toEqual({
      primary: 'On this thread: eleanor@council.ie, Rates Office <rates@council.ie>',
      opener: 'Opened by Rates Office <rates@council.ie>',
    })
  })

  it('says nothing about who opened it while the requester is still the counterparty', () => {
    const lines = ticketThreadAudienceLines(ticket(), audience(['rates@council.ie', 'clerk@council.ie']))
    expect(lines.primary).toBe('On this thread: Rates Office <rates@council.ie>, clerk@council.ie')
    expect(lines.opener).toBeNull()
  })

  // Two different places wrote these addresses — a stored column and headers a
  // stranger's mail client produced — so a case difference is not a change of
  // counterparty and must not be announced as one.
  it('does not call a case difference a change of counterparty', () => {
    expect(ticketThreadAudienceLines(ticket(), audience(['Rates@Council.IE'])).opener).toBeNull()
  })

  it('never names the removed requester once the audience is empty', () => {
    const lines = ticketThreadAudienceLines(ticket(), audience([], { empty: true }))
    expect(lines.primary).toBe('Nobody is left on this thread — every recipient was removed.')
    expect(lines.primary).not.toContain('rates@council.ie')
    expect(lines.opener).toBeNull()
  })

  it('keeps the plain requester line when the route derived no audience (null)', () => {
    // Not an operator act — an own-address lookup blip. The requester address
    // is the honest answer, and it is what this line has always shown.
    expect(ticketThreadAudienceLines(ticket(), null))
      .toEqual({ primary: 'rates@council.ie', opener: null })
  })

  it('still says so when the ticket has no requester address', () => {
    expect(ticketThreadAudienceLines(ticket({ requester_email: null }), null))
      .toEqual({ primary: 'No requester address', opener: null })
  })
})

// ── Attachments (EMAIL-ATTACH-PREVIEW.1) ────────────────────────────
//
// These are the two strings mobile duplicates from the web helpers, plus the
// icon picker. Tested here because a phone showing "0 B" or a blank reason for
// a file a member definitely sent is exactly the "we never got it" conversation
// the whole not-stored ROW exists to prevent.

describe('formatAttachmentSize', () => {
  it('matches the web helper on the sizes that actually turn up', () => {
    expect(formatAttachmentSize(0)).toBe('0 B')
    expect(formatAttachmentSize(512)).toBe('512 B')
    expect(formatAttachmentSize(1024)).toBe('1.0 KB')
    expect(formatAttachmentSize(2_100_000)).toBe('2.0 MB')
    expect(formatAttachmentSize(26_214_400)).toBe('25 MB')
  })

  it('never renders a negative, absent or nonsense size as a number', () => {
    for (const bad of [null, undefined, -1, NaN, Infinity, 'x', {}]) {
      expect(formatAttachmentSize(bad)).toBe('0 B')
    }
  })
})

describe('ticketAttachmentSkippedLabel', () => {
  it('names every reason the DB allows, in words staff can act on', () => {
    expect(ticketAttachmentSkippedLabel('quota')).toMatch(/full/i)
    expect(ticketAttachmentSkippedLabel('too_large')).toMatch(/size limit/i)
    // Its own sentence rather than folded into too_large: staff ACT on this,
    // and "over the size limit" would send them asking a member to compress a
    // file that was never oversized.
    expect(ticketAttachmentSkippedLabel('too_many')).toMatch(/too many files/i)
    expect(ticketAttachmentSkippedLabel('rehost_failed')).toMatch(/upload failed/i)
    expect(ticketAttachmentSkippedLabel('pruned')).toMatch(/free space/i)
  })

  it('still says SOMETHING for an unknown reason — never an empty chip', () => {
    expect(ticketAttachmentSkippedLabel('invented')).toBe('Not stored')
    expect(ticketAttachmentSkippedLabel(null)).toBe('Not stored')
  })
})

describe('ticketAttachmentIcon', () => {
  it('reads the type first', () => {
    expect(ticketAttachmentIcon('image/jpeg', 'x.jpg')).toBe('image-outline')
    expect(ticketAttachmentIcon('application/pdf', 'x.pdf')).toBe('document-text-outline')
    expect(ticketAttachmentIcon('text/csv', 'members.csv')).toBe('grid-outline')
    // A .png name on a PDF must not turn it into a photo.
    expect(ticketAttachmentIcon('application/pdf', 'invoice.png')).toBe('document-text-outline')
  })

  it('falls back to the filename when the type says nothing', () => {
    // The real .pptx MIME subtype is 61 characters and safeMimeType caps a
    // subtype at 60, so every PowerPoint deck is stored as octet-stream.
    expect(ticketAttachmentIcon('application/octet-stream', 'Q3 deck.pptx')).toBe('easel-outline')
    expect(ticketAttachmentIcon('application/octet-stream', 'photos.zip')).toBe('archive-outline')
    expect(ticketAttachmentIcon('application/octet-stream', 'letter.docx')).toBe('document-outline')
  })

  it('always returns a glyph, never undefined', () => {
    expect(ticketAttachmentIcon(null, null)).toBe('attach-outline')
    expect(ticketAttachmentIcon('', 'noextension')).toBe('attach-outline')
    expect(ticketAttachmentIcon(undefined, undefined)).toBe('attach-outline')
  })
})

// EMAIL-ATTACH-RACE.1 — mobile's copy of the thread re-read cadence. The
// numbers must match web (src/lib/ticket-display.js): an operator watching one
// ticket on a phone and a laptop should not see one of them catch up first.
describe('threadRefreshMs', () => {
  const NOW = Date.parse('2026-08-07T21:00:00.000Z')
  const at = (iso) => [{ id: 'm1', created_at: iso }]

  it('polls fast while the newest message is still settling', () => {
    expect(threadRefreshMs(at('2026-08-07T20:59:58.000Z'), NOW)).toBe(THREAD_SETTLE_MS)
  })

  it('drops to the steady cadence once nothing is recent', () => {
    expect(threadRefreshMs(at('2026-08-07T20:00:00.000Z'), NOW)).toBe(THREAD_STEADY_MS)
  })

  it('treats the settle window as exclusive at its far edge', () => {
    const justInside = new Date(NOW - THREAD_SETTLE_WINDOW_MS + 1).toISOString()
    const exactlyOut = new Date(NOW - THREAD_SETTLE_WINDOW_MS).toISOString()
    expect(threadRefreshMs(at(justInside), NOW)).toBe(THREAD_SETTLE_MS)
    expect(threadRefreshMs(at(exactlyOut), NOW)).toBe(THREAD_STEADY_MS)
  })

  it('treats a future timestamp as brand new rather than ancient', () => {
    expect(threadRefreshMs(at('2026-08-07T21:00:30.000Z'), NOW)).toBe(THREAD_SETTLE_MS)
  })

  it('uses the steady cadence for an empty or unparseable thread', () => {
    expect(threadRefreshMs([], NOW)).toBe(THREAD_STEADY_MS)
    expect(threadRefreshMs(at('not a date'), NOW)).toBe(THREAD_STEADY_MS)
  })

  it('finds the newest message wherever it sits in the array', () => {
    const rows = [
      { id: 'b', created_at: '2026-08-07T20:59:59.000Z' },
      { id: 'a', created_at: '2026-08-07T18:00:00.000Z' },
    ]
    expect(newestMessageAt(rows)).toBe(Date.parse('2026-08-07T20:59:59.000Z'))
    expect(threadRefreshMs(rows, NOW)).toBe(THREAD_SETTLE_MS)
  })

  // The two platforms are separate statements of one rule (mobile cannot
  // import src/lib). Drift is the failure mode, so it is asserted here.
  it('agrees with the web constants', () => {
    expect([THREAD_SETTLE_MS, THREAD_STEADY_MS, THREAD_SETTLE_WINDOW_MS])
      .toEqual([5_000, 60_000, 120_000])
  })
})

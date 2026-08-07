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
  ticketDeliveryMeta,
  requesterLabel,
  mailboxLabel,
  ticketToInboxRow,
  ticketsToInboxRows,
  formatAttachmentSize,
  ticketAttachmentSkippedLabel,
  ticketAttachmentIcon,
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

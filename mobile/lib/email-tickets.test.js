import { describe, it, expect } from 'vitest'
import {
  TICKET_STATUS_ORDER,
  ticketStatusMeta,
  isArchivedStatus,
  ticketMessageKind,
  requesterLabel,
  mailboxLabel,
  ticketToInboxRow,
  ticketsToInboxRows,
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

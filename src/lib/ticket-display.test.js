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
  requesterLabel,
  initialsOf,
  assigneeLabel,
  mailboxLabel,
  NO_MAILBOX_EMPTY,
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

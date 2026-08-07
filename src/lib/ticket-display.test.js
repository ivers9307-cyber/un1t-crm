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
  messageRecipients,
  replyActionLabel,
  deliveryMeta,
  deliveryTimestamp,
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

// EMAIL-DELIVERY.1 — the three outcomes and the silence.
//
// The silence is the one that gets broken by accident: `delivery_status` is
// NULL on every message sent before mig 498, on every message the instant it
// goes out, and forever on any message whose webhook never arrives. Rendering
// it as either "delivered" or "failed" would be a lie in one direction or the
// other, and the second one is the lie this whole feature exists to stop.
describe('deliveryMeta (EMAIL-DELIVERY.1)', () => {
  const outbound = (extra) => ({ direction: 'outbound', is_internal_note: false, ...extra })

  it('says NOTHING about a message with no provider event yet', () => {
    expect(deliveryMeta(outbound({ delivery_status: null }))).toBeNull()
    expect(deliveryMeta(outbound({}))).toBeNull()
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

// ── EMAIL-CC.1 — recipient lines and the button label ────────────────
describe('messageRecipients', () => {
  it('omits a single To — the bubble already says "Sent to …"', () => {
    expect(messageRecipients({ to_emails: ['ada@example.com'] })).toEqual([])
  })

  it('shows a To line once there is more than one recipient', () => {
    const [line] = messageRecipients({ to_emails: ['ada@example.com', 'bob@example.com'] })
    expect(line).toMatchObject({ key: 'to', label: 'To', staffOnly: false })
    expect(line.addresses).toEqual(['ada@example.com', 'bob@example.com'])
  })

  it('shows Cc, which every recipient of the email could see', () => {
    const lines = messageRecipients({ to_emails: ['ada@x.com'], cc_emails: ['bob@x.com'] })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ key: 'cc', staffOnly: false })
  })

  // BCC MUST BE MARKED. Rendered beside To and Cc with no distinction it
  // implies the other recipients saw it. They did not, and never will.
  it('marks Bcc staffOnly and explains why', () => {
    const [line] = messageRecipients({ to_emails: ['a@x.com'], bcc_emails: ['secret@x.com'] })
    expect(line).toMatchObject({ key: 'bcc', staffOnly: true })
    expect(line.note).toMatch(/only staff/i)
  })

  it('reads the scalar to_email on a row written before mig 499', () => {
    expect(messageRecipients({ to_email: 'ada@x.com' })).toEqual([])
    const [line] = messageRecipients({ to_email: 'ada@x.com', cc_emails: ['bob@x.com'] })
    expect(line.key).toBe('cc')
  })

  it('omits empty lists rather than rendering a blank Cc', () => {
    expect(messageRecipients({ to_emails: ['a@x.com'], cc_emails: [], bcc_emails: [] })).toEqual([])
    expect(messageRecipients(null)).toEqual([])
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

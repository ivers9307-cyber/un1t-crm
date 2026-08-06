// EMAIL-TICKET.4 — pure presentation rules for the email ticket inbox.
// Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
//
// WHY THIS IS A LIB AND NOT INLINE JSX
// Three of the decisions this surface makes are the kind that get quietly
// wrong in a component and are then invisible until an operator is looking at
// the wrong thing:
//
//   1. WHICH `view` STRING GOES ON THE WIRE. The route accepts exactly
//      unassigned | mine | needs_reply | closed and 400s on anything else, and
//      the default view sends NO param at all (open + pending). The tab the
//      operator sees and the string the API accepts are not the same
//      vocabulary — "Closed" is labelled for humans, `closed` is the wire word
//      that actually returns solved AND closed.
//   2. WHETHER A MESSAGE IS AN INTERNAL NOTE. A note is stored with
//      direction='outbound', so "is it ours?" and "was it sent?" are different
//      questions. Getting that backwards shows staff-only text as if it went
//      to the member — the one mistake this surface must never make.
//   3. THE STATUS CHIP RECIPE. Light theme, -700 text ramp (CLAUDE.md); a
//      washed-out chip has shipped and been operator-reported before.
//
// Pure: no DOM, no fetch, no clock (callers pass `now`). Tested in
// ticket-display.test.js.

// ── Views ────────────────────────────────────────────────────────────
//
// `wire` is what goes in ?view=. null means "send no view param" — the route
// treats an absent view as the live queue (open + pending), which is the
// default the operator lands on. Every other value here is one of the four
// the route whitelists; anything else is a 400.
export const TICKET_VIEWS = Object.freeze([
  {
    id: 'open',
    label: 'Open',
    wire: null,
    hint: 'Open and pending — the live queue',
    emptyTitle: 'Queue clear',
    emptyDescription: 'Nothing is open or waiting on a member reply right now.',
  },
  {
    id: 'unassigned',
    label: 'Unassigned',
    wire: 'unassigned',
    hint: 'Open tickets nobody has picked up',
    emptyTitle: 'Nothing unassigned',
    emptyDescription: 'Every open ticket here already has someone on it.',
  },
  {
    id: 'mine',
    label: 'Mine',
    wire: 'mine',
    hint: 'Open and pending tickets assigned to you',
    emptyTitle: 'Nothing assigned to you',
    emptyDescription: 'Tickets assigned to you will show up here.',
  },
  {
    id: 'needs_reply',
    label: 'Needs reply',
    wire: 'needs_reply',
    hint: 'Open, and the last word was theirs',
    emptyTitle: 'Nobody is waiting on us',
    emptyDescription: 'Every open ticket has been answered — the ball is with the member.',
  },
  {
    // Labelled "Closed" but the wire word returns solved AND closed. The
    // label is deliberately the shorter of the two: an operator looking for
    // "the archive" looks for Closed.
    id: 'closed',
    label: 'Closed',
    wire: 'closed',
    hint: 'Solved and closed tickets',
    emptyTitle: 'Nothing closed yet',
    emptyDescription: 'Tickets you solve or close are archived here.',
  },
])

export const DEFAULT_VIEW_ID = 'open'

/** The view descriptor for an id, falling back to the default rather than undefined. */
export function ticketView(id) {
  return TICKET_VIEWS.find(v => v.id === id) || TICKET_VIEWS[0]
}

/** The ?view= value for a view id — null when the param must be omitted. */
export function viewWireValue(id) {
  return ticketView(id).wire
}

/**
 * The queue URL for a (location, mailbox, view) triple.
 *
 * Centralised so the "omit `view` for the default" rule and the encoding live
 * in one tested place instead of a template literal in a component.
 */
export function buildTicketsUrl({ locationId, mailboxId, viewId } = {}) {
  const params = new URLSearchParams()
  if (locationId) params.set('location_id', locationId)
  if (mailboxId) params.set('mailbox_id', mailboxId)
  const wire = viewWireValue(viewId)
  if (wire) params.set('view', wire)
  return `/api/email/tickets?${params.toString()}`
}

// ── Status + priority ────────────────────────────────────────────────
//
// Chips follow the light-theme idiom: bg-<c>-500/10 text-<c>-700. Never the
// -300/-400 ramp (unreadable on a light card) and never the dark-theme recipe
// — `check:guardrails` fails the build on both.
export const STATUS_META = Object.freeze({
  open: {
    label: 'Open',
    chip: 'bg-blue-500/10 text-blue-700',
    hint: 'Needs the studio',
  },
  pending: {
    label: 'Pending',
    chip: 'bg-amber-500/10 text-amber-700',
    hint: 'Replied — waiting on the member',
  },
  solved: {
    label: 'Solved',
    chip: 'bg-green-500/10 text-green-700',
    hint: 'Handled — a member reply reopens it',
  },
  closed: {
    label: 'Closed',
    chip: 'bg-slate-500/10 text-slate-700',
    hint: 'Done — a member reply starts a new ticket',
  },
})

// The lifecycle in the order an operator walks it. Rendered as a segmented
// control on the open ticket, all four always visible: NOTHING in this system
// closes itself (Richard, 2026-08-06), so closing has to be one click from
// the thread rather than something buried in a menu.
export const STATUS_ORDER = Object.freeze(['open', 'pending', 'solved', 'closed'])

export function statusMeta(status) {
  return STATUS_META[status] || { label: status || 'Unknown', chip: 'bg-slate-500/10 text-slate-700', hint: '' }
}

/** Solved and closed are the archived half of the lifecycle. */
export function isArchivedStatus(status) {
  return status === 'solved' || status === 'closed'
}

export const PRIORITY_META = Object.freeze({
  high: { label: 'High', chip: 'bg-red-500/10 text-red-700' },
  low: { label: 'Low', chip: 'bg-slate-500/10 text-slate-700' },
})

/** Priority chip, or null for `normal` — the default is not worth a chip. */
export function priorityMeta(priority) {
  return PRIORITY_META[priority] || null
}

// ── Messages ─────────────────────────────────────────────────────────
/**
 * How a thread message must be rendered.
 *
 * THE ORDER OF THESE CHECKS IS THE SAFETY PROPERTY. An internal note is
 * written with direction='outbound' (the reply route, EMAIL-TICKET.4), so
 * testing direction first would paint a staff-only note in the same colours
 * as a real sent reply. `is_internal_note` wins, always.
 *
 * @returns {'note'|'outbound'|'inbound'}
 */
export function messageKind(message) {
  if (!message) return 'inbound'
  if (message.is_internal_note) return 'note'
  return message.direction === 'outbound' ? 'outbound' : 'inbound'
}

// ── Labels ───────────────────────────────────────────────────────────
/** Who wrote in: their name if we have one, else the address they wrote from. */
export function requesterLabel(ticket) {
  if (!ticket) return 'Unknown sender'
  return ticket.requester_name || ticket.requester_email || 'Unknown sender'
}

/** Two-letter initials — mirrors EmailInbox/UnifiedInbox so tiles read the same everywhere. */
export function initialsOf(name) {
  return String(name || '')
    .replace(/^@/, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase() || '?'
}

/**
 * Assignment is DISPLAY ONLY here — there is no picker on this surface.
 * We hold an id, not a name, so the only honest distinctions are "yours",
 * "somebody's" and "nobody's".
 */
export function assigneeLabel(ticket, currentUserId) {
  if (!ticket?.assigned_to) return 'Unassigned'
  if (currentUserId && ticket.assigned_to === currentUserId) return 'Assigned to you'
  return 'Assigned'
}

/** A mailbox's human name for a tab or a chip. */
export function mailboxLabel(mailbox) {
  if (!mailbox) return 'No mailbox'
  return mailbox.label || mailbox.address || 'Mailbox'
}

// The two empty states are DIFFERENT SITUATIONS and must not share copy: an
// empty queue is good news, no mailboxes at all means the surface can never
// show anything until someone acts. The route cannot tell "this studio has no
// addresses" from "you have no grant on its addresses" (both are an empty
// list, deliberately — answering differently would leak which addresses a
// studio runs), so the copy names both possibilities honestly.
export const NO_MAILBOX_EMPTY = Object.freeze({
  title: 'No email accounts available here',
  description:
    'Either this studio has no inbound email addresses set up yet, or you have not been '
    + 'given access to one. Access is granted per account — an owner can add an address or '
    + 'grant you access to an existing one.',
})

// ── Time ─────────────────────────────────────────────────────────────
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Compact relative age for a queue row ("now", "12m", "3h", "2d", "12 Aug").
 * Instant arithmetic only — no local-date parsing, so no BST off-by-one.
 */
export function relativeTime(value, now = Date.now()) {
  if (!value) return ''
  const t = Date.parse(value)
  if (!Number.isFinite(t)) return ''
  const diff = now - t
  if (diff < 0) return 'now'
  if (diff < MINUTE) return 'now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d`
  return new Date(t).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })
}

/** Full timestamp for a message in the thread — the operator record, not a hint. */
export function messageTimestamp(value) {
  if (!value) return ''
  const t = Date.parse(value)
  if (!Number.isFinite(t)) return ''
  return new Date(t).toLocaleString('en-IE', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

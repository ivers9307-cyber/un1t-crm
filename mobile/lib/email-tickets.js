// EMAIL-TICKET-M.1 — pure presentation rules for the MOBILE email ticket
// surface (the Email tab's queue + the ticket thread screen). Email was a
// channel inside the Messages tab until INBOX-SPLIT.M1 moved it to a tab of
// its own, matching web; nothing in this file assumes either arrangement.
//
// The web equivalent is src/lib/ticket-display.js. This is a deliberate
// re-statement rather than an import: mobile cannot reach into src/lib
// (CLAUDE.md — `shared/` is the seam, and that file is web-side, carrying
// Tailwind chip recipes and a URL builder for a surface mobile does not
// have). What IS copied here is the one rule that must be identical on both
// platforms:
//
//   AN INTERNAL NOTE IS STORED WITH direction = 'outbound'.
//
// So "is it ours?" and "was it sent?" are different questions, and
// is_internal_note has to be tested FIRST. Test direction first and a
// staff-only note paints exactly like a reply the member received — the one
// mistake this surface must never make.
//
// No React-Native imports anywhere in this file: it runs under vitest's node
// environment (see vitest.config.js include for mobile/lib).

// ── Status ───────────────────────────────────────────────────────────
//
// Chips follow the light-theme idiom the CRM uses everywhere:
// bg-<c>-500/10 + text-<c>-700. Never the -300/-400 ramp (unreadable on a
// light card) and never the dark-theme recipe (CLAUDE.md). Split into `cls`
// (background, on the chip View) and `text` (foreground, on the Text) because
// RN does not inherit text colour through a View — the same shape
// contact-command-centre.js uses.
export const TICKET_STATUS_META = Object.freeze({
  open: { label: 'Open', cls: 'bg-blue-500/10', text: 'text-blue-700', hint: 'Needs the studio' },
  pending: { label: 'Pending', cls: 'bg-amber-500/10', text: 'text-amber-700', hint: 'Replied — waiting on the member' },
  solved: { label: 'Solved', cls: 'bg-green-500/10', text: 'text-green-700', hint: 'Handled — a member reply reopens it' },
  closed: { label: 'Closed', cls: 'bg-slate-500/10', text: 'text-slate-700', hint: 'Done — a member reply starts a new ticket' },
})

// The lifecycle in the order an operator walks it. All four are rendered on
// the thread: NOTHING in this system closes itself (Richard, 2026-08-06), so
// closing has to be reachable in one tap rather than buried.
export const TICKET_STATUS_ORDER = Object.freeze(['open', 'pending', 'solved', 'closed'])

export function ticketStatusMeta(status) {
  return TICKET_STATUS_META[status]
    || { label: status || 'Unknown', cls: 'bg-slate-500/10', text: 'text-slate-700', hint: '' }
}

/** Solved and closed are the archived half of the lifecycle. */
export function isArchivedStatus(status) {
  return status === 'solved' || status === 'closed'
}

// ── Views ────────────────────────────────────────────────────────────
//
// The Email tab's queue chips, and — just as load-bearing — what each one
// should say when it is EMPTY. A single "No tickets" for every filter tells
// an operator nothing about whether the studio is on top of its mail or
// looking at the wrong queue.
//
// `wire` is the ?view= value. NULL MEANS SEND NO PARAM: the route reads an
// absent view as the live queue (open + pending), which is what the tab lands
// on. The four non-null values are exactly the ones the route whitelists —
// anything else is a 400 — and `closed` is the wire word that returns solved
// AND closed, while the chip says the shorter "Closed" an operator looks for.
//
// Vocabulary matches the web (src/lib/ticket-display.js) on purpose: the same
// person works this queue on a phone and at the desk, and a queue that is
// named differently in the two places is a queue they will mis-read. It is a
// re-statement rather than an import for the reason in the file header.
export const TICKET_VIEW_TABS = Object.freeze([
  {
    id: 'open', label: 'Open', wire: null,
    emptyTitle: 'Queue clear',
    emptyBody: 'Nothing is open or waiting on a member reply right now.',
  },
  {
    id: 'unassigned', label: 'Unassigned', wire: 'unassigned',
    emptyTitle: 'Nothing unassigned',
    emptyBody: 'Every open ticket here already has someone on it.',
  },
  {
    id: 'mine', label: 'Mine', wire: 'mine',
    emptyTitle: 'Nothing assigned to you',
    emptyBody: 'Tickets assigned to you will show up here.',
  },
  {
    id: 'needs_reply', label: 'Needs reply', wire: 'needs_reply',
    emptyTitle: 'Nobody is waiting on us',
    emptyBody: 'Every open ticket has been answered — the ball is with the member.',
  },
  {
    id: 'closed', label: 'Closed', wire: 'closed',
    emptyTitle: 'Nothing closed yet',
    emptyBody: 'Nothing auto-closes here, so this fills up only as people solve or close tickets.',
  },
])

export const DEFAULT_TICKET_VIEW = 'open'

// Having no mailbox to look at is NOT an empty queue — it is a different
// situation with a different fix, and conflating them tells someone whose
// studio simply has no address yet that their mail has all been dealt with.
// Both halves are normal states (a studio that does not do email; a coach with
// no per-account grant), so this reads as information, not as an error.
export const NO_MAILBOX_EMPTY = Object.freeze({
  title: 'No email accounts here',
  body: 'Either this studio has no inbound email address set up yet, or you have not been '
    + 'given access to one. Access is granted per account — an owner can add an address or '
    + 'grant you access to an existing one.',
})

/** A view descriptor by id, falling back to the default rather than undefined. */
export function ticketViewTab(id) {
  return TICKET_VIEW_TABS.find(v => v.id === id) || TICKET_VIEW_TABS[0]
}

/** The ?view= value for a view id — null when the param must be omitted. */
export function ticketViewWire(id) {
  return ticketViewTab(id).wire
}

// ── Messages ─────────────────────────────────────────────────────────
/**
 * How a thread message must be rendered.
 *
 * THE ORDER OF THESE CHECKS IS THE SAFETY PROPERTY — see the file header.
 * `is_internal_note` wins, always.
 *
 * @returns {'note'|'outbound'|'inbound'}
 */
export function ticketMessageKind(message) {
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

/** A mailbox's human name for a row chip or the thread header. */
export function mailboxLabel(mailbox) {
  if (!mailbox) return 'No mailbox'
  return mailbox.label || mailbox.address || 'Mailbox'
}

// ── Queue rows ───────────────────────────────────────────────────────
/**
 * Turn one ticket into a row for the Email tab's list.
 *
 * Two fields are conversation-shaped rather than ticket-shaped. They date
 * from INBOX-EMAIL-M.1, when these rows were merged into the Messages list
 * beside WhatsApp and Instagram; INBOX-SPLIT.M1 gave email its own tab, which
 * filters server-side via ?view= and reads neither. They are kept because
 * each states something TRUE about a ticket that a conversation-shaped
 * consumer would otherwise guess wrong:
 *
 *   • `resolved_at` — mobile/lib/inbox.js's needs-reply queue keys on it, and
 *     tickets have no such column. Solved/closed IS the resolved half of the
 *     lifecycle, so it maps to the stamp; open/pending map to null. A row
 *     that lied about being unresolved would file a closed ticket under
 *     "needs reply", which is the sort of thing that is never noticed.
 *   • `pending_approval: false` — stated rather than left undefined. There is
 *     no customer agent on email, so no email row can ever hold an approval,
 *     and the Messages tab's `?? pendingIds.has(id)` backfill (keyed on
 *     WhatsApp conversation ids) must never run against a ticket id.
 *
 * @param {object} ticket
 * @param {object} [opts]
 * @param {Record<string, object>} [opts.mailboxById]
 * @param {boolean} [opts.showMailbox] true when the caller can see more than
 *   one account, and a row therefore has to say which one it arrived at
 */
export function ticketToInboxRow(ticket, { mailboxById = {}, showMailbox = false } = {}) {
  const t = ticket || {}
  const mailbox = t.mailbox_id ? mailboxById[t.mailbox_id] || null : null
  return {
    id: t.id,
    channel: 'email',
    status: t.status || 'open',
    subject: t.subject || null,
    requester_name: t.requester_name || null,
    requester_email: t.requester_email || null,
    last_message_at: t.last_message_at || t.created_at || null,
    last_message_direction: t.last_message_direction || null,
    last_message_preview: t.last_message_preview || null,
    unread_count: t.unread_count || 0,
    mailbox_id: t.mailbox_id || null,
    // Null when there is only one account to see — a chip naming the only
    // mailbox in existence is noise on a phone-width row.
    mailbox_label: showMailbox ? mailboxLabel(mailbox) : null,
    resolved_at: isArchivedStatus(t.status)
      ? (t.solved_at || t.closed_at || t.updated_at || null)
      : null,
    pending_approval: false,
  }
}

/**
 * The whole `GET /api/email/tickets` payload → rows for the Email tab.
 * Takes BOTH halves because the mailbox names live on `mailboxes`, and
 * whether a row shows one at all depends on how many there are.
 */
export function ticketsToInboxRows({ tickets = [], mailboxes = [] } = {}) {
  const mailboxById = {}
  for (const m of mailboxes) {
    if (m?.id) mailboxById[m.id] = m
  }
  const showMailbox = mailboxes.length > 1
  return tickets.map(t => ticketToInboxRow(t, { mailboxById, showMailbox }))
}

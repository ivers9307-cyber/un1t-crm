// EMAIL-TICKET-M.1 — pure presentation rules for the MOBILE email ticket
// surface (the Email tab's queue + the ticket thread screen). Email was a
// channel inside the Messages tab until INBOX-SPLIT.M1 moved it to a tab of
// its own, matching web; nothing in this file assumes either arrangement.
//
// The web equivalent is src/lib/ticket-display.js. This is a deliberate
// re-statement rather than an import: mobile cannot reach into src/lib
// (CLAUDE.md — `shared/` is the seam, and that file is web-side, carrying
// Tailwind chip recipes and a URL builder for a surface mobile does not
// have). What IS copied here are the rules that must be identical on both
// platforms, and the list is the whole point of the file:
//
//   1. AN INTERNAL NOTE IS STORED WITH direction = 'outbound'.
//      So "is it ours?" and "was it sent?" are different questions, and
//      is_internal_note has to be tested FIRST. Test direction first and a
//      staff-only note paints exactly like a reply the member received — the
//      one mistake this surface must never make.
//   2. THE FOUR DELIVERY STATES, and which of them is silent — see the block
//      comment above ticketDeliveryMeta. A NULL status means "we have not
//      heard", which is neither delivered nor failed.
//   3. A REPLY SENT FROM SOMEBODY'S OWN MAIL CLIENT IS MARKED AS SUCH
//      (MAILBOX-COEXIST.1) — and the CRM never claims to have sent it. See
//      ticketSendOriginMeta and the mail-client branch of ticketDeliveryMeta.
//
// Rule 2 has already diverged once (web shipped the not-tracked branch and
// mobile did not, so one message read differently on a phone and at the desk),
// which is why rule 3 was written into both files in the same pass.
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

// ── Where a reply was actually sent from (MAILBOX-COEXIST.1) ─────────
//
// Rule 3 in the file header. A re-statement of sendOriginMeta in
// src/lib/ticket-display.js — same predicate, same words, for the reason the
// header gives.
//
// Phase 8 polls a connected mailbox's Sent folder, so a reply somebody typed
// in Gmail lands here as an outbound row: source 'mail_client', no author
// (nobody signed in to send it), no Postmark id. The failure the phase exists
// to remove is TWO PEOPLE ANSWERING ONE MEMBER, and this screen is where the
// second of them would start typing. If a mail-client reply looks identical to
// one composed in the CRM, the thread can say that the member was answered but
// not from where — and with no author to name, the origin is the only honest
// answer to "who replied?" there is.
//
// ticketMessageKind deliberately does NOT grow a fourth value: it IS an
// outbound message, and that function's three-case note-first ordering is the
// safety property of this whole screen. This is a separate rule beside it.

/**
 * Where an outbound message was sent from, when that is not the CRM.
 *
 * Null for everything composed here — source 'operator', and every row written
 * before Phase 8, whose source is NULL. Inbound mail and notes are excluded
 * first: an inbound message's origin is the sender's own business, and a note
 * was never sent from anywhere.
 *
 * `icon` is an Ionicons name, matching the shape ticketDeliveryMeta returns —
 * the web version leaves icon choice to its component, which is the same split
 * this file already lives with.
 *
 * @param {object|null} message
 * @returns {null | { source: 'mail_client', label: string, detail: string, icon: string }}
 */
export function ticketSendOriginMeta(message) {
  if (!message) return null
  if (message.is_internal_note) return null
  if (message.direction !== 'outbound') return null
  if (message.source !== 'mail_client') return null
  return {
    source: 'mail_client',
    label: 'Sent from the mail client',
    detail:
      'Somebody answered from Gmail or Outlook rather than from the CRM. This is the copy '
      + 'the CRM read out of the mailbox’s Sent folder, so it cannot say which person sent it.',
    icon: 'open-outline',
  }
}

// ── Recipients (EMAIL-CC.1) ──────────────────────────────────────────
//
// A re-statement of src/lib/ticket-display.js's messageEnvelope, for the
// reason in this file's header. MOBILE SHOWS RECIPIENTS BUT DOES NOT EDIT
// THEM: the reply box here posts `{ text, internal }` and nothing else, so the
// server derives everybody on the thread and includes them — a mobile reply is
// automatically a reply-all on a multi-party thread, which is the safe default
// and the same one web gets. A recipient EDITOR (chip input, Cc/Bcc toggle) is
// deliberately not on this screen: it is the quick-answer surface, it needs
// real device QA before it carries a confidentiality control, and a half-built
// one that silently dropped a Cc would be worse than none.
//
// THE BCC RULE IS THE SAME ONE AND IT IS WHY BCC IS RENDERED AT ALL. This
// screen is behind the identical gate as the web thread (location + the
// email_inbox key + a grant on the ticket's mailbox), so the sender seeing
// their own blind-copy list is correct. `staffOnly` exists so the screen can
// say, in words, that no recipient of the email could see it.
/**
 * Every address a message's To resolves to.
 *
 * FILTERED BEFORE IT IS MEASURED, so a row carrying `to_emails: [null]` falls
 * back to the scalar rather than counting a hole as an address — the rule
 * every other reader of this field follows (EMAIL-PARTICIPANTS.12), and the
 * reason this is one function rather than the same three lines twice.
 *
 * @param {object|null} message
 * @returns {string[]}
 */
function toAddresses(message) {
  const listed = (Array.isArray(message?.to_emails) ? message.to_emails : []).filter(Boolean)
  if (listed.length) return listed
  return message?.to_email ? [message.to_email] : [] // rows written before mig 499
}

/**
 * The outbound bubble's "Sent to …" header.
 *
 * IT MUST NOT RENDER THE SCALAR. The reply route writes
 * `to_email: recipients.to[0]` and `to_emails: recipients.to` (mig 499), so
 * the scalar is the FIRST recipient, not the audience — and the bubble read
 * the scalar, so a reply that reached four people said "Sent to alice@x.com".
 * Nothing was hidden (the To line below listed all four) but the header
 * contradicted the line under it, which is the same shape as the composer
 * footer EMAIL-PARTICIPANTS.9 already had to fix on this screen.
 *
 * The count rather than the full list, because this line is `numberOfLines={1}`
 * on a phone: four addresses truncate to one and a half, which trades a header
 * that under-states for one that is merely unreadable. The full list is the To
 * line directly below.
 *
 * @param {object|null} message
 * @param {string} [fallback]  when we have no address at all
 * @returns {string}
 */
export function sentToLabel(message, fallback = 'the member') {
  const to = toAddresses(message)
  if (!to.length) return fallback
  return to.length === 1 ? to[0] : `${to[0]} +${to.length - 1} more`
}

/**
 * The To / Cc / Bcc lines under a message, in header order. Empty lists are
 * omitted — "Cc:" with nothing after it reads as a Cc that failed.
 *
 * THE TWO BUBBLES CARRY DIFFERENT HEADERS, and the old rule here was written
 * as though they carried the same one. It dropped a single To unconditionally,
 * "because the bubble's own 'Sent to …' line already says it" — but only the
 * OUTBOUND bubble has that line. The INBOUND bubble's header is "From …",
 * which names the sender and nobody on our side, so there a single To was
 * suppressed with nothing standing in for it and the screen stopped saying
 * which studio mailbox the member had written to.
 *
 * So the caller states it. `toShownInHeader` defaults to false — the reading
 * that shows MORE — because a wrong default here is invisible: it does not
 * break, it just quietly stops rendering a line.
 *
 * @param {object|null} message
 * @param {{ toShownInHeader?: boolean }} [opts]  true only for the outbound
 *   bubble, whose sentToLabel() header names the To in full when there is
 *   exactly one and only the first of several otherwise
 * @returns {{ key: string, label: string, addresses: string[], staffOnly: boolean }[]}
 */
export function ticketMessageRecipients(message, { toShownInHeader = false } = {}) {
  if (!message) return []
  const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : [])
  const to = toAddresses(message)
  const out = []
  // Outbound needs the line only once the header can no longer name everyone.
  if (to.length >= (toShownInHeader ? 2 : 1)) {
    out.push({ key: 'to', label: 'To', addresses: to, staffOnly: false })
  }
  const cc = list(message.cc_emails)
  if (cc.length) out.push({ key: 'cc', label: 'Cc', addresses: cc, staffOnly: false })
  const bcc = list(message.bcc_emails)
  if (bcc.length) out.push({ key: 'bcc', label: 'Bcc', addresses: bcc, staffOnly: true })
  return out
}

// ── Reply audience (EMAIL-PARTICIPANTS.9) ────────────────────────────
//
// GET .../[id] derives the reply audience from the WHOLE thread and answers
// it as reply_recipients = { to, mode, over_cap, empty } — the same shape
// TicketReplyBox.jsx reads on web. Before this, the composer footer below
// said "Sends an email to <requester>" unconditionally, even though a reply
// from this screen has ALWAYS gone to everyone the server derives (this
// file's own header — mobile posts { text, internal } and the route adds the
// rest). On any multi-party thread that told the operator the reply reached
// one person when it reached several: a known standing defect (2026-08-09
// audit).
//
// MOBILE IS READ-ONLY HERE, DELIBERATELY. There is no chip editor on this
// screen (see the file header) — removing a participant is a web-only act —
// so this function only ever DESCRIBES the audience the server already
// settled on; it never changes it. What it adds beyond description is the two
// refusals the reply route enforces server-side: over_cap and empty. Both are
// answered by this same GET, so the operator can be told BEFORE typing rather
// than after pressing a send button the route would 400.
//
// PRIORITY, most specific first:
//   1. no requester_email at all — cannot be replied to, full stop.
//   2. empty — every participant was excluded (a web-only act); nobody left.
//   3. over_cap — more recipients than one email may carry.
//   4. the normal case — name them.
// (1) is checked first regardless of what reply_recipients says, matching
// TicketReplyBox.jsx's `canReply` gate on web exactly.

/**
 * The composer footer's text and whether Send must be disabled, for a reply
 * (never call this in note mode — a note has no audience).
 *
 * `replyRecipients` is null when the route could not derive one (an
 * own-address lookup blip) — the fallback is the requester address alone,
 * exactly like `lockedTo` on web, and null must never be misread as an
 * over_cap/empty ANSWER.
 *
 * WITH SEVERAL RECIPIENTS THIS NAMES ONLY THE FIRST. Deliberately: the first
 * entry is the live counterparty — the person the reply is answering, which
 * ticketParticipants (src/lib/email-recipients.js) reads off the newest real
 * message in whichever direction it went: its From when they wrote to us, its
 * first To when we wrote to them. The GET derives `to` the same way the reply
 * route does, so this line and the send agree. Everyone else becomes a count:
 * naming all of them on a phone-width line is the mistake this exists to
 * avoid, not a shortcut; it is the same idiom web's placeholder and
 * send-button label already use.
 *
 * (Until EMAIL-PARTICIPANTS.12 that lead was the newest From either way — one
 * of OUR OWN addresses on an outbound message, excluded a line later — so the
 * order reverted to first appearance the moment staff answered, and this line
 * named whoever happened to be earliest rather than whoever was being
 * answered.)
 *
 * @param {{requester_email?: string, mailbox?: {address?: string}}|null} ticket
 * @param {{to: string[], mode: string, over_cap: boolean, empty: boolean}|null} replyRecipients
 * @returns {{ text: string, disabled: boolean }}
 */
export function ticketReplyAudienceMeta(ticket, replyRecipients) {
  if (!ticket?.requester_email) {
    return {
      disabled: true,
      text: 'This ticket has no requester address, so it cannot be replied to. You can still add an internal note.',
    }
  }

  if (replyRecipients?.empty) {
    return {
      disabled: true,
      text: 'Every recipient has been removed from this thread, so there is nobody to reply to. '
        + 'You can still add an internal note.',
    }
  }

  const to = ticketReplyAudience(ticket, replyRecipients)

  if (replyRecipients?.over_cap) {
    return {
      disabled: true,
      text: `This thread has ${to.length} recipients — too many for one reply. Remove some on the web before replying.`,
    }
  }

  const mailboxNote = ticket?.mailbox?.address ? ` · replies come back to ${ticket.mailbox.address}` : ''
  const text = to.length === 1
    ? `Sends an email to ${to[0]}${mailboxNote}`
    : `Sends an email to ${to[0]} and ${to.length - 1} ${to.length === 2 ? 'other' : 'others'}${mailboxNote}`

  return { disabled: false, text }
}

/**
 * THE audience for this screen — one derivation, three strings.
 *
 * The footer, the composer placeholder and the header line all answer "who
 * does this reach", and three of them working it out separately is three
 * chances to disagree about one ticket. That is not hypothetical: it is
 * precisely what shipped. Web keeps its equivalent in ONE place too
 * (TicketReplyBox's `lockedTo`, read by both its placeholder and its
 * sentence), and the server keeps its own in ticketParticipants().
 *
 * THE EMPTY RULE, which is the whole reason this is a function and not an
 * inline `?:`. `empty: true` means the operator removed everybody (a web-only
 * act — see the file header). Falling back to the requester there would name
 * the person they had just taken off, in a prompt, above a send the route
 * would 400. "We could not derive anybody" (`replyRecipients` null, an
 * own-address lookup blip) is a DIFFERENT answer and the only one the
 * requester fills.
 *
 * @param {{requester_email?: string}|null} ticket
 * @param {{to?: string[], empty?: boolean}|null} replyRecipients
 * @returns {string[]}  possibly empty, never holding a hole
 */
export function ticketReplyAudience(ticket, replyRecipients) {
  if (replyRecipients?.empty) return []
  const derived = (Array.isArray(replyRecipients?.to) ? replyRecipients.to : []).filter(Boolean)
  if (derived.length) return derived
  return ticket?.requester_email ? [ticket.requester_email] : []
}

/**
 * What the composer's text box says before anything is typed.
 *
 * It read `Reply to ${ticket.requester_email}…` — the address the FIRST
 * message arrived from — until EMAIL-PARTICIPANTS.12. On the 2026-08-12
 * ticket that put "Reply to ratesoffice@dublincity.ie" in the box an operator
 * types into, directly above a footer saying the mail goes to Eleanor and one
 * other: the composer contradicting itself in two adjacent lines, on the
 * screen where the wrong name is most expensive. Web fixed the same string in
 * EMAIL-PARTICIPANTS.8 and mobile was left behind.
 *
 * NAMES ONLY THE FIRST, then a count — the idiom the footer and web's own
 * placeholder already use, and the reason the first entry has to be the live
 * counterparty rather than whoever appeared earliest.
 *
 * @param {{requester_email?: string}|null} ticket
 * @param {{to?: string[], empty?: boolean}|null} replyRecipients
 * @returns {string}
 */
export function ticketReplyPlaceholder(ticket, replyRecipients) {
  // Checked first, exactly like ticketReplyAudienceMeta and web's `canReply`:
  // a ticket with no requester address cannot be replied to at all, whatever
  // reply_recipients says.
  if (!ticket?.requester_email) return 'No requester address — add an internal note instead'

  const to = ticketReplyAudience(ticket, replyRecipients)
  if (to.length === 0) return 'Reply…'
  if (to.length === 1) return `Reply to ${to[0]}…`
  return `Reply to ${to[0]} and ${to.length - 1} ${to.length === 2 ? 'other' : 'others'}…`
}

/**
 * WHO THE TICKET IS ACTUALLY WITH — the line under the subject, and the
 * "Opened by" line beneath it (mobile's half of EMAIL-PARTICIPANTS.8/.12).
 *
 * This line was `ticket.requester_email` raw: the person the FIRST message
 * came from and nothing more. When a shared mailbox hands a thread to a named
 * person — a rates office forwarding to an officer, 2026-08-12 — every message
 * afterwards is with somebody this header never named, and an operator reading
 * it answers the wrong person. That is the incident, and it cost a duplicate
 * reply.
 *
 * "OPENED BY …" APPEARS ONLY WHEN THE TWO HAVE DIVERGED, i.e. the requester is
 * not the live counterparty. On an ordinary ticket they are the same address
 * and the line would be noise on every ticket — which is exactly how the one
 * ticket that needed it would get skipped over. The requester's NAME rides on
 * their own address rather than sitting on a line of its own, for the same
 * reason web does it: a name floating above the participants is the wrong name
 * in the most prominent place the moment the thread moves to somebody else.
 *
 * @param {{requester_email?: string, requester_name?: string}|null} ticket
 * @param {{to?: string[], empty?: boolean}|null} replyRecipients
 * @returns {{ primary: string, opener: string|null }}
 */
export function ticketThreadAudienceLines(ticket, replyRecipients) {
  const requester = ticket?.requester_email || ''

  if (replyRecipients?.empty) {
    return { primary: 'Nobody is left on this thread — every recipient was removed.', opener: null }
  }

  const people = (Array.isArray(replyRecipients?.to) ? replyRecipients.to : []).filter(Boolean)
  // No derived audience at all: the plain requester line this header has
  // always shown, which is the honest answer when nothing else is known.
  if (people.length === 0) return { primary: requester || 'No requester address', opener: null }

  // Compared normalised, because these two come from different places: one is
  // a stored column, the other is derived off message headers a stranger's
  // mail client wrote. A case difference is not a change of counterparty.
  const norm = (a) => String(a || '').trim().toLowerCase()
  const name = ticket?.requester_name || ''
  const withName = (address) => (
    name && norm(address) === norm(requester) ? `${name} <${address}>` : address
  )

  return {
    primary: `On this thread: ${people.map(withName).join(', ')}`,
    opener: requester && norm(people[0]) !== norm(requester)
      ? `Opened by ${withName(requester)}`
      : null,
  }
}

// ── Delivery status (EMAIL-DELIVERY.1) ───────────────────────────────
//
// A re-statement of src/lib/ticket-display.js's deliveryMeta, for the reason
// in this file's header (mobile cannot reach into src/lib; the web version
// carries Tailwind chip strings shaped for the web DOM). The RULES are the
// ones that must not diverge, so they are spelled out again here:
//
//   • `delivery_status` NULL means WE HAVE NOT HEARD. That is the state of
//     every outbound message the instant it is sent, of the entire
//     back-catalogue, and of any message whose webhook never arrives. It
//     renders as NEITHER delivered NOR failed — the bubble keeps its plain
//     "Sent to …" line and makes no claim.
//   • delivered is QUIET (one word on a line that is already there).
//   • bounced is LOUD (its own red panel, outside the bubble) because the
//     member never got the answer.
//   • complained is its own amber panel: they DID get it and reported it,
//     which is a different problem with a different fix.
//
// Split into `cls`/`text` like TICKET_STATUS_META: RN does not inherit text
// colour through a View.
const BOUNCE_ADVICE = Object.freeze({
  hard: 'That address does not exist or refused the message outright — check it with them before replying again.',
  soft: 'The address exists but could not take it right now (mailbox full, message too big, or their server was down). Worth trying again later.',
  transient: 'Their mail server rejected it. The reason from the provider is below.',
})

/**
 * How a message's delivery outcome must be rendered, or null when there is
 * nothing to say (inbound, an internal note, or no event yet).
 *
 * Notes and inbound mail are excluded FIRST: a note is never sent, so
 * "delivered" is a category error on it, and an inbound message's delivery is
 * the sender's business.
 *
 * @returns {null | {status: string, tone: 'quiet'|'warn'|'alarm', label: string,
 *   headline?: string, advice?: string, detail?: string|null,
 *   cls?: string, text?: string, icon?: string, iconColor?: string}}
 */
export function ticketDeliveryMeta(message) {
  if (!message) return null
  if (message.is_internal_note) return null
  if (message.direction !== 'outbound') return null

  const status = message.delivery_status
  const detail = message.delivery_detail || null

  if (status === 'delivered') {
    return { status, tone: 'quiet', label: 'Delivered', detail: null }
  }

  if (status === 'bounced') {
    return {
      status,
      tone: 'alarm',
      label: 'Not delivered',
      headline: 'Not delivered — the member never got this reply',
      advice: BOUNCE_ADVICE[message.delivery_bounce_type] || BOUNCE_ADVICE.transient,
      detail,
      cls: 'bg-red-500/10 border-red-500/60',
      text: 'text-red-700',
      icon: 'mail-unread-outline',
      iconColor: '#B91C1C',
    }
  }

  if (status === 'complained') {
    return {
      status,
      tone: 'warn',
      label: 'Marked as spam',
      headline: 'Marked as spam by the recipient',
      advice: 'It reached them, but they reported it. Further email to this address is likely to be filtered — reach them another way.',
      detail,
      cls: 'bg-amber-500/10 border-amber-500/60',
      text: 'text-amber-700',
      icon: 'warning-outline',
      iconColor: '#B45309',
    }
  }

  // MAILBOX-COEXIST.1 — A REPLY WE ONLY OBSERVED, AND NEVER SENT.
  //
  // Mirrors the branch of the same name in src/lib/ticket-display.js; rule 3
  // in the file header.
  //
  // 🔴 IT EXISTS BECAUSE THE BRANCH BELOW WOULD OTHERWISE SWALLOW IT AND SAY
  // SOMETHING FALSE. A mail-client row is outbound with no status, no Postmark
  // id and an rfc id — byte for byte the SMTP predicate — so it would inherit
  // that branch's copy, "sent from this mailbox's own server". We sent it from
  // no server of ours: somebody typed it in Gmail and the poller read a copy
  // out of a folder. Naming a send path we did not use is worse than the
  // unknown-provenance case the branch below already refuses to guess about,
  // because it is specific enough to send an operator to check the wrong one.
  //
  // Keyed on `source` (stamped by the Sent-lane writer), not on the null-pair,
  // which is an inference that merely happens to be true today. Above the SMTP
  // branch so the more specific fact wins; below the status branches so a real
  // outcome is never swallowed. Both orderings are pinned in the test file.
  //
  // Same "Not tracked" label as the SMTP case on purpose: the delivery fact an
  // operator reads is identical (nothing known, nothing coming) and one fact
  // does not need two words. Only the reason differs, and that is `detail`.
  if (!status && message.source === 'mail_client') {
    return {
      status: null,
      tone: 'quiet',
      label: 'Not tracked',
      detail: 'The CRM did not send this — it was read out of the mailbox’s Sent folder, so there is no delivery information for it and none can arrive.',
    }
  }

  // MAILBOX-CONNECT.7 — SENT OVER THE MAILBOX'S OWN SMTP SERVER.
  //
  // Mirrors the branch of the same name in src/lib/ticket-display.js; this is
  // one of the RULES the header above says must not diverge, and it was missed
  // on the first pass (web said "Not tracked", mobile said nothing about the
  // same message).
  //
  // A Postmark send always carries an API MessageID, and that id is the key
  // every Delivery/Bounce/SpamComplaint event correlates on. An SMTP send has
  // none — no provider event can ever arrive for it. That is a DIFFERENT fact
  // from the NULL above, which means "we have not heard YET".
  //
  // Both halves of the predicate are load-bearing. Keying on the missing
  // Postmark id alone would also match every historical row whose id was never
  // captured and the degraded-sender path, and assert something false about how
  // those were sent. Only the SMTP path writes rfc_message_id on an outbound
  // row, so the pair distinguishes the three states cleanly.
  if (!status && message.postmark_message_id == null && message.rfc_message_id != null) {
    return {
      status: null,
      tone: 'quiet',
      label: 'Not tracked',
      detail: 'Sent from this mailbox’s own server, which does not report delivery back to the CRM.',
    }
  }

  // NULL / anything unrecognised — say nothing. See the block comment above.
  return null
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

// ── Attachments (EMAIL-ATTACH-PREVIEW.1) ────────────────────────────
//
// Mobile showed NOTHING for a message's files until this — not the names, not
// the sizes, and not the sentence explaining that an over-quota one was never
// stored. A coach reading a ticket on their phone saw a member's photo email as
// an empty message, which is the same operator-facing bug the web thread had.
//
// The two display helpers below are DELIBERATE COPIES of the web ones in
// src/lib/email-attachment-quota.js rather than shared code: mobile cannot
// import src/lib (CLAUDE.md — `shared/` is the seam), and both are display
// strings that change roughly never.
//
// THE RULE THAT ACTUALLY MATTERS IS NOT COPIED. Which types may be previewed is
// a security decision (image/svg+xml is scriptable markup from an
// unauthenticated stranger), and the server answers it — `preview_kind` arrives
// on the attachment row and the phone reads the verdict. One allow-list, on the
// server, which a second platform cannot drift from.

const ATTACHMENT_SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** Human bytes. Base 1024, matching the web helper of the same shape. */
export function formatAttachmentSize(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  let v = n
  let i = 0
  while (v >= 1024 && i < ATTACHMENT_SIZE_UNITS.length - 1) { v /= 1024; i += 1 }
  const decimals = i === 0 ? 0 : (v < 10 ? 1 : 0)
  return `${v.toFixed(decimals)} ${ATTACHMENT_SIZE_UNITS[i]}`
}

/**
 * What staff see next to an attachment that is not in the bucket.
 *
 * A NOT-STORED ATTACHMENT IS SHOWN, NOT HIDDEN — a file that simply vanished
 * from the thread would have staff telling a member "you never sent it".
 */
export function ticketAttachmentSkippedLabel(reason) {
  switch (reason) {
    case 'quota': return 'Not stored — mailbox was full'
    case 'too_large': return 'Not stored — over the size limit'
    case 'too_many': return 'Not stored — too many files on one email'
    case 'rehost_failed': return 'Not stored — upload failed'
    case 'pruned': return 'Removed to free space'
    default: return 'Not stored'
  }
}

/**
 * The Ionicons glyph for a file — its type first, its filename only when the
 * type says nothing (a real .pptx arrives as application/octet-stream, because
 * safeMimeType caps a subtype at 60 characters and that one is 61). Cosmetic:
 * the filename never influences anything that touches bytes.
 */
export function ticketAttachmentIcon(mimeType, filename) {
  const mime = String(mimeType || '').toLowerCase()
  const parts = String(filename || '').toLowerCase().split('.')
  const ext = parts.length > 1 ? parts[parts.length - 1] : ''
  if (mime.startsWith('image/')) return 'image-outline'
  if (mime === 'application/pdf' || ext === 'pdf') return 'document-text-outline'
  if (mime === 'text/csv' || mime.includes('spreadsheet') || ['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return 'grid-outline'
  if (mime.includes('presentation') || mime.includes('powerpoint') || ['ppt', 'pptx', 'ppsx', 'odp'].includes(ext)) return 'easel-outline'
  if (mime.includes('zip') || mime.includes('compressed') || ['zip', 'rar', '7z', 'gz'].includes(ext)) return 'archive-outline'
  if (mime.includes('word') || mime === 'application/msword' || ['doc', 'docx', 'rtf', 'odt'].includes(ext)) return 'document-outline'
  return 'attach-outline'
}

// ── How often an OPEN thread re-reads itself (EMAIL-ATTACH-RACE.1) ───
//
// The web statement of this is threadRefreshMs in src/lib/ticket-display.js,
// with the full account of the race. The short version: the inbound webhook
// files the message row FIRST and writes email_ticket_attachments AFTER it —
// the attachment rows carry a foreign key to the message, and attachment work
// is never allowed to delay filing the mail. So a thread opened inside that
// window is a correct read of an incomplete moment, and until this existed it
// was also the LAST read, so a member's photo stayed invisible until the
// screen was left and re-entered.
//
// Mobile had it worse than web: the screen loaded once on mount and had no
// poll and no focus refresh at all, so the thread was frozen for as long as it
// stayed open.
//
// Two speeds — fast while the newest message is young enough that rows may
// still be arriving, slow otherwise. The numbers match web on purpose: an
// operator watching the same ticket on a phone and a laptop should not see one
// of them catch up first for reasons neither of them can see.

export const THREAD_SETTLE_MS = 5_000
export const THREAD_STEADY_MS = 60_000
export const THREAD_SETTLE_WINDOW_MS = 120_000

/** The newest `created_at` in a thread, as epoch ms, or null. */
export function newestMessageAt(messages = []) {
  let newest = null
  for (const m of messages || []) {
    const t = Date.parse(m?.created_at)
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t
  }
  return newest
}

/**
 * Milliseconds until an open thread should re-read itself. An empty thread
 * gets the steady cadence; a future timestamp (clock skew) counts as brand
 * new, erring towards reading again rather than missing the attachment.
 */
export function threadRefreshMs(messages = [], now = Date.now()) {
  const newest = newestMessageAt(messages)
  if (newest === null) return THREAD_STEADY_MS
  const age = now - newest
  if (age < 0) return THREAD_SETTLE_MS
  return age < THREAD_SETTLE_WINDOW_MS ? THREAD_SETTLE_MS : THREAD_STEADY_MS
}

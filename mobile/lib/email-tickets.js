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
// RETIRE-TICKETS.1 — the four-state lifecycle left with the ticket queue.
// On Mail a conversation is in the inbox or it is Archived; the one other
// fact worth a chip is Needs reply. Same vocabulary as the web surface
// (src/components/mail/mail-display.js), restated for the file-header reason.
export function mailStatusChip(row) {
  // The server-stamped flags outrank re-derivation when present (the route
  // stamps `archived` + `needs_reply` on every mail row precisely so no
  // client re-derives the one predicate the surface exists to keep); the
  // status/direction fallbacks cover ticket-shaped callers with no stamps.
  const archived = typeof row?.archived === 'boolean'
    ? row.archived
    : isArchivedStatus(row?.status)
  if (archived) {
    return { label: 'Archived', cls: 'bg-slate-500/10', text: 'text-slate-700' }
  }
  const needsReply = typeof row?.needs_reply === 'boolean'
    ? row.needs_reply
    : (row?.status === 'open' && row?.last_message_direction === 'inbound')
  if (needsReply) {
    return { label: 'Needs reply', cls: 'bg-amber-500/10', text: 'text-amber-700' }
  }
  return null
}

/** Solved and closed are the archived half of the (retired) lifecycle —
 * kept because historic rows still carry 'solved', and both read as
 * Archived on this surface. */
export function isArchivedStatus(status) {
  return status === 'solved' || status === 'closed'
}

// ── Views ────────────────────────────────────────────────────────────
//
// The Mail tab's view chips, and — just as load-bearing — what each one
// should say when it is EMPTY. A single "No mail" for every filter tells
// an operator nothing about whether the studio is on top of its mail or
// looking at the wrong queue.
//
// `wire` is the ?view= value. NULL MEANS SEND NO PARAM: the mail route reads
// an absent view as the inbox, which is what the tab lands on. The non-null
// values are exactly the ones the route whitelists — anything else is a 400.
//
// Vocabulary matches the web (src/lib/ticket-display.js) on purpose: the same
// person works this queue on a phone and at the desk, and a queue that is
// named differently in the two places is a queue they will mis-read. It is a
// re-statement rather than an import for the reason in the file header.
export const TICKET_VIEW_TABS = Object.freeze([
  {
    id: 'inbox', label: 'Inbox', wire: null,
    emptyTitle: 'Inbox zero',
    emptyBody: 'Nothing here — new mail lands in this list as it arrives.',
  },
  {
    id: 'needs_reply', label: 'Needs reply', wire: 'needs_reply',
    emptyTitle: 'Nobody is waiting on us',
    emptyBody: 'Every conversation has been answered — the ball is with the member.',
  },
  {
    id: 'archived', label: 'Archived', wire: 'archived',
    emptyTitle: 'Nothing archived yet',
    emptyBody: 'Archive a conversation when it is dealt with — a new reply from the member brings it back.',
  },
])

export const DEFAULT_TICKET_VIEW = 'inbox'

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
    // MOBILE-MAIL.1 — the mail list's own read model: per-message seen_at,
    // mirrored from IMAP \Seen where an account is connected. The ticket-era
    // unread_count column rides as the fallback for any caller still shaping
    // ticket rows through this.
    unread_count: t.unread_count_messages ?? t.unread_count ?? 0,
    unread: t.unread === true,
    needs_reply: t.needs_reply === true,
    has_attachments: t.has_attachments === true,
    mailbox_id: t.mailbox_id || null,
    // Null when there is only one account to see — a chip naming the only
    // mailbox in existence is noise on a phone-width row.
    mailbox_label: showMailbox ? mailboxLabel(mailbox) : null,
    // MOBILE-MAIL-REDESIGN.B / audit F2 — the swipe verb and its undo read
    // this off the row, and THE SERVER'S STAMP WINS when present: the mail
    // route counts legacy `solved` rows as LIVE (`archived:false`, they list
    // in the Inbox), and an OR over isArchivedStatus overrode that explicit
    // false — so swiping one sent `{archived:false}` and REOPENED a resolved
    // conversation instead of archiving it. The status fallback now applies
    // only when the flag is absent (a ticket-era caller shaping raw rows).
    archived: typeof t.archived === 'boolean'
      ? t.archived
      : isArchivedStatus(t.status),
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

// ═══ MOBILE-MAIL-REDESIGN.B — the inbox list's own mechanics ═════════
//
// The redesigned Mail tab (approved mockup §01 triage rows, §02 swipe/undo/
// paging, §06 honest states). Screens have no render harness, so every
// branchable decision the tab makes lives here where vitest can reach it;
// the screen reads verdicts.

// ── Paging (mockup §02 note 3) ───────────────────────────────────────
/**
 * Append the next page of conversations onto the rows already on screen.
 *
 * THE CURSOR IS INCLUSIVE ON PURPOSE (the mail route's `before` is <= on
 * last_message_at, so ties can never fall between pages) — which means every
 * page repeats the previous page's boundary row, and the client MUST dedupe
 * by id. The copy already on screen wins: the repeat is the same row, and
 * keeping the rendered one means no visible flicker mid-scroll.
 *
 * Rows without an id are skipped — they cannot be deduped or FlatList-keyed,
 * and a row the server sent without one is a row we cannot act on anyway.
 * Pure: neither input is mutated.
 */
export function mergeMailPages(existing = [], incoming = []) {
  const seen = new Set()
  const out = []
  for (const r of existing || []) {
    if (!r?.id || seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
  }
  for (const r of incoming || []) {
    if (!r?.id || seen.has(r.id)) continue
    seen.add(r.id)
    out.push(r)
  }
  return out
}

// ── Row timestamp (mockup §01 — 10:42 / Yest / Tue / 12 Aug) ─────────
/**
 * The row's trailing time, at mail-client granularity: time-of-day today,
 * "Yest", the weekday inside a week, then day-month (with the year only once
 * it is not this year — a mail list that stamps ", 2026" on every row spends
 * its narrowest column saying nothing).
 *
 * Judged by CALENDAR DAY, not 24-hour windows — 23:55 yesterday is "Yest"
 * even though it is minutes old, because the question a mail row answers is
 * "which day", not "how long ago". A future timestamp (clock skew between
 * the phone and the server) counts as today: showing a time is at worst
 * slightly odd, showing tomorrow's date is visibly broken.
 */
export function mailRowTime(iso, now = new Date()) {
  const d = new Date(iso ?? NaN)
  if (!iso || Number.isNaN(d.getTime())) return ''
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((dayStart(now) - dayStart(d)) / 86_400_000)
  if (days <= 0) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (days === 1) return 'Yest'
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' })
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  }
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

// ── Account filter chips (mockup §01 — All accounts / accounts@) ─────
/**
 * The account filter row: "All accounts" plus one chip per visible mailbox,
 * or NOTHING when the caller can see fewer than two — a filter over one
 * mailbox is noise, the same rule mailbox_label already follows on rows.
 *
 * `id: null` on the lead chip means "send no mailbox_id param"; the others
 * carry the id the list call filters on. Labels are the address cut after
 * its @ ("accounts@") — on a phone-width strip the local part IS the
 * identity, and every studio address shares the domain anyway. A mailbox
 * with no usable address falls back to its label, then a plain word.
 */
export function mailboxFilterChips(mailboxes = []) {
  const real = (mailboxes || []).filter(m => m?.id)
  if (real.length < 2) return []
  return [
    { id: null, label: 'All accounts' },
    ...real.map(m => ({ id: m.id, label: mailboxChipLabel(m) })),
  ]
}

function mailboxChipLabel(m) {
  const addr = String(m.address || '')
  const at = addr.indexOf('@')
  if (at > 0) return addr.slice(0, at + 1)
  return m.label || 'Mailbox'
}

// ── Row marks (mockup §01 note 4) ────────────────────────────────────
/**
 * The two glyphs before a row's preview. The ✓ means "our word was last" —
 * answered mail visibly rests — so it demands direction === 'outbound'
 * exactly: a NULL direction (no messages yet, or a row written before the
 * column) must not claim the member was answered. The paperclip mirrors the
 * server's has_attachments verdict (real stored files only), strictly ===
 * true so a truthy accident cannot promise a file the thread won't show.
 */
export function mailRowMarks(row) {
  return {
    showCheck: row?.last_message_direction === 'outbound',
    showClip: row?.has_attachments === true,
  }
}

// ── Swipe verbs (mockup §02) ─────────────────────────────────────────

/** How long the archive snackbar offers UNDO — the approved five seconds. */
export const ARCHIVE_UNDO_MS = 5000

/**
 * Everything the archive swipe needs to know about one row: the value to
 * send now (`next`), the value UNDO sends to put things back (`undoTo` —
 * always the row's current state), the snackbar sentence, and the word on
 * the swipe underlay. One derivation so the gesture, the snackbar and the
 * undo can never disagree about which direction a row moved.
 *
 * Junk counts as a live row: `next: true` (archive) is the recoverable
 * direction — it comes with the undo snackbar.
 */
export function archiveToggleMeta(row) {
  const archived = row?.archived === true || isArchivedStatus(row?.status)
  return archived
    ? { next: false, undoTo: true, snack: 'Moved to inbox', underlay: 'INBOX' }
    : { next: true, undoTo: false, snack: 'Conversation archived', underlay: 'ARCHIVE' }
}

/**
 * The read-state swipe (left): an unread row gets marked read, a read row
 * gets marked unread — the mail-app gesture for "deal with this later".
 * `seen` is the wire value for setConversationSeen; `label` is the underlay
 * word, naming the state the swipe moves TO.
 */
export function readToggleMeta(row) {
  return row?.unread === true
    ? { seen: true, label: 'READ' }
    : { seen: false, label: 'UNREAD' }
}

// ── The honest states (mockup §06) ───────────────────────────────────
/**
 * Which of the list's four states to render, in the ORDER that keeps them
 * honest: rows always render (an error alongside rows is a banner, not an
 * empty state); an empty failed fetch is an ERROR — it also leaves zero
 * mailboxes, and calling it "no accounts" (or worse, "inbox zero") is how a
 * studio stops answering its mail without noticing. Only a clean empty
 * answer gets to distinguish "no accounts here" from a genuinely empty view.
 */
export function mailListState({ error, rows, mailboxes }) {
  if ((rows || []).length > 0) return 'list'
  if (error) return 'error'
  if ((mailboxes || []).length === 0) return 'no_mailboxes'
  return 'empty'
}

/** The failed-load empty state — a failure never wears an empty state's clothes. */
export const MAIL_ERROR_STATE = Object.freeze({
  title: "Couldn't load your mail",
  body: 'This is a connection problem, not an empty inbox. Pull down to try again.',
})

/** Foot of the Archived list — why archiving is safe to do freely. */
export const ARCHIVED_FOOTNOTE =
  "A member's reply brings a conversation back to the inbox on its own."

/**
 * The count pill on the Needs reply seg. Null at zero (a "0" pill is noise),
 * capped at 99+ like the tab badge and the web sidebar badge.
 */
export function segCountLabel(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return null
  return v > 99 ? '99+' : String(v)
}

// ═══ MAIL-REFINE.1 — the subject-first row + the flat thread ═════════
//
// The approved 31 Aug mockup (§01 row, §02 thread). Same posture as the rest
// of this file: every branchable decision lives here where vitest reaches it;
// MailRow.jsx and [ticketId].jsx lay the verdicts out.

// ── §01 — what the redesigned row shows ──────────────────────────────
/**
 * One derivation for the row's four signals, so the rail, the dot, the chip
 * and the account tag can never disagree about one conversation:
 *
 *   • `rail`  — needs reply = the AMBER left rail ONLY. The "Needs reply"
 *     chip is REMOVED (the rail already said it); an archived row never
 *     shows a rail, whatever needs_reply claims.
 *   • `unread` — darker ink + the blue dot. Strictly === true: a truthy
 *     accident must not paint a triaged row unread.
 *   • `chip`  — ARCHIVED only now (via mailStatusChip, which already returns
 *     exactly that for archived rows). Live rows carry no chip at all.
 *   • `accountTag` — the small muted mailbox label ("accounts@"), non-null
 *     only when the caller can see 2+ mailboxes (ticketToInboxRow already
 *     nulls it otherwise — this passes that verdict through).
 *
 * THE SERVER STAMP OUTRANKS RE-DERIVATION, same as mailStatusChip and the
 * archive swipe: legacy `solved` rows are LIVE on the wire (archived:false),
 * and a status fallback may only run when the stamp is absent.
 */
export function mailRowDisplay(row) {
  const archived = typeof row?.archived === 'boolean'
    ? row.archived
    : isArchivedStatus(row?.status)
  const needsReply = typeof row?.needs_reply === 'boolean'
    ? row.needs_reply
    : (row?.status === 'open' && row?.last_message_direction === 'inbound')
  return {
    rail: !archived && needsReply,
    unread: row?.unread === true,
    chip: archived ? mailStatusChip(row) : null,
    accountTag: row?.mailbox_label || null,
  }
}

// ── §02 — the flat thread plan ───────────────────────────────────────
/**
 * The thread as flat full-width messages: ONLY the newest renders expanded
 * by default; everything older collapses to a single line until tapped, and
 * a tap on an expanded one folds it again.
 *
 * `overrides` is a Map id → boolean (true = expanded, false = collapsed) —
 * an explicit per-message verdict rather than a toggle set, so a poll that
 * appends a new message (moving the "newest" default off a row somebody
 * collapsed) cannot silently flip their choice back open.
 *
 * Messages arrive oldest-first from getTicket; trusted, not re-sorted (the
 * threadDisplayPlan rule — re-sorting here and not on screen would make the
 * plan disagree with what is painted).
 */
export function flatThreadPlan(messages, overrides) {
  const list = Array.isArray(messages) ? messages : []
  const newestIdx = list.length - 1
  return list.map((message, i) => {
    const override = overrides?.get?.(message?.id)
    const expanded = typeof override === 'boolean' ? override : i === newestIdx
    return { message, collapsed: !expanded }
  })
}

/** Avatar initials: two words → two letters ("Caitlin Thornton" → CT); an
 * address → its first letter; nothing → '?'. Cosmetic only. */
function avatarInitials(nameOrEmail) {
  const s = String(nameOrEmail || '').trim()
  if (!s) return '?'
  if (s.includes('@')) return s[0].toUpperCase()
  const parts = s.split(/\s+/).filter(Boolean)
  const two = `${parts[0]?.[0] || ''}${parts[1]?.[0] || ''}`.toUpperCase()
  return two || '?'
}

/**
 * Everything a flat message row needs said about its sender — expanded
 * header and collapsed line both read this, so they cannot name different
 * people for one message.
 *
 * NOTE-FIRST, ALWAYS (the file-header rule): a staff-only note keeps tone
 * 'note' whatever its stored direction, so a folded note stays amber and an
 * expanded one keeps its STAFF-ONLY label. Outbound rows get the dark "me"
 * avatar (`dark: true`) and no right-alignment — flat is the design.
 *
 * @param {object|null} message
 * @param {{ fallbackName?: string, now?: Date }} [opts] fallbackName is the
 *   requester's display name for inbound rows (their address is often all a
 *   message row carries)
 * @returns {{ tone: 'note'|'out'|'in', dark: boolean, initials: string,
 *   who: string, address: string|null, snippet: string, when: string }}
 */
export function flatMessageMeta(message, { fallbackName = '', now = new Date() } = {}) {
  const m = message || {}
  const snippet = String(m.text_body || '').replace(/\s+/g, ' ').trim()
  const when = mailRowTime(m.sent_at || m.created_at, now)
  if (m.is_internal_note) {
    const who = m.author_name || 'Staff'
    return { tone: 'note', dark: false, initials: avatarInitials(who), who, address: null, snippet, when }
  }
  if (m.direction === 'outbound') {
    const who = m.author_name || 'You'
    return {
      tone: 'out',
      dark: true,
      initials: m.author_name ? avatarInitials(m.author_name) : 'ME',
      who,
      address: m.from_email || null,
      snippet,
      when,
    }
  }
  const who = fallbackName || m.from_email || 'Member'
  return {
    tone: 'in',
    dark: false,
    // Initials come from a REAL identity only — the 'Member' placeholder must
    // not mint a confident-looking 'M' avatar for a sender we cannot name.
    initials: avatarInitials(fallbackName || m.from_email),
    who,
    address: m.from_email || null,
    snippet,
    when,
  }
}

/**
 * Put an undone row back where it was. The index was remembered when the row
 * left; the list may have changed since (a focus refresh, another archive),
 * so the index is clamped, a negative one means append, and a row the list
 * already holds again is left alone rather than duplicated — FlatList throws
 * on a duplicate key, which would turn an undo into a crash. Pure.
 */
export function insertRowAt(rows = [], row, index) {
  const rs = rows || []
  if (!row || rs.some(r => r?.id === row.id)) return rs.slice()
  const i = index < 0 ? rs.length : Math.min(index, rs.length)
  return [...rs.slice(0, i), row, ...rs.slice(i)]
}

// ── MAIL-REFINE.2 — merged-in provenance dividers ─────────────────────────
// The thread renders one "Merged in" divider above the FIRST message of each
// absorbed conversation (rows carry merged_from_ticket_id, mig 536). Subject
// null = the source tombstone was unresolvable; the divider degrades to
// generic wording, never disappears — the merge FACT must survive a blip.
export function mergedInDividers(messages, mergedSources) {
  const subjects = new Map((Array.isArray(mergedSources) ? mergedSources : [])
    .map(t => [t?.id, t?.subject ?? null]))
  const firstOf = new Map()
  const counts = new Map()
  for (const m of (Array.isArray(messages) ? messages : [])) {
    const from = m?.merged_from_ticket_id
    if (!from) continue
    if (!firstOf.has(from)) firstOf.set(from, m.id)
    counts.set(from, (counts.get(from) || 0) + 1)
  }
  const out = new Map()
  for (const [from, firstId] of firstOf) {
    out.set(firstId, { subject: subjects.get(from) ?? null, count: counts.get(from) })
  }
  return out
}

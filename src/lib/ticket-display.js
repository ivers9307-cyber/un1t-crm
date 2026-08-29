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

// (RETIRE-TICKETS.2 — the Views block that lived here — TICKET_VIEWS,
// DEFAULT_VIEW_ID, ticketView, viewWireValue, buildTicketsUrl — went with the
// deleted list-route shim. The mobile Mail surface keeps its own view tabs in
// mobile/lib/email-tickets.js.)

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
    // A reply to a closed ticket REOPENS it — it does not fork (Richard,
    // 2026-08-07). What separates issues is threading, not the closed state.
    hint: 'Done — a member reply reopens it',
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

// ── Where a reply was actually sent from (MAILBOX-COEXIST.1) ─────────
//
// Phase 8 polls a connected mailbox's Sent folder, so a reply somebody typed
// in Gmail is now filed here as an outbound row: `source: 'mail_client'`,
// `author_profile_id: null`, `postmark_message_id: null`, `rfc_message_id`
// set. Until this phase every outbound row on this surface was composed in the
// CRM, so the thread could say "we answered" and leave it there.
//
// IT CANNOT LEAVE IT THERE ANY MORE, and that is the whole point of the phase.
// The failure it exists to remove is two people answering one member. If the
// thread renders a mail-client reply identically to one composed here, an
// operator can see THAT it was answered but not FROM WHERE — so they cannot
// tell whether the colleague they need to ask is in the CRM's audit trail at
// all. There is no author to name (nobody signed in to send it; the writer
// deliberately does not invent one), so naming the ORIGIN is the only honest
// answer available to "who replied, and from where".
//
// `messageKind` deliberately does NOT grow a fourth value for this. It IS an
// outbound message — it went to the member, it is not a note — and every
// consumer of that function branches on three cases with the note-first
// ordering as its safety property. Widening it would put a fourth case into
// the one function on this surface that must never be got wrong, to carry a
// fact that is not about how the bubble is shaped. This is a separate rule,
// read alongside it.
//
// Keyed on `source`, which the Sent-lane writer stamps, not on the shape of
// the row: "no postmark id but an rfc id" also describes an SMTP send from the
// CRM itself, and those two are different facts that must not merge.

/**
 * Where an outbound message was sent from, when that is not the CRM.
 *
 * Returns null for everything composed here (`source: 'operator'` and every
 * row written before Phase 8, whose source is NULL) — the ordinary case says
 * nothing, exactly as it always has. Inbound mail and internal notes are
 * excluded first: an inbound message's origin is the sender's own mail app and
 * none of our business, and a note was never sent from anywhere.
 *
 * @param {object|null} message
 * @returns {null | { source: 'mail_client', label: string, detail: string }}
 */
export function sendOriginMeta(message) {
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
  }
}

// ── Forwarding (EMAIL-FORWARD.1) ─────────────────────────────────────

/**
 * May this message be forwarded as mail?
 *
 * INTERNAL NOTES MAY NOT — they were never sent to anyone, they are written on
 * the assumption that only colleagues read them, and mailing one to a third
 * party under the studio's own address is the worst thing this surface could
 * do. The route refuses it too; this is the affordance that stops an operator
 * trying, and the two say the same thing on purpose.
 *
 * @param {object|null} message
 * @returns {boolean}
 */
export function canForwardMessage(message) {
  return !!message && !message.is_internal_note
}

/**
 * The "Forwarded …" line on a message that IS a forward, or null.
 *
 * Read off `forwarded_message_id` (mig 501), never off the "Fwd: " subject
 * prefix: a subject is editable text that happens to correlate today, and a
 * thread that decides how to render a message by pattern-matching its subject
 * is one renamed subject away from lying.
 *
 * A forward whose quoted message is no longer in the loaded window (a thread
 * over the 200-message cap, or a deleted row — the FK is ON DELETE SET NULL)
 * still says it was a forward. That fact does not depend on being able to
 * resolve the target, and dropping the marker would silently reclassify it as
 * an ordinary reply.
 *
 * @param {object|null} message
 * @param {Map<string, object>} [byId]  every message on the thread
 * @returns {string|null}
 */
export function forwardedMarker(message, byId) {
  if (!message?.forwarded_message_id) return null
  const source = byId?.get?.(message.forwarded_message_id) || null
  if (!source) return 'Forwarded a message from this ticket'
  const who = source.from_email || (source.direction === 'outbound' ? 'this studio' : 'the member')
  const when = messageTimestamp(source.sent_at || source.created_at)
  return `Forwarded the message from ${who}${when ? ` · ${when}` : ''}`
}

// ── Recipients and the envelope (EMAIL-CC.1, ENVELOPE-ONE.1) ─────────
//
// THE BUTTON LABEL IS THE SAFETY FEATURE. Reply and Reply All are not two
// buttons here — the mode is derived from who is actually on the thread
// (src/lib/email-recipients.js), so there is exactly one control and its job
// is to say who it reaches BEFORE it is pressed. A bare "Reply" on a
// four-person thread is what causes the mistake; "Reply All (4 people)" is
// what stops it.
//
// `replyRecipients` is null when the server could not work the set out (an
// own-address lookup blip). The honest label is then the plain one: the reply
// route recomputes the truth at send time either way, and inventing a count we
// do not have would be worse than not showing one.

/**
 * @param {{ to: string[], mode: 'reply'|'reply_all' } | null} replyRecipients
 * @param {number} [added]  extra recipients the operator typed into To
 * @returns {string}
 */
export function replyActionLabel(replyRecipients, added = 0) {
  const count = (replyRecipients?.to?.length || 0) + added
  if (count > 1) return `Reply All (${count} people)`
  return 'Reply'
}

/**
 * A message's envelope, in header order: From, To, Cc, Bcc.
 *
 * THE To IS UNCONDITIONAL, and that is a correction. EMAIL-CC.1 rendered it
 * only when it had more than one address, on the reasoning that a single To
 * was already stated by the bubble's own "Sent to …" line. That reasoning
 * held right up until the address on the far end CHANGED: with no From and no
 * single-recipient To to read, a reply arriving from a different person at the
 * same organisation looked identical to one from the requester. That is how a
 * thread moved to somebody nobody noticed (EMAIL-PARTICIPANTS.8). An envelope
 * that sometimes omits the To is not an envelope.
 *
 * BCC IS MARKED `staffOnly` AND MUST BE RENDERED AS SUCH. The list is real —
 * the sender is staff on this ticket and seeing who they blind-copied is the
 * point of recording it — but it never went on the delivered message, so a
 * surface that shows it beside To and Cc with no distinction implies the other
 * recipients saw it. They did not, and never will. The sentence saying so is
 * attached here and nowhere else, so it cannot drift between renderers.
 *
 * Empty lists are omitted rather than rendered blank: "Cc:" with nothing after
 * it reads as a Cc that failed. A message with neither a From nor a To yields
 * nothing at all, and the caller renders no envelope.
 *
 * `to_emails` IS FILTERED BEFORE IT IS MEASURED. A row carrying `to_emails:
 * [null]` has no addresses, so it must fall back to the scalar rather than
 * count a hole — the same rule ticketParticipants() and mobile's
 * ticketMessageRecipients() follow. Readers of this field disagreeing about
 * one row is the defect (EMAIL-PARTICIPANTS.12), whatever writes it today.
 *
 * @param {object|null} message
 * @returns {{ key: string, label: string, addresses: string[], staffOnly: boolean, note?: string }[]}
 */
export function messageEnvelope(message) {
  if (!message) return []
  const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : [])
  // Pre-EMAIL-CC.1 rows carry only the scalar to_email.
  const to = list(message.to_emails).length
    ? list(message.to_emails)
    : (message.to_email ? [message.to_email] : [])

  const out = []
  if (message.from_email) {
    out.push({ key: 'from', label: 'From', addresses: [message.from_email], staffOnly: false })
  }
  if (to.length) out.push({ key: 'to', label: 'To', addresses: to, staffOnly: false })
  const cc = list(message.cc_emails)
  if (cc.length) out.push({ key: 'cc', label: 'Cc', addresses: cc, staffOnly: false })
  const bcc = list(message.bcc_emails)
  if (bcc.length) {
    out.push({
      key: 'bcc',
      label: 'Bcc',
      addresses: bcc,
      staffOnly: true,
      note: 'Only staff on this ticket can see this — no recipient of the email could.',
    })
  }
  return out
}

// ── Delivery status (EMAIL-DELIVERY.1) ───────────────────────────────
//
// THREE OUTCOMES AND A SILENCE, AND THE SILENCE IS THE SUBTLE ONE.
// `delivery_status` is NULL on every outbound message the moment it is sent,
// on the whole back-catalogue, and forever on any message whose webhook never
// arrives. It means WE HAVE NOT HEARD, which is neither "delivered" nor
// "failed", so it renders as neither: the bubble keeps the plain "Sent to …"
// line it has always had and makes no claim at all. Inventing a "Pending
// delivery" chip would promise an update that nothing guarantees is coming.
//
// The asymmetry between the other three is the point of the feature:
//   • delivered — QUIET. A small marker in the meta line that is already
//     there. Confirming the normal case must not compete for attention.
//   • bounced   — LOUD. Its own red panel outside the bubble, because the
//     member did not get the answer and someone has to do something.
//   • complained — its own amber panel. They DID get it and marked it spam:
//     a different problem with a different fix, so not the same colour and
//     not the same words.
//
// Chips follow the light-theme idiom (bg-<c>-500/10 + text-<c>-700).
const BOUNCE_ADVICE = Object.freeze({
  hard: 'That address does not exist or refused the message outright — check it with them before replying again.',
  soft: 'The address exists but could not take it right now (mailbox full, message too big, or their server was down). Worth trying again later.',
  transient: 'Their mail server rejected it. The reason from the provider is below.',
})

/**
 * How a message's delivery outcome must be rendered, or null when there is
 * nothing to say (inbound, an internal note, or no event yet).
 *
 * Notes and inbound mail are excluded FIRST and unconditionally: a note is
 * never sent, so "delivered" is a category error on it, and an inbound
 * message's delivery is the sender's business, not ours.
 *
 * @returns {null | {status: string, tone: 'quiet'|'warn'|'alarm', label: string,
 *   headline?: string, advice?: string, detail?: string|null, chip?: string}}
 */
export function deliveryMeta(message) {
  if (!message) return null
  if (message.is_internal_note) return null
  if (message.direction !== 'outbound') return null

  const status = message.delivery_status
  const detail = message.delivery_detail || null

  if (status === 'delivered') {
    return {
      status,
      tone: 'quiet',
      label: 'Delivered',
      detail: null,
    }
  }

  if (status === 'bounced') {
    const type = message.delivery_bounce_type
    return {
      status,
      tone: 'alarm',
      label: 'Not delivered',
      headline: 'Not delivered — the member never got this reply',
      advice: BOUNCE_ADVICE[type] || BOUNCE_ADVICE.transient,
      detail,
      chip: 'bg-red-500/10 text-red-700',
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
      chip: 'bg-amber-500/10 text-amber-700',
    }
  }

  // MAILBOX-COEXIST.1 — A REPLY WE ONLY OBSERVED, AND NEVER SENT.
  //
  // 🔴 THIS BRANCH EXISTS BECAUSE THE ONE BELOW WOULD HAVE SWALLOWED IT AND
  // THEN SAID SOMETHING FALSE. A mail-client row is outbound with no status,
  // no `postmark_message_id` and a populated `rfc_message_id` — byte for byte
  // the SMTP predicate — so before Phase 8 it would have inherited that
  // branch's copy: "sent from this mailbox's own server". We did not send it
  // from any server of ours. Somebody typed it in Gmail and we read a copy of
  // it out of a folder. That is precisely the invented provenance the block
  // comment below refuses for rows with neither id, arriving from the other
  // direction, and it is worse here because it is specific: it names a send
  // path, and an operator chasing a message a member says never arrived would
  // go and check the wrong one.
  //
  // Keyed on `source`, which the Sent-lane writer stamps, NOT on the null-pair
  // the branch below infers from. The pair is an inference that happens to be
  // true today; `source` is the direct evidence, and it stays true if our own
  // SMTP send path ever starts capturing something else.
  //
  // It sits ABOVE the SMTP branch so the more specific fact wins, and BELOW
  // the status branches so a real outcome is never swallowed — the same
  // ordering rule the SMTP branch already lives under. Both orderings are
  // pinned in ticket-display.test.js, because nothing else would notice.
  //
  // The LABEL is deliberately the same "Not tracked". To an operator the
  // delivery fact is identical — nothing is known, and nothing is ever
  // coming — and a second label for one fact is vocabulary without meaning.
  // Only the REASON differs, and `detail` is where the reason goes. Where it
  // came FROM is a different question, answered by sendOriginMeta.
  //
  // Quiet, not warn: this is the normal state of every reply a connected
  // mailbox's owner sends from their phone. It is not a fault.
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
  // A Postmark send always carries an API MessageID, and that id is the
  // correlation key every Delivery/Bounce/SpamComplaint event arrives on. An
  // SMTP send has none — sendViaSmtp returns `messageId: null` deliberately —
  // because Google delivered the mail and will never call our webhook about it.
  //
  // So the two NULL states are NOT the same fact, and mig 498's block comment
  // is careful about exactly this: its NULL means "we sent it and we have heard
  // nothing", which carries an implicit "yet". Here there is no yet. Leaving
  // both silent would render a permanently unanswerable row identically to one
  // whose event is still in flight, and the difference is what an operator
  // needs when a member says they never received a reply.
  //
  // Quiet, not warn: this is the normal and expected state of every reply from
  // a connected mailbox, not a fault. It says what we know and does not imply
  // a problem.
  //
  // 🔴 THE PREDICATE NEEDS BOTH HALVES, and the second one is why. Keying on a
  // missing postmark_message_id ALONE was wrong (caught by audit): it also
  // matches every historical outbound row whose Postmark id was never captured,
  // and the degraded plannedFroms path — and it would then assert something
  // FALSE about how those messages were sent. Inventing history is worse than
  // saying nothing, which is what the block comment above this function is
  // about.
  //
  // The three states are distinguishable without a new column:
  //   postmark id set                  → Postmark; an event may still arrive
  //   both null                        → unknown provenance; say nothing
  //   rfc id set, postmark id null     → SMTP; nothing can EVER arrive
  // Only the SMTP send writes rfc_message_id on an outbound row — sendEmail
  // does not report the RFC id, so the Postmark path leaves it NULL. That
  // asymmetry is not incidental; it is what makes this readable.
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

/** The time a delivery outcome was recorded, formatted like the rest of the thread. */
export function deliveryTimestamp(message) {
  return messageTimestamp(message?.delivery_status_at)
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
  // EMAIL-ASSIGN.1 — the routes resolve assignee_name server-side (profiles
  // is unreadable client-side); an unresolved name degrades to 'Assigned'.
  if (ticket.assignee_name) return `Assigned to ${ticket.assignee_name}`
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

// ── How often an OPEN thread re-reads itself (EMAIL-ATTACH-RACE.1) ───
//
// THE RACE THIS EXISTS TO CLOSE
// The inbound webhook files the message row FIRST and writes
// email_ticket_attachments AFTER it, deliberately: the attachment rows carry a
// foreign key to the message, and the governing rule of that path is that
// attachment work may never fail, delay or complicate the filing of the mail
// (src/lib/email-attachments-server.js). So for as long as the Storage upload
// takes, the thread is READABLE AND INCOMPLETE — a message whose photo has no
// row yet.
//
// On the `create` path the ticket row is inserted before either, so the queue
// can surface a brand-new ticket inside that window; an operator who clicks it
// there gets a thread rendered from a correct read of an incomplete moment.
// Nothing was wrong with the read. The bug was that it was the LAST one: the
// thread was fetched once per selection and never again, so the photo stayed
// invisible until the operator reloaded the page (live, 2026-08-07).
//
// WHY A CADENCE AND NOT A NOTIFICATION
// The obvious alternative — have the webhook poke something after the
// attachments land and have the client listen — puts the fix behind a step
// that can fail. If that poke fails, the operator is back to a frozen thread
// with no reload-free recovery. A thread that re-reads itself has no such
// step: a slow upload, a retried webhook or a Storage blip is picked up by the
// next read whenever it lands.
//
// TWO SPEEDS, because the two situations are not alike:
//   • SETTLING — the newest message is minutes old, so rows belonging to it may
//     still be arriving. Read often; this is the window the bug lives in, and
//     it is bounded by how long a message stays young.
//   • STEADY — nothing recent. Read at the same 60s cadence as the queue,
//     purely so a colleague's reply or a status change is not stale forever.
//
// Pure and clock-injected like everything else here, so the schedule is a
// tested decision rather than a number buried in a useEffect.

/** Settling cadence: fast enough that a photo appears while it is still news. */
export const THREAD_SETTLE_MS = 5_000
/** Steady cadence — matches the queue's own poll. */
export const THREAD_STEADY_MS = 60_000
/**
 * How long a message counts as "still settling". Generous on purpose: an
 * attachment write normally completes in well under a second, and the cost of
 * being wrong in this direction is a handful of extra reads of one ticket that
 * somebody is actively looking at.
 */
export const THREAD_SETTLE_WINDOW_MS = 120_000

/**
 * The newest `created_at` in a thread, as epoch ms, or null.
 *
 * Scans rather than trusting order: the route hands messages back oldest
 * first, but a cadence that silently degrades to "steady" because that
 * changed would re-open the bug this file closes.
 */
export function newestMessageAt(messages = []) {
  let newest = null
  for (const m of messages || []) {
    const t = Date.parse(m?.created_at)
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t
  }
  return newest
}

/**
 * Milliseconds until an open thread should re-read itself.
 *
 * An empty or unparseable thread gets the steady cadence — there is no reason
 * to believe anything is in flight. A future timestamp (clock skew between the
 * browser and the database) is treated as brand new, which errs towards
 * reading again rather than towards missing the attachment.
 */
export function threadRefreshMs(messages = [], now = Date.now()) {
  const newest = newestMessageAt(messages)
  if (newest === null) return THREAD_STEADY_MS
  const age = now - newest
  if (age < 0) return THREAD_SETTLE_MS
  return age < THREAD_SETTLE_WINDOW_MS ? THREAD_SETTLE_MS : THREAD_STEADY_MS
}

/**
 * A value that changes only when the SET of messages changes — not when their
 * contents do.
 *
 * The thread auto-scrolls to the newest message. Once it re-reads itself every
 * few seconds, keying that scroll on the messages array would drag an operator
 * back to the bottom mid-read on every poll, and an attachment row landing on
 * an existing message is exactly the case where nothing should move.
 */
export function threadSignature(messages = []) {
  const list = messages || []
  return `${list.length}:${list[list.length - 1]?.id || ''}`
}

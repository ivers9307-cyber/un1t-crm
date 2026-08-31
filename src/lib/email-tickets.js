// EMAIL-TICKET.1 — pure ticket identity + lifecycle rules for the email
// channel. Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
//
// WHY THIS IS SEPARATE FROM email-inbox.js
// email-inbox.js resolves WHO an email is from and WHICH location it belongs
// to. That logic is unchanged. This module answers the new question mig 394
// could not: WHICH TICKET does this message join, or does it start one?
//
// THE RULE THAT MATTERS
// mig 394 kept one conversation per (location, address) forever, so a member
// with two unrelated questions had one immortal thread. Here a reply to a
// CLOSED ticket mints a NEW ticket rather than resurrecting the old one. That
// single rule is what stops a ticket decaying back into a per-person thread.
//
// Everything here is pure (no DB, no env, no clock) so the webhook's decisions
// are unit-testable; the route owns the queries and passes `now` in.

/**
 * Given the ticket an inbound message threaded to (or null), decide whether
 * to append to it or mint a new one.
 *
 * `reopen` and `reopenedFrom` mean OPPOSITE things:
 *   • append + reopen: true     — THIS ticket goes back to open
 *   • create + reopenedFrom: X  — a NEW ticket; X stays CLOSED, and is merely
 *     its predecessor. Never write status='open' against X.
 *
 * @param {{ id?: string, status: string }|null} threadedTicket
 * @returns {{ action: 'append', ticketId: string, reopen: boolean }
 *          |{ action: 'create', reopenedFrom: string|null }}
 */
export function resolveTicketAction(threadedTicket) {
  if (!threadedTicket || !threadedTicket.id) {
    return { action: 'create', reopenedFrom: null }
  }
  // A CLOSED ticket reopens on reply — it does NOT fork into a new one
  // (Richard, 2026-08-07). Closing is internal bookkeeping: the member is never
  // told a ticket closed, so from their side they are simply continuing the
  // conversation, and splitting their reply into a second ticket would make the
  // studio's own record disagree with the thread sitting in their mail client.
  //
  // An earlier draft forked here, to stop a ticket decaying into mig 394's
  // immortal per-person thread. That worry was already covered elsewhere and
  // better: RFC threading headers are what separate one issue from the next, so
  // a genuinely new enquiry has no In-Reply-To/References match, resolves to no
  // ticket at all, and starts a fresh one via the branch above. Closing was a
  // second, redundant boundary — and the only one a member could trip by
  // replying to their own old email.
  return {
    action: 'append',
    ticketId: threadedTicket.id,
    reopen: threadedTicket.status !== 'open',
  }
}

/**
 * First-response time is a support metric, so it counts only a real outbound
 * reply the member could actually receive — never an inbound, never an
 * internal note, and never a second time.
 *
 * @param {{ firstResponseAt: string|null, direction: 'inbound'|'outbound',
 *           isInternalNote: boolean }} args
 * @returns {boolean}
 */
export function shouldStampFirstResponse({ firstResponseAt, direction, isInternalNote }) {
  if (firstResponseAt) return false
  if (direction !== 'outbound') return false
  return !isInternalNote
}

/**
 * A ticket is named by the issue that opened it. Deliberately unlike mig 394,
 * where `subject` tracked the most recent inbound and a thread's name drifted
 * with every "Re: Re: Fwd:".
 */
export function ticketSubject(existingSubject, inboundSubject) {
  if (existingSubject) return existingSubject
  const s = typeof inboundSubject === 'string' ? inboundSubject.trim() : ''
  return s || '(no subject)'
}

/**
 * The message id at which each address first appears on the thread, so the UI
 * can say WHERE someone joined. Derived, never stored — first appearance is a
 * property of the messages that arrived.
 *
 * WHY THIS EXISTS (EMAIL-PARTICIPANTS.8)
 * A ticket opened by ratesoffice@dublincity.ie was forwarded internally to a
 * named officer, who replied. From that message on the conversation was with
 * her — and nothing on screen said so, so an operator answered the wrong
 * person twice. The recipient half of that is fixed upstream; this is the fact
 * the thread needs to SHOW it, against the message she actually arrived on.
 *
 * THE OPENING MESSAGE REPORTS NOBODY, and that is a rule about the thread
 * rather than a rendering preference, which is why it lives here where the
 * pure tests can pin it. The people on the first message did not JOIN the
 * conversation — they started it. Saying they joined claims an arrival at
 * something that already existed, and a marker that fires on every ticket's
 * first message means "is present" rather than "is new", which is neither what
 * it says nor what it is for. Their addresses are still consumed, so nobody
 * gets announced later for having been there from the start.
 *
 * The opener is the first message that NAMES anybody: a row carrying no
 * addresses at all started nothing, and counting it would hand the opening
 * message's silence to the real first message instead.
 *
 * Internal notes and forwards are skipped for the same reason they are skipped
 * when building the audience: a note names nobody, and a forward shows the
 * thread to someone rather than adding them to it. Skipped, note, means the
 * addresses on them are not consumed either — someone first seen on a forward
 * still joins properly on the message they themselves write — and it means
 * neither can be the opening message.
 *
 * `bcc_emails` IS DELIBERATELY ABSENT from the field list. A Bcc'd person is
 * not visibly on the thread, and announcing them would leak the Bcc to
 * everyone reading the ticket. Do not add it.
 *
 * @param {object[]} messages  ascending by created_at
 * @returns {Map<string, string[]>}  message id → addresses first seen there
 */
export function joinPointsByMessage(messages) {
  const seen = new Set()
  const out = new Map()
  let opened = false
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.is_internal_note || m.forwarded_message_id) continue
    // The legacy scalar fallback, mirroring messageEnvelope()
    // (src/lib/ticket-display.js). Migrations
    // backfilled `to_emails`, so a scalar-only row should not exist — but two
    // functions in the same feature disagreeing about whether to trust that is
    // the smell, and the failure is not inert: an unread recipient on the
    // OPENING message stays unconsumed, and the requester's own first reply
    // then raises a false "joined this thread".
    const toList = Array.isArray(m.to_emails) ? m.to_emails.filter(Boolean) : []
    const to = toList.length ? toList : (m.to_email ? [m.to_email] : [])
    const here = []
    for (const raw of [m.from_email, ...to, ...(m.cc_emails || [])]) {
      const a = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
      if (!a || seen.has(a)) continue
      seen.add(a)
      here.push(a)
    }
    if (!here.length) continue
    // Consumed above, reported nowhere: this is the message they started.
    if (!opened) {
      opened = true
      continue
    }
    out.set(m.id, here)
  }
  return out
}

/**
 * Which ticket a set of threading-matched message rows belongs to.
 *
 * A long reply chain touches many of our messages, so several rows can match
 * one In-Reply-To/References header. The most recent wins: a member replying
 * to an old message in a thread that has since moved on means the live ticket,
 * not the archived one.
 *
 * Ties break on the lowest ticket id so the result is deterministic — rows
 * written in one transaction share a timestamp, and a coin-flip there is the
 * same class of bug as routing by database row order.
 *
 * @param {Array<{ticket_id: string|null, created_at: string}>} rows
 * @returns {string|null} ticket id, or null if nothing threads
 */
export function pickThreadedTicket(rows) {
  if (!Array.isArray(rows)) return null
  let bestId = null
  let bestAt = -Infinity
  for (const r of rows) {
    if (!r?.ticket_id) continue
    const at = Date.parse(r.created_at ?? '')
    if (!Number.isFinite(at)) continue
    if (at > bestAt || (at === bestAt && String(r.ticket_id) < String(bestId))) {
      bestAt = at
      bestId = r.ticket_id
    }
  }
  return bestId
}

// ── MAIL-REFINE.1 — the auto-merge-at-ingest subject key ─────────────────
// A fresh inbound with no RFC thread match can still be the same conversation:
// some clients (and some people) start a "reply" as a new email, so the chain
// breaks while the subject survives as "RE: <original>". Same sender + same
// key on an OPEN thread of the same mailbox → the webhook appends instead of
// forking. The key errs strict: prefix noise is forgiven, nothing else is —
// a false match would file a stranger topic into the wrong thread, which is
// worse than the duplicate it prevents.

const REPLY_PREFIX = /^(re|fwd?|fw)(\[\d+\])?:\s*/i

/**
 * @param {string|null|undefined} subject
 * @returns {string|null} the comparison key, or null when nothing meaningful
 *   remains — and a null key must never be treated as a match.
 */
export function normalizedSubjectKey(subject) {
  if (typeof subject !== 'string') return null
  let s = subject.trim()
  // Strip repeated reply/forward prefixes ("Re: FW: x", "re[2]: x").
  for (let guard = 0; guard < 10 && REPLY_PREFIX.test(s); guard++) {
    s = s.replace(REPLY_PREFIX, '').trim()
  }
  s = s.replace(/\s+/g, ' ').toLowerCase()
  return s || null
}

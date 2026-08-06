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
  if (threadedTicket.status === 'closed') {
    return { action: 'create', reopenedFrom: threadedTicket.id }
  }
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

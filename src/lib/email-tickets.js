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

/** Default window before a solved ticket closes itself. Operator-editable. */
export const DEFAULT_AUTO_CLOSE_DAYS = 7

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
 * Solved tickets past the auto-close window. Pure: the caller passes `now` in
 * milliseconds so this is testable without faking a clock.
 *
 * `autoCloseDays` must already be a real number — this does not coerce.
 * `Number(x)` maps `null`, `''`, `false` and `[]` all to `0`, which is exactly
 * the shape an unset Postgres settings column or an empty form field takes,
 * so a coercing guard would let those through and mass-close every solved
 * ticket. Anything that isn't already a finite, non-negative number returns
 * nothing rather than closing the whole queue — failing closed is correct
 * here; a stringly-typed `'7'` is a caller bug to fix upstream, not something
 * to paper over in this function. An explicit `0` stays legal and means
 * "close as soon as solved".
 */
export function ticketsDueForAutoClose(tickets, autoCloseDays, nowMs) {
  if (!Array.isArray(tickets)) return []
  if (typeof autoCloseDays !== 'number' || !Number.isFinite(autoCloseDays) || autoCloseDays < 0) return []
  const cutoff = nowMs - autoCloseDays * 86_400_000
  return tickets.filter((t) => {
    if (t?.status !== 'solved') return false
    const solved = Date.parse(t?.solved_at ?? '')
    return Number.isFinite(solved) && solved <= cutoff
  })
}

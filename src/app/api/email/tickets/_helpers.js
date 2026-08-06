// EMAIL-TICKET.4 — shared access resolution for the ticket routes.
// Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
//
// WHY THIS FILE EXISTS
// Every /api/email/tickets route runs on the service-role client, so RLS does
// NOTHING here — this code IS the gate. The gate has two levels and both have
// to be applied on every single route, so they live in one place:
//
//   1. the `email_inbox` permission gates the SURFACE (checked in each route,
//      next to getCurrentUser, so check:route-guards can see it)
//   2. a row in email_mailbox_access gates each individual ACCOUNT (here)
//
// THE RULE THAT MATTERS
// A caller must never see a ticket whose mailbox is not in their visible set.
// `accounts@` carries billing correspondence a coach has no business reading,
// and a location-scoped check alone would hand it to them — every staffer at
// the studio passes assertLocationAccess. The mailbox is the access unit.
//
// Master and owner-at-location are elevated and need no grant rows.

import { NextResponse } from 'next/server'
import { assertLocationAccessOr404, guardMasterOrOwner } from '@/lib/auth'
import { visibleMailboxes, orderMailboxTabs } from '@/lib/email-mailboxes'

const MAILBOX_COLUMNS = 'id, location_id, address, label, is_default, active'

// Both sets are tiny (a studio has a handful of addresses; a person a handful
// of grants), but every .select() caps at 1,000 rows whatever the caller asks
// for, so the bounds are stated explicitly rather than left implicit.
const MAILBOX_LIMIT = 200
const GRANT_LIMIT = 500

/**
 * Is this caller elevated at this location — i.e. master, or owner here?
 *
 * Deliberately delegates to guardMasterOrOwner rather than re-deriving
 * `profileRole === 'master' || rolesByLocation[id] === 'owner'`: that guard is
 * the estate's single definition of "master or owner at this location", and it
 * returns null for yes / a 403 response for no, so a null result IS the
 * boolean. One definition, so a future change to it moves this too. (It also
 * covers SAAS-4 org admins, who carry a synthetic 'owner' role.)
 */
export function isElevatedAtLocation(user, locationId) {
  if (!user || !locationId) return false
  return guardMasterOrOwner(user, locationId) === null
}

/**
 * The mailboxes this caller may see at this location, ordered for the tab
 * strip (default first, then label A→Z).
 *
 * Returns `{ elevated, mailboxes }`. An empty `mailboxes` is a normal state —
 * a studio with no addresses, or a person with no grants — and callers must
 * render it as an empty inbox, never as an error.
 *
 * @param {object} db  service-role client
 * @param {object} user  getCurrentUser() result
 * @param {string} locationId
 */
export async function loadVisibleMailboxes(db, user, locationId) {
  const elevated = isElevatedAtLocation(user, locationId)

  // Elevated callers need no grant rows, so skip the query entirely rather
  // than fetching rows we would ignore.
  const [mailboxRes, grantRes] = await Promise.all([
    db.from('email_mailboxes')
      .select(MAILBOX_COLUMNS)
      .eq('location_id', locationId)
      .limit(MAILBOX_LIMIT),
    elevated
      ? Promise.resolve({ data: [] })
      : db.from('email_mailbox_access')
        .select('mailbox_id')
        .eq('profile_id', user?.id)
        .limit(GRANT_LIMIT),
  ])

  // Grants are not location-scoped (the mailbox carries the location), so a
  // grant on another studio's address simply never intersects this list.
  const mailboxes = orderMailboxTabs(visibleMailboxes(mailboxRes?.data || [], {
    isElevated: elevated,
    grantedMailboxIds: (grantRes?.data || []).map(g => g.mailbox_id),
  }))

  return { elevated, mailboxes }
}

/** 404, never 403 — a detail route must not confirm that an id exists. */
export function ticketNotFound() {
  return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
}

/**
 * Load a ticket for a caller, or the 404 that says they may not have it.
 *
 * Three ways to get a 404, all indistinguishable from outside:
 *   • no such ticket
 *   • the ticket is at a location the caller has no access to
 *   • the ticket is on a mailbox the caller cannot see
 *
 * A ticket with NULL mailbox_id is visible to ELEVATED callers only. That is
 * not a hypothetical: email_tickets.mailbox_id is ON DELETE SET NULL, so
 * removing a mailbox orphans its correspondence, and mig 484's backfill
 * predates the column. No mailbox means no grant can exist, so falling back to
 * "the people who need no grants" keeps the history reachable by an owner
 * without ever widening it to a coach.
 *
 * @returns {{ response: NextResponse } | { ticket: object, mailbox: object|null, elevated: boolean }}
 */
export async function loadTicketForUser(db, user, ticketId) {
  const { data: ticket, error } = await db.from('email_tickets')
    .select('*')
    .eq('id', ticketId)
    .maybeSingle()
  // A malformed id is a Postgres cast error (22P02), not a row — same 404.
  if (error || !ticket) return { response: ticketNotFound() }

  const guard = assertLocationAccessOr404(user, ticket.location_id)
  if (guard) return { response: guard }

  const { elevated, mailboxes } = await loadVisibleMailboxes(db, user, ticket.location_id)
  const mailbox = ticket.mailbox_id
    ? mailboxes.find(m => m.id === ticket.mailbox_id) || null
    : null
  const visible = ticket.mailbox_id ? !!mailbox : elevated
  if (!visible) return { response: ticketNotFound() }

  return { ticket, mailbox, elevated }
}

/**
 * The solved_at / closed_at stamps that go with a status.
 *
 * Moving INTO solved/closed stamps the timestamp (keeping an existing one, so
 * re-solving an already-solved ticket doesn't rewrite history); moving OUT
 * clears it. `closed` keeps solved_at, because a ticket that was solved and
 * then closed genuinely was both.
 */
export function statusTimestamps(status, ticket, now) {
  if (status === 'solved') return { solved_at: ticket?.solved_at || now, closed_at: null }
  if (status === 'closed') return { solved_at: ticket?.solved_at || null, closed_at: ticket?.closed_at || now }
  return { solved_at: null, closed_at: null }
}

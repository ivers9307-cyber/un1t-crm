// EMAIL-TICKET.4 — shared access resolution for the ticket routes.
// Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
//
// WHY THIS FILE EXISTS
// Every /api/email/tickets route runs on the service-role client, so RLS does
// NOTHING here — this code IS the gate. The gate has two levels and both have
// to be applied on every single route, so they live in one place:
//
//   1. the `email_inbox` permission gates the SURFACE
//   2. a row in email_mailbox_access gates each individual ACCOUNT
//
// THE RULE THAT MATTERS
// A caller must never see a ticket whose mailbox is not in their visible set.
// `accounts@` carries billing correspondence a coach has no business reading,
// and a location-scoped check alone would hand it to them — every staffer at
// the studio passes assertLocationAccess. The mailbox is the access unit.
//
// Master and owner-at-location are elevated and need no grant rows.
//
// EMAIL-TICKET-CLEANUP.1 — LEVEL 1 MOVED IN HERE, FOR THE DETAIL ROUTES.
// It used to sit at the top of each route as hasPermission(user, 'email_inbox'),
// which resolves against the caller's ACTIVE location — a different question
// from the one a ticket route is asked, because the ticket names its own
// location. One user, two studios, and it answered wrong in BOTH directions:
// a manager at Stillorgan who is only staff at Hatch could open Hatch's
// `accounts@` correspondence whenever their session happened to point at
// Stillorgan (they hold email_inbox *there*), and was refused Stillorgan's own
// queue whenever it pointed at Hatch. The list route fixed exactly this for
// itself in EMAIL-TICKET.5 — it takes location_id as a parameter, so it could
// resolve at the target directly. A detail route cannot: the location is only
// knowable once the ticket row is read, so the check is ORDERING-SENSITIVE and
// has to run after the load. That is why it lives here now rather than in five
// copies that would each have to remember to run late.
//
// It is NOT redundant with the two checks below it. loadTicketForUser gates on
// location ACCESS and on mailbox VISIBILITY; neither asks whether the caller
// holds the email_inbox key. A staffer with a mailbox grant but the surface
// switched off would sail through both — grants are minted on the mailbox-admin
// surface, and nothing there requires the grantee to hold email_inbox.

import { NextResponse } from 'next/server'
import { assertLocationAccessOr404, guardMasterOrOwner } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
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
 * 500 for a visibility lookup that FAILED, as opposed to one that legitimately
 * came back empty (EMAIL-TICKET-CLEANUP.2).
 *
 * The two are opposite answers and used to be the same one. `mailboxRes.data`
 * is null on a PostgREST error, so `|| []` turned "we could not find out what
 * you may read" into "you may read nothing" — and every caller renders that as
 * a calm, empty inbox. An operator reads an empty inbox as "no mail", stops
 * looking, and nobody ever learns the query failed. It is the same
 * silent-wrong-answer shape EMAIL-TICKET.6 fixed for the message thread and
 * EMAIL-ATTACH.1 fixed for the attachment list.
 *
 * Unlike `attachments_unavailable` this is NOT a soft flag on an otherwise
 * complete payload, because there is nothing left to degrade to: the visible
 * set is what scopes the ticket query, so without it there is no correct list
 * to show at all. Refusing is the only honest answer.
 */
export function mailboxesUnavailable() {
  return NextResponse.json({
    success: false,
    error: 'Could not check which email accounts you can see. Nothing was changed — try again.',
  }, { status: 500 })
}

/**
 * The mailboxes this caller may see at this location, ordered for the tab
 * strip (default first, then label A→Z).
 *
 * Returns `{ elevated, mailboxes }` — or `{ response }` when the lookup itself
 * failed, which callers MUST return rather than treating as an empty set.
 *
 * An empty `mailboxes` is still a normal state — a studio with no addresses, or
 * a person with no grants — and callers must render THAT as an empty inbox,
 * never as an error. The whole point of the split return is that the two
 * outcomes stopped being the same value.
 *
 * @param {object} db  service-role client
 * @param {object} user  getCurrentUser() result
 * @param {string} locationId
 * @returns {Promise<{ response: NextResponse } | { elevated: boolean, mailboxes: object[] }>}
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
      ? Promise.resolve({ data: [], error: null })
      : db.from('email_mailbox_access')
        .select('mailbox_id')
        .eq('profile_id', user?.id)
        .limit(GRANT_LIMIT),
  ])

  // BOTH queries decide visibility, so both have to be inspected. A failed
  // grant lookup is the more dangerous of the two: it silently demotes a
  // granted coach to "no accounts" while the mailbox list itself loads fine,
  // so the surface looks healthy and simply shows them nothing.
  if (mailboxRes?.error || grantRes?.error) {
    console.error(
      '[email/tickets] mailbox visibility lookup failed:',
      mailboxRes?.error?.message || grantRes?.error?.message
    )
    return { response: mailboxesUnavailable() }
  }

  // Grants are not location-scoped (the mailbox carries the location), so a
  // grant on another studio's address simply never intersects this list.
  const mailboxes = orderMailboxTabs(visibleMailboxes(mailboxRes?.data || [], {
    isElevated: elevated,
    grantedMailboxIds: (grantRes?.data || []).map(g => g.mailbox_id),
  }))

  return { elevated, mailboxes }
}

const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Narrow an email_tickets query to the mailboxes this caller may see.
 *
 * Extracted from the list route in EMAIL-TICKET-CLEANUP.3 so the queue and the
 * nav badge cannot disagree about what a person can see. A badge counting rows
 * the list then refuses to show is worse than no badge — the operator clicks it,
 * finds nothing, and learns to ignore the red dot.
 *
 * Elevated callers ALSO get tickets with no mailbox at all: mig 484's backfill
 * predates the column and mailbox_id is ON DELETE SET NULL, so deleting an
 * address would otherwise erase its correspondence from every queue. `.in()`
 * never matches NULL, hence the `.or()`.
 *
 * `.or()` takes a RAW PostgREST filter string, so the ids are shape-checked
 * first and the whole branch falls through to the escaped `.in()` if any id is
 * not a plain uuid. (Same hazard the inbound webhook avoids by using two
 * `.in()` queries rather than one `.or()`.) The length check keeps an empty
 * visible set from generating a malformed `in.()` — both callers return early
 * on that today, but this function is now shared and must not depend on it.
 */
export function scopeToVisibleMailboxes(query, { mailboxes, elevated }) {
  const visibleIds = (mailboxes || []).map(m => m.id)
  if (elevated && visibleIds.length > 0 && visibleIds.every(id => UUID_SHAPE.test(id))) {
    return query.or(`mailbox_id.in.(${visibleIds.join(',')}),mailbox_id.is.null`)
  }
  return query.in('mailbox_id', visibleIds)
}

/**
 * "They wrote to us and nobody has answered yet" — ONE definition, shared by
 * the `needs_reply` view and the nav badge (EMAIL-TICKET-CLEANUP.3).
 *
 * `open` alone is not it: a ticket we composed starts `open` with an OUTBOUND
 * last message, and there is nothing to do about mail we just sent. `pending`
 * is not it either — that means we already replied and the ball is with the
 * member. Since NOTHING in this feature auto-closes (Richard, 2026-08-06),
 * counting either of those would produce a badge that only ever grows, and a
 * number nobody can drive to zero is a number everybody learns to ignore.
 *
 * This one clears itself the moment the work is actually done: replying flips
 * the ticket to `pending` with an outbound last message, and closing it leaves
 * `open` behind. Both are the operator finishing the job.
 */
export function scopeToNeedsReply(query) {
  return query.eq('status', 'open').eq('last_message_direction', 'inbound')
}

/** 404, never 403 — a detail route must not confirm that an id exists. */
export function ticketNotFound() {
  return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
}

/**
 * Load a ticket for a caller, or the 404 that says they may not have it.
 *
 * Four ways to get a 404, all indistinguishable from outside:
 *   • no such ticket
 *   • the ticket is at a location the caller has no access to
 *   • the caller does not hold `email_inbox` AT THAT LOCATION
 *   • the ticket is on a mailbox the caller cannot see
 *
 * The permission refusal is a 404 like the other three, not the 403 the routes
 * used to return, and that is deliberate. Once the check resolves at the
 * TICKET'S location it can only run after the row is read, so a 403 there would
 * mean "this id exists, at a studio where you lack the key" while a bad id
 * means 404 — an existence oracle bolted onto a surface whose whole posture is
 * that refusals are indistinguishable. The header docstring's promise is that
 * every way to be refused looks the same; a fourth reason has to keep it.
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

  // LEVEL 1, resolved at the TICKET'S location rather than the caller's active
  // one — see the file header. It runs after assertLocationAccessOr404 so the
  // cheaper, broader refusal wins first and the two can't disagree.
  if (!hasPermissionForLocation(user, ticket.location_id, 'email_inbox')) {
    return { response: ticketNotFound() }
  }

  const visibility = await loadVisibleMailboxes(db, user, ticket.location_id)
  // A FAILED visibility lookup is not "no mailboxes" (EMAIL-TICKET-CLEANUP.2).
  // Left as an empty set it made every detail route answer 404 — telling an
  // operator the ticket they are looking at does not exist, on the strength of
  // a blipped query.
  if (visibility.response) return { response: visibility.response }
  const { elevated, mailboxes } = visibility

  const mailbox = ticket.mailbox_id
    ? mailboxes.find(m => m.id === ticket.mailbox_id) || null
    : null
  const visible = ticket.mailbox_id ? !!mailbox : elevated
  if (!visible) return { response: ticketNotFound() }

  return { ticket, mailbox, elevated }
}

/**
 * Resolve a mailbox a caller is allowed to SEND AS, or the 404 that says they
 * may not.
 *
 * EMAIL-OUTBOUND-ATTACH.1 extracted this from the compose route verbatim,
 * because a second surface now has to answer the identical question: an
 * attachment upload for a NEW email is authorised against the mailbox it will
 * be sent from, exactly as the send itself is. Two copies of that resolution
 * would be two definitions of who may send as `accounts@`, and the first one to
 * be forgotten is the leak — the same argument the attachment routes' shared
 * gate is built on.
 *
 * THE ORDER IS LOAD-BEARING and is the compose route's own, unchanged:
 *   1. read the mailbox row — the caller does NOT get to name a location, it is
 *      read off the mailbox, so a send can only ever land at the studio that
 *      owns the sending address. Nothing is trusted from this row until 2 and 3
 *      have passed.
 *   2. assertLocationAccessOr404 at THAT location.
 *   3. `email_inbox` at THAT location — not at the caller's active one. It
 *      cannot sit above step 1 (there is no location to resolve against yet),
 *      and it refuses with the same 404 as an unusable mailbox: a 403 would
 *      separate "that mailbox exists, elsewhere" from "no such mailbox" and
 *      hand back the enumeration this surface is careful not to give.
 *   4. the PER-ACCOUNT gate — the mailbox must come back from
 *      loadVisibleMailboxes, and the row returned is THAT one, never the one
 *      the caller named. This is what stops someone with sales@ sending as
 *      accounts@.
 *
 * @returns {Promise<{ response: NextResponse } | { mailbox: object, locationId: string }>}
 */
export async function loadSendingMailbox(db, user, mailboxId) {
  const { data: named, error: mailboxErr } = await db.from('email_mailboxes')
    .select('id, location_id')
    .eq('id', mailboxId)
    .maybeSingle()
  if (mailboxErr || !named) return { response: ticketNotFound() }

  const guard = assertLocationAccessOr404(user, named.location_id)
  if (guard) return { response: guard }

  if (!hasPermissionForLocation(user, named.location_id, 'email_inbox')) {
    return { response: ticketNotFound() }
  }

  const visibility = await loadVisibleMailboxes(db, user, named.location_id)
  // A FAILED visibility lookup is not "no mailboxes" (EMAIL-TICKET-CLEANUP.2).
  // Left as an empty set it 404'd — telling the operator the address they just
  // picked does not exist.
  if (visibility.response) return { response: visibility.response }

  const mailbox = visibility.mailboxes.find(m => m.id === mailboxId) || null
  if (!mailbox) return { response: ticketNotFound() }

  return { mailbox, locationId: mailbox.location_id }
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

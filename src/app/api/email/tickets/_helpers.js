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
import {
  ticketParticipants, normalizeAddressList, replyMode, MAX_RECIPIENTS,
} from '@/lib/email-recipients'

// MAILBOX-CONNECT.7 — `egress` ('postmark' | 'smtp', mig 572) rides along.
// There is no select('*') on email_mailboxes anywhere in this repo, so a
// column is invisible to the API until a named list asks for it, and this is
// the list every ticket route's mailbox object comes from (loadTicketForUser
// and loadSendingMailbox both resolve through loadVisibleMailboxes below).
// sendTicketEmail reads `mailbox.egress` to choose its transport; without the
// column it would read `undefined` on a connected mailbox and quietly keep
// sending that customer's replies through Postmark — signed by a domain they
// do not own, i.e. the exact DMARC failure the connector exists to remove, and
// with no error anywhere to say so. It is not a secret: an enum naming which
// way mail leaves, never a host, a username or a credential.
// (RETIRE-TICKETS.1 — `surface` no longer rides along: mig 578 deprecated the
// column when the mig-575 A/B ended, and nothing reads it. The
// mailboxesForSurface split that lived here went with it.)
const MAILBOX_COLUMNS = 'id, location_id, address, label, is_default, active, egress'

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

/**
 * EMAIL-CC.1 — every address that belongs to US at this location, so no send
 * path can write to one.
 *
 * WHY THIS IS A 500 AND NOT A BEST-EFFORT `|| []`
 * A reply-all is derived from a thread that necessarily contains the address
 * the member wrote TO — one of ours. Without this list we would put it on the
 * wire, Postmark would deliver our own reply back to our own inbound webhook,
 * and the webhook would file it on the SAME ticket as an inbound message
 * (its In-Reply-To still names the thread): the ticket flips back to `open`,
 * unread_count increments, and the needs-reply badge lights up for mail nobody
 * sent us. Once per reply, forever. Nothing has been sent at the point this is
 * called, so refusing costs a retry and can never produce a wrong outcome —
 * the same ordering argument the reply and compose routes already make about
 * their pre-send lookups.
 *
 * DELIBERATELY NOT FILTERED TO ACTIVE, deliberately not scoped to the
 * caller's visible set, and — since the 2026-08-08 audit — deliberately not
 * scoped to a LOCATION either. A deactivated mailbox still owns its address as
 * far as DNS and Postmark's inbound routing are concerned, and "which
 * addresses are ours" is not a question about who is asking OR about which
 * studio the ticket sits at: a member who cc'd a SISTER studio's address would
 * otherwise get our reply-all delivered into that studio's inbound webhook,
 * where nothing threads (threading is location-scoped), minting a recurring
 * phantom "inbound" ticket there from our own address. The list is used ONLY
 * as an exclusion set — it is never returned to a client, so it leaks nothing
 * about what addresses any studio runs.
 *
 * @param {object} db  service-role client
 * @returns {Promise<{ response: NextResponse } | { addresses: string[] }>}
 */
export async function loadOwnAddresses(db) {
  const { data, error } = await db.from('email_mailboxes')
    .select('address')
    .limit(MAILBOX_LIMIT)
  if (error) {
    console.error('[email/tickets] own-address lookup failed BEFORE sending:', error.message)
    return {
      response: NextResponse.json({
        success: false,
        error: 'Could not check which addresses are yours. Nothing was sent — try again.',
      }, { status: 500 }),
    }
  }
  const { valid } = normalizeAddressList([
    ...(data || []).map(m => m?.address),
    // The From every ticket send actually goes out as. Excluded for the same
    // reason as a mailbox address: a reply-all derived from one of our own
    // outbound messages would otherwise carry it.
    process.env.POSTMARK_FROM_EMAIL,
  ])
  return { addresses: valid }
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
  // INBOX-SURFACE.C — an ELEVATED caller with an empty id set still gets the
  // orphans. Before the trial that combination could not arise (the two callers
  // returned early on an empty visible set, and the branch above covered the
  // rest), so it fell through to `.in('mailbox_id', [])` — which matches
  // nothing, NULLs included. It arises now: a studio can legitimately move
  // EVERY mailbox to the inbox surface, leaving the ticket queue with no
  // mailboxes but still holding tickets whose mailbox was deleted
  // (ON DELETE SET NULL) or which predate the column (mig 484's backfill).
  // Falling through would have made those vanish from the only surface that
  // shows them — a visible record silently disappearing, which is the one
  // outcome this split must never produce.
  if (elevated && visibleIds.length === 0) return query.is('mailbox_id', null)
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
  // MAIL-SPAM.1 — a QUARANTINED conversation never needs a reply, however
  // open-with-an-inbound-last-message it looks. Part of the ONE definition
  // rather than a separate scope so every consumer (list badge, nav badge,
  // digest tile, home queue, needs_reply view) drops spam in the same edit.
  return query.eq('status', 'open').eq('last_message_direction', 'inbound').eq('is_spam', false)
}

/**
 * MAIL-SPAM.1 — the quarantine, as a scope. A quarantined ticket (mig 584
 * `is_spam`) appears in EXACTLY ONE place, the `spam` view; every other view,
 * count and search excludes it. Applied by applyView (so the digest and the
 * scoped list agree) and by the list route's SEARCH branch, which bypasses
 * applyView — a search from the inbox must not surface quarantined mail, and
 * a search from the Spam view must show nothing else.
 *
 * Old mobile bundles never send `view=spam`, so every request they can make
 * lands on the `is_spam = false` side by construction.
 */
export function scopeToSpamView(query, view) {
  return view === 'spam' ? query.eq('is_spam', true) : query.eq('is_spam', false)
}

/**
 * Hide merged-away tickets (EMAIL-MERGE.3, mig 536).
 *
 * ONE definition, applied by every surface that lists or counts tickets. A
 * tombstone missed by a filter shows up as an ordinary closed ticket — which is
 * the duplicate this feature exists to remove, wearing a different hat.
 *
 * Status cannot do this job, and that is by design: a merged ticket is `closed`
 * plus a pointer rather than a fifth enum value, so the `closed` view — which
 * asks for exactly solved+closed — is precisely where a tombstone would surface
 * looking like ordinary resolved history. The pointer is the only thing that
 * distinguishes it, so the pointer is what the scope keys on. That also covers
 * the half-applied merge (pointer stamped, status write lost), which no
 * status-based filter could.
 *
 * `.is(col, null)` is the ONLY correct null filter here — `.eq(col, null)`
 * matches nothing in PostgREST, and the failure would be an inbox that empties
 * itself and a badge stuck at zero.
 */
export function scopeToUnmerged(query) {
  return query.is('merged_into_id', null)
}

/** 404, never 403 — a detail route must not confirm that an id exists. */
export function ticketNotFound() {
  return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
}

/**
 * EMAIL-MERGE.6 — refuse a SEND from a ticket that has been merged away.
 *
 * THE ROUTE IS THE GATE, THE UI IS AN AFFORDANCE. TicketThread hides the
 * composer on a tombstone, and that guard is worth keeping — but these routes
 * run on the service-role client, so RLS does nothing and a client-side check
 * is not a check at all. Anything holding a ticket id can still POST: a stale
 * tab, a bookmarked deep link, a push notification opened after somebody else
 * merged, a direct API call — and THE MOBILE APP, which has no concept of
 * merge whatsoever, polls, and ships a reply button. A ticket that becomes a
 * tombstone while a phone has it open is the case that will actually happen.
 *
 * WHAT IT PREVENTS is precisely the failure this feature exists to remove: the
 * reply reaches the member, and is then filed on a ticket scopeToUnmerged hides
 * from every queue and count — so nobody sees it was answered, and the next
 * person answers again. A duplicate reply, produced by the duplicate-reply fix.
 *
 * 409, NOT 404, and deliberately so. Every other refusal on this surface is a
 * 404 because the caller must not learn whether an id exists — but they have
 * already passed loadTicketForUser here, so they can see this ticket and are
 * owed a reason. The ticket genuinely exists; the request conflicts with what
 * it has become. It is the same code the merge route returns for the lost
 * race, which is the same shape of answer: you are acting on a state that has
 * moved out from under you.
 *
 * merged_into_id RIDES ON THE FAILURE BODY so a client can route to the
 * survivor rather than dead-ending. `data` on a failure body is this surface's
 * existing idiom (the reply route's own `data.sent` unfiled case).
 */
export function ticketMergedAway(ticket) {
  return NextResponse.json({
    success: false,
    error: 'This ticket was merged into another one, so nothing can be sent from it. Open the ticket it was merged into and send from there.',
    data: { merged_into_id: ticket?.merged_into_id || null },
  }, { status: 409 })
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

/**
 * How many messages the audience is derived from.
 *
 * The reply route used to scan 10, which on a ticket with 11+ internal notes
 * could push every real correspondent out of the window and silently narrow
 * "Reply All (N)". A union has to see the whole conversation. 500 is far above
 * any real support thread and still bounded — an unbounded select would hit
 * PostgREST's 1,000-row cap and truncate without saying so.
 */
export const PARTICIPANT_SCAN_LIMIT = 500

// bcc_emails IS NOT SELECTED, so no caller can leak it into a recipient list
// even if the derivation changed. forwarded_message_id IS, because a forward
// row must be recognisable in order to be skipped. `direction` IS
// (EMAIL-PARTICIPANTS.12) because ticketParticipants reads the newest message
// two different ways — inbound leads with its From, outbound with its first To
// — and without the column that decision falls back to the weaker signal
// (is the From one of ours), which is right but only as far as `ownAddresses`
// happens to be complete.
const PARTICIPANT_COLUMNS =
  'direction, from_email, to_email, to_emails, cc_emails, is_internal_note, forwarded_message_id, created_at, sent_at'

/**
 * The one message window both the detail route and the reply route derive from.
 * Two windows would be two answers to "who does this reach".
 *
 * Deliberately returns the raw supabase result rather than the
 * `{ response } | { ... }` shape used by loadOwnAddresses/loadTicketForUser:
 * those wrap access/visibility failures into one canonical refusal, but a
 * content-query failure here logs a route-specific message at each call site
 * (as the pre-existing message queries in both routes already did), so the
 * error stays in the caller's hands.
 *
 * @param {object} db  service-role client
 * @param {string} ticketId
 * @returns {Promise<{ data: object[]|null, error: object|null }>}
 */
export async function loadParticipantMessages(db, ticketId) {
  return db.from('email_inbox_messages')
    .select(PARTICIPANT_COLUMNS)
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: false })
    .limit(PARTICIPANT_SCAN_LIMIT)
}

/**
 * Who a reply reaches, and whether it may be sent at all.
 *
 * `empty` is a real answer, not a failure: an operator who removes every
 * participant has said something deliberate, and mailing someone they took off
 * is not an acceptable way to avoid an error message.
 *
 * @returns {{ to: string[], mode: 'reply'|'reply_all', over_cap: boolean, empty: boolean }}
 */
export function resolveReplyAudience({ messages, ticket, ownAddresses }) {
  const removed = ticket?.excluded_participants || []
  const off = new Set(normalizeAddressList(removed).valid)

  const derived = ticketParticipants(messages || [], {
    exclude: ownAddresses || [],
    removed,
  })
  // Exclusions apply to the fallback too — see _helpers.test.js: 'does not
  // resurrect an excluded requester through the fallback'.
  const fallback = normalizeAddressList([ticket?.requester_email])
    .valid.filter(a => !off.has(a))

  const to = derived.length ? derived : fallback
  return {
    to,
    mode: replyMode(to),
    over_cap: to.length > MAX_RECIPIENTS,
    empty: to.length === 0,
  }
}


/**
 * MAIL-SIG.2 — the sending studio's signature context, best-effort: the
 * studio-dependent parts of a signature follow the account the email leaves
 * from, and a blipped read must degrade to the person's own fallback values,
 * never block or fail a send.
 */
export async function loadSignatureContext(db, locationId) {
  if (!locationId) return { locationName: null, locationSignature: null }
  try {
    const [locRes, csRes] = await Promise.all([
      db.from('locations').select('name').eq('id', locationId).maybeSingle(),
      db.from('company_settings').select('email_signature').eq('location_id', locationId).maybeSingle(),
    ])
    return {
      locationName: locRes?.data?.name || null,
      locationSignature: csRes?.data?.email_signature || null,
    }
  } catch {
    return { locationName: null, locationSignature: null }
  }
}

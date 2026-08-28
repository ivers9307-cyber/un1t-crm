// MAIL-TRIAL.B — shared resolution for the /api/email/mail routes.
//
// WHY THIS FILE IS THIN, AND DELIBERATELY SO
// The Mail surface is the OTHER HALF of a head-to-head trial against the
// ticket surface: `accounts@hatchstreetfitness.com` stays on ticketing,
// `hatchstreet@un1t.com` runs here, and Richard picks one. Two surfaces means
// two chances for the access model to diverge — and the access model is the
// one thing that must NOT be re-implemented, because a second definition of
// "which mailboxes may this person read" is a second chance to hand a coach
// the studio's billing correspondence.
//
// So every gate here is the ticket surface's own, imported verbatim:
//   • loadVisibleMailboxes  — the email_inbox key + per-mailbox grants
//   • loadTicketForUser     — the same, resolved at the TICKET's location
//   • scopeToNeedsReply     — the ONE definition of "they wrote, nobody answered"
//   • scopeToUnmerged       — merged tickets are tombstones on every surface
//   • statusTimestamps      — solved_at/closed_at, one implementation
//
// WHAT IS GENUINELY NEW is one filter: `email_mailboxes.surface` (mig 575).
// It decides which UI a mailbox appears in, and it is layered ON TOP of the
// access model rather than mixed into it. Access answers "may you read this";
// surface answers "which of the two screens shows it". Keeping them separate is
// what lets the trial be a routing change rather than a security change.
//
// 🔴 EACH MAILBOX APPEARS IN EXACTLY ONE SURFACE. If both screens showed
// everything there would be no trial to run. This file owns the inbox half of
// that split; the tickets list route owns the other.

import { NextResponse } from 'next/server'
import {
  loadVisibleMailboxes, scopeToNeedsReply, scopeToUnmerged, statusTimestamps,
  loadTicketForUser, ticketNotFound,
} from '../tickets/_helpers'

// Re-exported so the routes in this tree import their gates from ONE place and
// a reader can see, in one import line, that they are the ticket surface's.
export { scopeToNeedsReply, scopeToUnmerged, statusTimestamps, loadTicketForUser, ticketNotFound }

/**
 * The only value of `email_mailboxes.surface` this surface will show.
 *
 * imap-writeback.js exports the same constant for its own source-side guard,
 * and the two MUST agree — a list that shows a mailbox the write helper then
 * refuses is an Archive button that 404s. It is deliberately not imported from
 * there: that module pulls in imapflow, and the LIST route has no business
 * paying that cold start to show somebody their mail. The drift is pinned by a
 * test instead (`_helpers.test.js`), which is this repo's own answer to a
 * constant that must match across a boundary it should not import.
 */
export const INBOX_SURFACE = 'inbox'

// Two mailboxes at a studio today, a handful at most ever. Stated anyway
// because every .select() caps at 1,000 rows whatever the caller asks for.
const MAILBOX_LIMIT = 200

/**
 * 500 for a surface lookup that FAILED, as opposed to one that legitimately
 * found no inbox mailboxes.
 *
 * The two are opposite answers and must not collapse into one. `data` is null
 * on a PostgREST error, so a `|| []` here would turn "we could not find out
 * which mailboxes belong to this screen" into "none of them do" — which this
 * surface renders as the calm "no mail accounts on this screen yet" empty
 * state. An operator reads that as "no mail", stops looking, and nobody ever
 * learns the query failed. Same shape, same reasoning and deliberately the
 * same posture as mailboxesUnavailable() next door (EMAIL-TICKET-CLEANUP.2).
 *
 * Failing CLOSED is safe here and only here: nothing has been sent, nothing
 * has been written, and the alternative is not "show a bit less" but "show the
 * ticket surface's correspondence on the inbox surface", which would silently
 * end the trial's exclusivity.
 */
export function surfaceUnavailable() {
  return NextResponse.json({
    success: false,
    error: 'Could not check which mail accounts belong to this screen. Nothing was changed — try again.',
  }, { status: 500 })
}

/**
 * The mailboxes this caller may see at this location AND that belong to the
 * mail surface, in tab order.
 *
 * Two steps, on purpose:
 *   1. loadVisibleMailboxes — the WHOLE access model, unchanged and unforked.
 *   2. a `surface` read over exactly those ids — the presentation split.
 *
 * Step 2 is its own query rather than a column added to step 1's select
 * because that select belongs to the ticket surface: widening it from here
 * would make the mail trial an edit to the queue every other operator uses.
 *
 * @returns {Promise<{ response: NextResponse } | { elevated: boolean, mailboxes: object[] }>}
 */
export async function loadInboxMailboxes(db, user, locationId) {
  const visibility = await loadVisibleMailboxes(db, user, locationId)
  // A failed visibility lookup is NOT an empty visible set — its own refusal,
  // already shaped by the ticket helpers. Passed straight through.
  if (visibility.response) return visibility
  const { elevated, mailboxes } = visibility

  if (mailboxes.length === 0) return { elevated, mailboxes: [] }

  const ids = mailboxes.map(m => m.id)
  const { data, error } = await db.from('email_mailboxes')
    .select('id, surface')
    .in('id', ids)
    .limit(MAILBOX_LIMIT)
  if (error) {
    console.error('[email/mail] mailbox surface lookup failed:', error.message)
    return { response: surfaceUnavailable() }
  }

  // A row missing from the answer is NOT treated as an inbox mailbox. mig 575
  // gives every existing row the default 'tickets', so the only way to be
  // absent is a race with a deletion — and guessing 'inbox' there would put a
  // mailbox on this screen on the strength of a row nobody can read.
  const onSurface = new Set(
    (data || []).filter(r => r?.surface === INBOX_SURFACE).map(r => r.id)
  )
  return { elevated, mailboxes: mailboxes.filter(m => onSurface.has(m.id)) }
}

/**
 * Is this ONE mailbox on the mail surface?
 *
 * The mutation routes' half of the split, and the mirror of the write helper
 * guard on the IMAP side: a mail-surface verb must never be able to reach a
 * ticketing mailbox, however the caller got hold of the id. Returns a verdict
 * rather than a boolean because "we could not tell" is a third answer and the
 * routes must not read it as "no" or as "yes".
 *
 * @returns {Promise<{ ok: true } | { response: NextResponse }>}
 */
export async function assertInboxSurface(db, mailboxId) {
  // A ticket with NO mailbox cannot be on any surface. It is reachable only by
  // elevated callers on the ticket surface (mailbox_id is ON DELETE SET NULL),
  // and it is deliberately not reachable here: 404, like every other refusal.
  if (!mailboxId) return { response: ticketNotFound() }

  const { data, error } = await db.from('email_mailboxes')
    .select('id, surface')
    .eq('id', mailboxId)
    .maybeSingle()
  if (error) {
    console.error('[email/mail] mailbox surface check failed BEFORE writing:', error.message)
    return { response: surfaceUnavailable() }
  }
  // 404 rather than 403 for the same reason every refusal on this family of
  // routes is a 404: the caller must not learn whether an id exists, and "that
  // ticket is on the other screen" is exactly the kind of thing an id probe
  // would like to be told.
  if (!data || data.surface !== INBOX_SURFACE) return { response: ticketNotFound() }
  return { ok: true }
}

/**
 * NEEDS-REPLY, as a predicate over a row rather than a filter over a query.
 *
 * 🔴 THIS AND scopeToNeedsReply ARE ONE RULE IN TWO MEDIA. The scope is SQL and
 * narrows the list; this stamps the flag the list rows carry, so the client
 * never re-derives it — the same discipline that keeps the reply audience off
 * the composer. If one changes, the other changes in the same edit.
 *
 * It is kept because it is the one thing a plain mail client cannot tell an
 * operator: not "is there mail" but "has this member been answered". Everything
 * else in the ticket lifecycle is dropped on this surface; this is not.
 */
export function isNeedsReply(row) {
  return row?.status === 'open' && row?.last_message_direction === 'inbound'
}

/** Archive is `status='closed'`, presented as "Archived". There is no second lifecycle. */
export function isArchived(row) {
  return row?.status === 'closed'
}

// How many message rows one list request will read to work out per-conversation
// counts. A page is 50 conversations and a support thread is a handful of
// messages, so this is far above any real page — and it is stated because every
// .select() caps at 1,000 rows whatever the caller asks for, so an unstated
// bound is a silently truncated answer rather than an error.
export const MESSAGE_SCAN_LIMIT = 1000

/**
 * Per-conversation message count, unread count and attachment presence for
 * one page of the list.
 *
 * ONE SCAN, THREE FACTS. All three come off the same rows, so they can never
 * disagree about a conversation: the count is what makes it read as a
 * conversation rather than a message, the unread flag is what makes the list
 * weigh, and has_attachments is the paperclip.
 *
 * UNREAD IS `seen_at IS NULL` ON AN INBOUND MESSAGE (mig 575), not
 * email_tickets.unread_count. That is the whole point of the column: it mirrors
 * the IMAP \Seen flag, so mail read in the operator's own mail client shows as
 * read here. A counter maintained only by our own webhook could never do that.
 *
 * 🔴 A TRUNCATED SCAN REPORTS NOTHING RATHER THAN SOMETHING WRONG. Rows come
 * back ordered by ticket_id, so hitting the cap starves a SUFFIX of the page —
 * the last conversations would render as "no messages, all read", which is a
 * confident wrong answer rather than a missing one. `partial` is the honest
 * result and the surface says so out loud.
 *
 * A FAILED scan is not an empty one either: `unavailable` is separate, because
 * the column may simply not exist yet on a deploy that ran ahead of mig 575,
 * and the correspondence itself is still perfectly readable without it.
 *
 * HAS_ATTACHMENTS RIDES THE SAME SCAN RATHER THAN A NEW QUERY.
 * `email_ticket_attachments` has NO ticket_id (only message_id) — the only
 * table it can join against directly is `email_inbox_messages`, which this
 * scan already reads one row per message of. So the embedded resource
 * `email_ticket_attachments(id)` is added to the SAME select rather than run
 * as a second query per page: PostgREST does the join per row, which inflates
 * each row's payload slightly — an accepted cost, cheaper than a second round
 * trip, and the scan is already bounded by MESSAGE_SCAN_LIMIT either way.
 * Selecting only `id` keeps that join as thin as it can be while still
 * answering "is there at least one".
 *
 * A SKIPPED ATTACHMENT COUNTS TOO. `email_ticket_attachments` rows are XOR on
 * storage_path vs skipped_reason — a row can exist for a file we could not
 * store. The embed only selects `id`, so it cannot see which XOR branch a row
 * took, and it does not need to: the email genuinely arrived with a file
 * either way, which is what the paperclip promises the operator.
 *
 * @returns {Promise<{ counts: Map<string, {messages: number, unread: number, hasAttachments: boolean}>,
 *                     partial: boolean, unavailable: boolean }>}
 */
export async function loadConversationCounts(db, ticketIds) {
  const empty = { counts: new Map(), partial: false, unavailable: false }
  if (!Array.isArray(ticketIds) || ticketIds.length === 0) return empty

  const { data, error } = await db.from('email_inbox_messages')
    .select('ticket_id, direction, seen_at, email_ticket_attachments(id)')
    .in('ticket_id', ticketIds)
    // Ordered so the truncation, if it happens, is a clean suffix rather than
    // an arbitrary sample — which is what makes `partial` a usable answer.
    .order('ticket_id', { ascending: true })
    .limit(MESSAGE_SCAN_LIMIT)

  if (error) {
    console.error('[email/mail] message count scan failed:', error.message)
    return { counts: new Map(), partial: false, unavailable: true }
  }

  const rows = data || []
  if (rows.length >= MESSAGE_SCAN_LIMIT) {
    return { counts: new Map(), partial: true, unavailable: false }
  }

  const counts = new Map()
  for (const r of rows) {
    const key = r?.ticket_id
    if (!key) continue
    const entry = counts.get(key) || { messages: 0, unread: 0, hasAttachments: false }
    entry.messages += 1
    // Only INBOUND mail can be unread: seen_at mirrors \Seen on mail that
    // arrived, and our own sent replies are never something to read.
    if (r.direction === 'inbound' && !r.seen_at) entry.unread += 1
    // A missing embed (an older stub, a response shaped without it) reads as
    // "none" rather than throwing — `Array.isArray` guards the absent case.
    if (Array.isArray(r.email_ticket_attachments) && r.email_ticket_attachments.length > 0) {
      entry.hasAttachments = true
    }
    counts.set(key, entry)
  }
  return { counts, partial: false, unavailable: false }
}

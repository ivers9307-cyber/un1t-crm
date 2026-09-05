// MAIL-TRIAL.B → RETIRE-TICKETS.1 — shared resolution for /api/email/mail.
//
// WHY THIS FILE IS THIN, AND DELIBERATELY SO
// Mail started as one half of a head-to-head trial against the ticket queue.
// The trial is over (mig 578: Mail won, the queue UI is deleted, every
// mailbox is on this surface) — but the reason this file stays thin outlived
// it: the access model must NOT be re-implemented here, because a second
// definition of "which mailboxes may this person read" is a second chance to
// hand a coach the studio's billing correspondence.
//
// So every gate here is the original email access model, imported verbatim:
//   • loadVisibleMailboxes  — the email_inbox key + per-mailbox grants
//   • loadTicketForUser     — the same, resolved at the TICKET's location
//     (and the orphan rule: a NULL-mailbox ticket is visible to ELEVATED
//     callers only — mailbox_id is ON DELETE SET NULL and mig 484's backfill
//     predates the column, so orphans genuinely exist)
//   • scopeToNeedsReply     — the ONE definition of "they wrote, nobody answered"
//   • scopeToUnmerged       — merged tickets are tombstones everywhere
//   • statusTimestamps      — solved_at/closed_at, one implementation
//
// The `surface` filter that used to be layered on top is GONE — mig 578
// deprecated the column and nothing reads it. This surface now shows
// everything the caller may see, orphans included (they lost their only other
// home when the queue was deleted; a visible record silently disappearing is
// the one outcome that retirement must never produce).

import {
  loadVisibleMailboxes, scopeToNeedsReply, scopeToUnmerged, scopeToSpamView, statusTimestamps,
  loadTicketForUser, ticketNotFound,
} from '../tickets/_helpers'

// Re-exported so the routes in this tree import their gates from ONE place and
// a reader can see, in one import line, that they are the ticket surface's.
export { scopeToNeedsReply, scopeToUnmerged, scopeToSpamView, statusTimestamps, loadTicketForUser, ticketNotFound }

/**
 * The mailboxes this caller may see at this location, in tab order.
 *
 * RETIRE-TICKETS.1 — this used to layer a `surface` read on top and keep only
 * the mail half of the mig-575 split. The split is gone (mig 578), so this is
 * now a passthrough of the ONE access model. The name survives because five
 * routes and their tests call it, and the seam is still the right place for a
 * mail-side filter if one ever returns.
 *
 * @returns {Promise<{ response: import('next/server').NextResponse } | { elevated: boolean, mailboxes: object[] }>}
 */
export async function loadInboxMailboxes(db, user, locationId) {
  return loadVisibleMailboxes(db, user, locationId)
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
  // `!== true` rather than `!row.is_spam`: a row from a fixture or an older
  // response that never carried the column reads as live, matching the
  // column's NOT NULL DEFAULT false.
  return row?.status === 'open' && row?.last_message_direction === 'inbound' && row?.is_spam !== true
}

// ── Views (hoisted from route.js for MAIL-ALLLOC.1, so the scoped list and
// the multi-location digest share ONE definition of every view) ──────────

// MAIL-SENT.1 — the traditional split (Richard, 2 Sep: "Outlook, Google was
// the directive"): Inbox = live conversations that have RECEIVED something;
// Sent = live outbound-only threads (a campaign offer nobody answered yet);
// the moment a reply arrives has_inbound flips and the thread moves to
// Inbox. Needs-reply is unchanged and remains a subset of Inbox (an
// outbound-only thread cannot be awaiting our answer).
// MAIL-SPAM.1 — `spam` is the quarantine: rows flagged is_spam (mig 584), any
// lifecycle status, and the ONLY view that shows them.
export const MAIL_VIEWS = Object.freeze(['inbox', 'needs_reply', 'sent', 'archived', 'spam'])

// Legacy `solved` — a status this surface never writes but old rows carry —
// deserves an explicit decision rather than falling out of a negation. It is
// NOT archived, so it is live.
export const LIVE_STATUSES = Object.freeze(['open', 'pending', 'solved'])

export function applyView(query, view) {
  // MAIL-SPAM.1 — the quarantine is orthogonal to the lifecycle: every view
  // below is additionally `is_spam = false`, and the spam view is
  // `is_spam = true` with NO status filter (a quarantined thread keeps
  // whatever status the bump machinery gave it; the flag alone decides).
  query = scopeToSpamView(query, view)
  switch (view) {
    case 'spam': return query
    // The one thing a mail client cannot tell you. Shared scope with the nav
    // badge, so the number and the list can never mean different things.
    case 'needs_reply': return scopeToNeedsReply(query)
    // "Archived" is the word on screen; `closed` is the word on disk.
    case 'archived': return query.eq('status', 'closed')
    // Outbound-only, still live — the mail-client Sent folder (MAIL-SENT.1).
    case 'sent': return query.in('status', LIVE_STATUSES).eq('has_inbound', false)
    // Inbox proper: live AND has received something. NOT a negation of
    // sent-by-position — stated explicitly so the two can never overlap.
    default: return query.in('status', LIVE_STATUSES).eq('has_inbound', true)
  }
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

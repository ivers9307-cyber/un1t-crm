import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import {
  loadInboxMailboxes, loadConversationCounts,
  scopeToNeedsReply, scopeToUnmerged, isNeedsReply, isArchived,
} from './_helpers'

// GET /api/email/mail — the Mail surface's conversation list (MAIL-TRIAL.B).
//
// The inbox half of a head-to-head trial against /communications/tickets. It
// answers with BOTH halves of the screen in one round-trip, exactly as the
// ticket queue does — the mailbox strip (the access model made visible) and
// the conversations themselves.
//
// 🔴 IT SHOWS `surface='inbox'` MAILBOXES AND NOTHING ELSE. That exclusivity is
// the trial: a mailbox that appeared on both screens would be worked on both,
// and the comparison would answer nothing. The tickets list route owns the
// mirror-image filter.
//
// WHAT IT DELIBERATELY DOES NOT HAVE, measured against the ticket queue:
//   • no `unassigned` / `mine` views — assignment is not on this surface at
//     all (0 tickets assigned in 17 days of the ticket surface being live)
//   • no four-state lifecycle. There are two places a conversation can be:
//     the inbox, or the archive. Archive IS `status='closed'`, presented as
//     "Archived" — one lifecycle, two vocabularies, never a second column.
//   • no solved-vs-closed ceremony.
//
// WHAT IT KEEPS is needs-reply, and only that: "has this member been answered"
// is the one thing a plain mail client cannot tell you. It is a filter AND a
// per-row flag, stamped server-side so nothing downstream re-derives it.
//
// TWO GATES, both the ticket surface's own (see _helpers.js). `email_inbox`
// gates the surface, resolved at the REQUESTED location rather than the
// caller's active one — this route takes location_id as a parameter, so
// hasPermission() would answer a different question than the one asked. A row
// in email_mailbox_access gates each individual account.

// Views, as wire words. Anything else is a 400 rather than a silent default:
// a typo'd view that quietly showed the whole inbox is how an operator ends up
// believing the archive is empty.
export const MAIL_VIEWS = Object.freeze(['inbox', 'needs_reply', 'archived'])

// One screenful. The ticket queue hands back 200 in one go because it is a
// work QUEUE that an operator narrows with a filter; a mail list is scrolled,
// so it pages — and a smaller page is what keeps the per-conversation message
// scan below comfortably inside the 1,000-row select cap.
const PAGE_SIZE = 50

// Live statuses, spelled OUT rather than expressed as "not closed".
// `.neq('status','closed')` would read the same and be wrong twice over: the
// shared test double models no `neq` (so it would no-op and every view test
// would pass with the filter deleted), and `solved` — a legacy value this
// surface never writes but old rows carry — deserves an explicit decision
// rather than falling out of a negation. It is NOT archived, so it is here.
const LIVE_STATUSES = Object.freeze(['open', 'pending', 'solved'])

function applyView(query, view) {
  switch (view) {
    // The one thing a mail client cannot tell you. Shared scope with the
    // ticket surface and its nav badge, so the number and the list can never
    // mean different things.
    case 'needs_reply': return scopeToNeedsReply(query)
    // "Archived" is the word on screen; `closed` is the word on disk.
    case 'archived': return query.eq('status', 'closed')
    default: return query.in('status', LIVE_STATUSES)
  }
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }

  // List route, and the location came from the caller — 403 here, not 404.
  // (The 404 rule is for detail routes, where an id would otherwise be
  // enumerable.)
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  // Resolved at the REQUESTED location — see the header. After the access
  // guard so a location the caller has no business in reads as "not in your
  // assignments" rather than a permission complaint.
  if (!hasPermissionForLocation(user, locationId, 'email_inbox')) {
    return NextResponse.json({ success: false, error: 'Forbidden — email inbox permission required' }, { status: 403 })
  }

  const view = searchParams.get('view')
  if (view && !MAIL_VIEWS.includes(view)) {
    return NextResponse.json(
      { success: false, error: `Unknown view — expected one of ${MAIL_VIEWS.join(', ')}` },
      { status: 400 }
    )
  }

  const db = createServerClient()
  const visibility = await loadInboxMailboxes(db, user, locationId)
  // A FAILED lookup is not an empty one, in either of its two halves (access
  // or surface). Both refuse loudly rather than answering with a calm empty
  // inbox nobody would question.
  if (visibility.response) return visibility.response
  const { mailboxes } = visibility

  const emptyPayload = {
    mailboxes: [],
    conversations: [],
    next_before: null,
    needs_reply_count: 0,
    counts_unavailable: false,
    counts_partial: false,
  }

  // No mail-surface mailboxes here is a NORMAL state, not an error: a studio
  // running entirely on the ticket surface is the default for every existing
  // row (mig 575 defaults `surface` to 'tickets'), and a 403 there would look
  // like a bug to whoever hit it.
  if (mailboxes.length === 0) {
    return NextResponse.json({ success: true, data: emptyPayload })
  }

  // Asking for an account that is not on this screen is empty rather than an
  // error, for the same reason the ticket queue answers that way: the id came
  // from the caller, and a different answer for "exists but not here" would
  // leak which addresses the studio runs and which screen each one is on.
  const mailboxId = searchParams.get('mailbox_id')
  if (mailboxId && !mailboxes.some(m => m.id === mailboxId)) {
    return NextResponse.json({ success: true, data: { ...emptyPayload, mailboxes } })
  }

  const mailboxIds = mailboxes.map(m => m.id)
  const scopeIds = mailboxId ? [mailboxId] : mailboxIds

  // `before` is a keyset cursor on the column the list is ordered by, not an
  // offset. An offset re-reads rows that may have moved between pages — and on
  // a live inbox they do move, every time mail arrives — so "Older" would skip
  // or repeat conversations. One row's timestamp is not a secret: it is
  // already on the page the caller is reading.
  const before = searchParams.get('before')

  let query = db.from('email_tickets')
    .select('*')
    .eq('location_id', locationId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    // One extra row, so "is there another page" is an observation rather than
    // a guess. It is trimmed off before the response.
    .limit(PAGE_SIZE + 1)

  // Merged conversations are tombstones, hidden from every view on every
  // surface. Applied to the base query rather than per view: the archive is
  // exactly where one would resurface looking like ordinary history.
  query = scopeToUnmerged(query)

  // NO `.or(mailbox_id.is.null)` HERE, unlike the ticket queue's elevated
  // path. A ticket with no mailbox has no surface, so it cannot belong to this
  // one — and the ticket queue still shows it to elevated callers, which is
  // what keeps that correspondence reachable. Widening it here would put the
  // same conversation on both screens and end the trial's exclusivity.
  query = query.in('mailbox_id', scopeIds)

  // 🔴 INCLUSIVE, NOT STRICT — `lte`, and the difference is a conversation.
  // `last_message_at` is nullable and NOT unique: two messages can carry the
  // same timestamp (a bulk backfill gives many rows one), and when a page
  // boundary falls between two conversations that share one, a strict `lt`
  // excluded BOTH of them from the next page — the second was unreachable for
  // good, on a surface whose whole job is that no mail goes missing.
  //
  // Inclusive is safe here because the client de-duplicates appended pages by
  // id (see loadMore), so the boundary row coming back a second time is
  // dropped there rather than shown twice. Paying for one duplicate row to
  // guarantee no lost row is the right side of that trade every time.
  //
  // KNOWN BOUND, stated rather than hidden: a conversation whose
  // `last_message_at` is NULL sorts last and is excluded by any comparison
  // filter, so it is unreachable beyond the first page. It cannot arise for a
  // mailbox the connector fills (every ingested message stamps the column) —
  // only for a legacy row from mig 484's backfill — and no such row exists on
  // an inbox-surface mailbox today. Fix it with a compound cursor if a studio
  // ever moves a backfilled address onto this surface.
  if (before) query = query.lte('last_message_at', before)
  query = applyView(query, view)

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const rows = data || []
  const hasMore = rows.length > PAGE_SIZE
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows

  // Counts come off ONE scan of the page's messages — see loadConversationCounts.
  // Its two failure modes stay separate on the wire, because they mean
  // different things to the person reading the list: `unavailable` is "we
  // could not read the messages at all", `partial` is "this page is bigger
  // than one scan". Neither is allowed to render as "all read".
  const counts = await loadConversationCounts(db, page.map(t => t.id))

  const conversations = page.map(t => {
    const c = counts.counts.get(t.id) || null
    return {
      ...t,
      // Stamped here so no client re-derives the one predicate this surface
      // exists to keep — see isNeedsReply.
      needs_reply: isNeedsReply(t),
      archived: isArchived(t),
      message_count: c ? c.messages : null,
      unread_count_messages: c ? c.unread : null,
      unread: c ? c.unread > 0 : false,
    }
  })

  // The badge on the needs-reply filter. A count-only select, so it costs a
  // count rather than a page of rows — and it is scoped exactly like the list
  // above, so the badge can never offer a number the list refuses to show.
  let needsReplyCount = 0
  {
    let countQuery = db.from('email_tickets')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .in('mailbox_id', scopeIds)
    countQuery = scopeToUnmerged(countQuery)
    const { count, error: countErr } = await scopeToNeedsReply(countQuery)
    // Cosmetic. A badge that could not be counted shows zero rather than
    // failing a list that loaded perfectly well — the filter itself still
    // works, and the conversations are already on screen.
    if (!countErr) needsReplyCount = count || 0
  }

  return NextResponse.json({
    success: true,
    data: {
      mailboxes,
      conversations,
      // The cursor for "Older", or null when this is the last page. Derived
      // from the last row actually returned, so it can never skip one.
      next_before: hasMore ? (page[page.length - 1]?.last_message_at || null) : null,
      needs_reply_count: needsReplyCount,
      counts_unavailable: counts.unavailable,
      counts_partial: counts.partial,
    },
  })
}

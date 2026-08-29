// GET /api/email/mail/digest — every location's Mail, in one answer
// (MAIL-ALLLOC.1 — the endpoint behind the location tiles and All mode).
//
// WHAT IT IS. For each location the caller may read Mail at, the digest
// returns the tile facts (name, needs-reply count) and the All-mode section
// (the newest DIGEST_ROWS_PER_LOCATION conversations for the requested view,
// plus the view's true total so "View all 38" never lies). One request feeds
// the tile row, the section list, and the summed badge.
//
// WHAT IT IS NOT. A paging surface. The design's rule for a busy inbox is
// "one scroll, never a scroll inside a scroll": each section is a capped
// triage digest, and past the cap the operator scopes into the studio —
// where the existing list route owns real keyset paging. That is why there
// is no cursor here, deliberately, and why the cap is small.
//
// ACCESS IS THE SCOPED LIST'S, PER LOCATION, UNCHANGED. Eligibility is the
// `email_inbox` key resolved AT each location (hasPermissionForLocation —
// the same resolution the scoped routes use), and within a location the
// visible-mailbox set comes from the same loadVisibleMailboxes the list
// uses: per-mailbox grants for ordinary staff, everything + orphans for
// elevated callers. "All locations" is strictly the union of what each
// scoped view would show — no new access rule exists on this route.
//
// 🔴 A LOCATION THAT FAILED IS REPORTED, NEVER DROPPED. The house rule about
// a failure wearing an empty state's clothes compounds at estate scale: a
// digest that silently omitted a studio would read as "that studio has no
// mail", to the exact person responsible for it. A failed visibility lookup
// yields `{ unavailable: true }` for that location, flips `partial`, and
// nulls `needs_reply_total` — an unknown contributor must never render as a
// confident smaller number (the EMAIL-TICKET-CLEANUP.2 posture, summed).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import {
  loadInboxMailboxes, loadConversationCounts,
  scopeToNeedsReply, scopeToUnmerged, isNeedsReply, isArchived,
  MAIL_VIEWS, applyView,
} from '../_helpers'
import { scopeToVisibleMailboxes } from '../../tickets/_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The section cap. Five is a screenful of triage per studio without any
 * studio burying another; the header count and the View-all row both state
 * what lies past it, so the cap never masquerades as completeness.
 */
export const DIGEST_ROWS_PER_LOCATION = 5

/** One location's digest entry, or its honest failure. */
async function locationDigest(db, user, locationId, view) {
  const visibility = await loadInboxMailboxes(db, user, locationId)
  if (visibility.response) {
    // The refusal response belongs to the scoped route's shape; here the
    // failure is PER LOCATION and the digest carries on for the others.
    // Shape stays stable — null counts say "unknown", never zero, and an
    // empty conversations array keeps consumers iterating without guards.
    return { unavailable: true, needs_reply_count: null, view_total: null, conversations: [] }
  }
  const { elevated, mailboxes } = visibility
  // No visible mailboxes at this location is a normal state (no addresses,
  // or no grants) — the location simply is not part of this caller's estate
  // view. Skipped, not reported: there is nothing to be unavailable.
  if (mailboxes.length === 0) return null

  const scoped = (query) =>
    scopeToUnmerged(scopeToVisibleMailboxes(query, { mailboxes, elevated }))

  const base = () => db.from('email_tickets').select('*').eq('location_id', locationId)
  const headCount = () =>
    db.from('email_tickets').select('*', { count: 'exact', head: true }).eq('location_id', locationId)

  const [rowsRes, needsReplyRes, viewTotalRes] = await Promise.all([
    applyView(scoped(base()), view)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(DIGEST_ROWS_PER_LOCATION),
    // The tile number is ALWAYS needs-reply, whatever view the sections are
    // showing — the tile answers "where is work", not "what am I looking at".
    scopeToNeedsReply(scoped(headCount())),
    // …while view_total backs the "View all N" row for the CURRENT view.
    applyView(scoped(headCount()), view),
  ])

  if (rowsRes.error || needsReplyRes.error || viewTotalRes.error) {
    console.error(
      `[email/mail/digest] location ${locationId} failed:`,
      (rowsRes.error || needsReplyRes.error || viewTotalRes.error).message
    )
    return { unavailable: true, needs_reply_count: null, view_total: null, conversations: [] }
  }

  const page = rowsRes.data || []
  const counts = await loadConversationCounts(db, page.map(t => t.id))
  const conversations = page.map(t => {
    const c = counts.counts.get(t.id) || null
    return {
      ...t,
      // Stamped exactly as the scoped list stamps them, so a digest row and
      // a list row can never disagree about the same conversation.
      needs_reply: isNeedsReply(t),
      archived: isArchived(t),
      message_count: c ? c.messages : null,
      unread_count_messages: c ? c.unread : null,
      unread: c ? c.unread > 0 : false,
      has_attachments: c ? c.hasAttachments : false,
    }
  })

  return {
    unavailable: false,
    needs_reply_count: needsReplyRes.count || 0,
    view_total: viewTotalRes.count || 0,
    conversations,
    counts_partial: counts.partial,
    counts_unavailable: counts.unavailable,
  }
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const view = searchParams.get('view')
  if (view && !MAIL_VIEWS.includes(view)) {
    return NextResponse.json(
      { success: false, error: `Unknown view — expected one of ${MAIL_VIEWS.join(', ')}` },
      { status: 400 }
    )
  }

  // Eligibility per location — the same key the scoped routes gate on,
  // resolved AT each location so a manager-here-staff-there answers
  // differently per studio, exactly like visiting each one directly would.
  const eligible = getUserLocationIds(user)
    .filter(id => hasPermissionForLocation(user, id, 'email_inbox'))

  const db = createServerClient()
  const nameOf = (id) => (user.locations || []).find(l => l.id === id)?.name || null

  const entries = await Promise.all(
    eligible.map(async (id) => ({ id, digest: await locationDigest(db, user, id, view) }))
  )

  const locations = entries
    .filter(e => e.digest !== null)
    .map(e => ({ location_id: e.id, name: nameOf(e.id), ...e.digest }))
    // Stable name order — the tiles are a map, not a leaderboard; a row that
    // reshuffles by count is a row an operator can no longer find by muscle
    // memory. Unnamed (fixture-shaped) locations sort last, by id.
    .sort((a, b) => (a.name || `~${a.location_id}`).localeCompare(b.name || `~${b.location_id}`))

  const partial = locations.some(l => l.unavailable)
  // An unknown location's count must not be summed as zero — null says "we
  // cannot total this right now", which the badge renders by keeping its
  // last good number (the poller's standing rule).
  const needsReplyTotal = partial
    ? null
    : locations.reduce((sum, l) => sum + (l.needs_reply_count || 0), 0)

  return NextResponse.json({
    success: true,
    data: { locations, needs_reply_total: needsReplyTotal, partial },
  })
}

// GET /api/email/mail/[id]/related — other conversations from the SAME
// sender (MAIL-REFINE.1 — feeds the thread's "N other open conversations"
// nudge and the merge picker's candidate list).
//
// ACCESS IS THE DETAIL ROUTE'S, THEN THE LIST'S. The anchor ticket goes
// through loadTicketForUser — location access, the email_inbox key AT the
// ticket's location, per-mailbox visibility, 404 on every refusal — and the
// candidates are then scoped by the same visible-mailbox rule as the list, so
// this route can never show a thread the caller could not open from the
// inbox. Relatedness never widens access; it only orders what is already
// visible.
//
// SENDER MATCH IS CASE-INSENSITIVE EQUALITY, NEVER A PATTERN. requester_email
// is stored mixed-case and arrives off an unauthenticated webhook, so the
// comparison is escapeLikePattern + ilike — the house rule that keeps a `%`
// in a stored address from relating the whole domain.
//
// RELATEDNESS NEVER CROSSES THE QUARANTINE FLAG (MAIL-SPAM.1). The picker
// merges related → current, so a live anchor offering a quarantined candidate
// would fold spam into a member's thread, and a spam anchor offering the
// sender's live thread would fold that thread into the spam ticket — where
// the 30-day purge deletes it. Candidates carry the anchor's own is_spam, and
// the nudge's open_count follows the same scope.
//
// 🔴 A FAILED LOOKUP IS A 500, NEVER AN EMPTY LIST. "No related threads" is
// an answer the merge picker acts on (it hides the nudge); a blipped query
// wearing that answer would hide a real duplicate exactly when the operator
// went looking for it.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { escapeLikePattern } from '@/lib/like-escape'
import { loadTicketForUser, loadVisibleMailboxes, scopeToVisibleMailboxes } from '../../../tickets/_helpers'
import { loadConversationCounts, LIVE_STATUSES } from '../../_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The picker cap. Ten is more same-sender threads than any real duplicate
 * situation produces; past it the picker would need paging this surface
 * deliberately does not have. open_count is a true count, uncapped, so the
 * nudge's number never quietly understates.
 */
export const RELATED_LIMIT = 10

const RELATED_COLUMNS =
  'id, subject, status, last_message_at, requester_name, merged_into_id, is_spam'

export async function GET(request, props) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { id } = await props.params
  const db = createServerClient()

  const loaded = await loadTicketForUser(db, user, id)
  if (loaded.response) return loaded.response
  const { ticket } = loaded

  // A sender-less ticket (rare legacy rows) has nothing to relate BY — that
  // is a real empty answer, not a failure.
  if (!ticket.requester_email) {
    return NextResponse.json({ success: true, data: { related: [], open_count: 0 } })
  }

  // loadTicketForUser proves the anchor is visible but returns only ITS
  // mailbox; the candidate scope needs the caller's whole visible set.
  const visibility = await loadVisibleMailboxes(db, user, ticket.location_id)
  if (visibility.response) return visibility.response
  const { elevated, mailboxes } = visibility

  const scoped = (query) => scopeToVisibleMailboxes(
    query
      .eq('location_id', ticket.location_id)
      .neq('id', ticket.id)
      .ilike('requester_email', escapeLikePattern(ticket.requester_email))
      .is('merged_into_id', null)
      // The anchor's own side of the flag — see the header. `=== true` so a
      // pre-mig-584 row (no column) anchors the live side, never both.
      .eq('is_spam', ticket.is_spam === true),
    { mailboxes, elevated },
  )

  const [listRes, openRes] = await Promise.all([
    scoped(db.from('email_tickets').select(RELATED_COLUMNS))
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(RELATED_LIMIT),
    // The nudge's number — open (live) threads only, counted without the cap.
    scoped(db.from('email_tickets').select('*', { count: 'exact', head: true }))
      .in('status', LIVE_STATUSES),
  ])

  if (listRes.error || openRes.error) {
    console.error(
      '[email/mail/related] lookup failed:',
      (listRes.error || openRes.error).message
    )
    return NextResponse.json(
      { success: false, error: 'Could not load related conversations' },
      { status: 500 }
    )
  }

  const rows = listRes.data || []
  // message_count for the picker's "N messages" line — best-effort off the
  // same bounded scan the list uses; null (never 0) when the scan cannot say.
  const counts = await loadConversationCounts(db, rows.map(t => t.id))
  const related = rows.map(t => {
    const c = counts.counts.get(t.id) || null
    return {
      id: t.id,
      subject: t.subject,
      status: t.status,
      last_message_at: t.last_message_at,
      requester_name: t.requester_name,
      message_count: c ? c.messages : null,
    }
  })

  return NextResponse.json({
    success: true,
    data: { related, open_count: openRes.count || 0 },
  })
}

// GET /api/email/mail/count — the Mail nav badge (INBOX-SURFACE.C, sole email
// badge since RETIRE-TICKETS.1).
//
// THE ONE PRINCIPLE THIS FILE EXISTS FOR: "each badge counts exactly the rows
// its own queue lists" (MAIL-TRIAL.B). The reasoning about WHAT the number
// means — `open` AND an inbound last message, not the whole live queue, not
// `unread_count>0`, not `unassigned` — was argued in full on the ticket
// badge's header (now a deprecated shim next door); it applies unchanged.
//
// TWO GATES, same as every route on this surface. `email_inbox` gates the
// screen (resolved AT the active location — this endpoint is parameterless,
// so there is no OTHER location to resolve against), and a row in
// email_mailbox_access gates each account.
//
// RETIRE-TICKETS.1 — the surface narrowing that used to sit here is gone with
// the surface itself (mig 578), and the orphan `.or` branch is now IN, not
// out: NULL-mailbox conversations live on this surface since the queue was
// deleted, so the badge scopes with the same shared helper as the list.
//
// Shape and posture otherwise follow the ticket badge exactly: parameterless,
// count 0 (not an error) for a session that is not eligible at all, and a
// FAILED visibility or count lookup is a 500 — never a badge of 0, which is
// the same silent-wrong-answer shape EMAIL-TICKET-CLEANUP.2 fixed there.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import {
  loadVisibleMailboxes, scopeToVisibleMailboxes, scopeToNeedsReply, scopeToUnmerged,
} from '../../tickets/_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const zero = () => NextResponse.json({ success: true, data: { count: 0 } })

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const locationId = user.activeLocation?.id || null
  if (!locationId) return zero()

  // Not eligible is not an error — see the header.
  if (!hasPermissionForLocation(user, locationId, 'email_inbox')) return zero()

  const db = createServerClient()

  const visibility = await loadVisibleMailboxes(db, user, locationId)
  // A failed visibility lookup must NOT badge 0 — the same silent wrong
  // answer as an empty inbox, just smaller. The poller ignores a non-ok
  // response and keeps the last good count, so a blip shows a slightly stale
  // number rather than a confident, wrong "nothing to do".
  if (visibility.response) return visibility.response
  const { elevated, mailboxes: visible } = visibility

  // Genuinely nothing visible → zero, and skip a query that would return it
  // anyway. An elevated caller at a studio with mailboxes always has a
  // non-empty visible set, so no orphan is dropped by this early-out.
  if (visible.length === 0) return zero()

  // head: true — the badge wants a number, never the rows.
  let query = db.from('email_tickets')
    .select('*', { count: 'exact', head: true })
    .eq('location_id', locationId)
  // RETIRE-TICKETS.1 — the mail LIST route's own scope, verbatim: all visible
  // mailboxes, orphan `.or` branch for elevated callers. The surface split is
  // gone (mig 578) and orphans live on this surface now, so the badge counts
  // exactly the rows the list shows.
  query = scopeToVisibleMailboxes(query, { mailboxes: visible, elevated })
  query = scopeToNeedsReply(query)
  // EMAIL-MERGE.3 — never a tombstone, by the same scope the list uses.
  query = scopeToUnmerged(query)

  const { count, error } = await query
  if (error) {
    console.error('[email/mail/count] count failed:', error.message)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { count: count || 0 } })
}

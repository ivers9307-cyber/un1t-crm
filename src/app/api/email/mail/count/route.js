// GET /api/email/mail/count — the Mail surface's OWN nav badge (INBOX-SURFACE.C).
//
// THE ONE PRINCIPLE THIS FILE EXISTS FOR: "each badge counts exactly the rows
// its own queue lists" (MAIL-TRIAL.B). The ticket surface already has
// /api/email/tickets/count; this is its mirror image for the OTHER half of
// the head-to-head trial, so the same reasoning about WHAT the number means —
// `open` AND an inbound last message, not the whole live queue, not
// `unread_count>0`, not `unassigned` — applies here unchanged. See that
// route's own header for the full case against each rejected alternative; it
// is not restated here.
//
// TWO GATES, same as every route on this surface. `email_inbox` gates the
// screen (resolved AT the active location, exactly like the ticket badge —
// this endpoint is parameterless, so there is no OTHER location to resolve
// against), and a row in email_mailbox_access gates each account.
//
// 🔴 INBOX-SURFACE.C — AND IT COUNTS ONLY THIS SURFACE'S MAILBOXES, THE OTHER
// WAY ROUND FROM THE TICKET BADGE. A studio mid-trial has studio@ on Mail and
// accounts@ still on tickets; an unanswered accounts@ ticket is real work, but
// it is the OTHER badge's job to say so. Narrowing here is what keeps this
// badge and the tab it sits on always meaning the same rows — a badge
// counting mail this list refuses to render is the red dot an operator
// clicks, finds nothing behind, and learns to ignore.
//
// 🔴 NO ORPHAN WIDENING, UNLIKE THE TICKET BADGE'S ELEVATED PATH. There
// email_tickets.mailbox_id is ON DELETE SET NULL (mig 484 also predates the
// column), and a NULL-mailbox ticket has no `surface` to read — 'tickets' is
// both the column's own DEFAULT and the ticket surface's own reasoning for
// claiming it (mailboxesForSurface falls back to SURFACE_TICKETS for exactly
// that row). That makes an orphan the TICKET surface's mail, never this one's,
// so this route's scope is the mail LIST route's own plain
// `.in('mailbox_id', ids)` (route.js: no `.or(mailbox_id.is.null)` branch) —
// never scopeToVisibleMailboxes, whose elevated branch would silently
// re-admit orphans through the `.or()` it built for the OTHER surface.
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
  loadVisibleMailboxes, scopeToNeedsReply, scopeToUnmerged,
  mailboxesForSurface, SURFACE_INBOX,
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
  const { mailboxes: visible } = visibility

  // INBOX-SURFACE.C — narrow to THIS surface, and stop here rather than run a
  // query that can only return 0. Unlike the ticket badge's early-out (which
  // is keyed on the PRE-surface set, because an orphan still needs the widened
  // query even when the tab strip is empty), there is nothing this route could
  // widen to — no orphan ever belongs here — so the narrowed set alone decides.
  const mailboxes = mailboxesForSurface(visible, SURFACE_INBOX)
  if (mailboxes.length === 0) return zero()

  const ids = mailboxes.map(m => m.id)

  // head: true — the badge wants a number, never the rows.
  let query = db.from('email_tickets')
    .select('*', { count: 'exact', head: true })
    .eq('location_id', locationId)
    // The mail LIST route's own scope (route.js), verbatim — plain `.in()`,
    // deliberately not scopeToVisibleMailboxes: see the header for why an
    // orphan must never ride back in through its elevated `.or()` branch.
    .in('mailbox_id', ids)
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

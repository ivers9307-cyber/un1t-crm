// GET /api/email/tickets/count — the Email nav badge (EMAIL-TICKET-CLEANUP.3).
//
// WHAT THE NUMBER MEANS: tickets at the caller's ACTIVE location, on a mailbox
// they can actually open, that are `open` with an INBOUND last message. In
// English: mail somebody sent us that nobody has answered yet.
//
// WHY NOT THE OBVIOUS ALTERNATIVES. This feature has no cron, no sweep and no
// timer — nothing closes itself (Richard, 2026-08-06) — so a badge counting
// anything that isn't genuinely outstanding work would climb forever, and a
// number nobody can drive to zero is a number everybody learns to ignore.
//   • the whole live queue (`open` + `pending`) — `pending` means we already
//     replied and are waiting on the MEMBER. That is their move, not ours, and
//     with nothing auto-closing it accumulates permanently.
//   • `unread_count > 0` — zeroed by the …/read POST, so a ticket someone
//     opened, skimmed and did not answer silently leaves the count. That is
//     precisely the ticket most at risk of being forgotten. (It is also the bug
//     src/lib/inbox-queues.js exists to avoid on the WhatsApp side.)
//   • `unassigned` — misses an assigned ticket nobody has got to, and a queue
//     where assignment is optional would badge inconsistently.
// The chosen definition self-clears on the actual work: replying flips the
// ticket to `pending` with an outbound last message, closing it leaves `open`.
//
// It is the SAME predicate as the list route's `needs_reply` view, imported
// from the shared helper rather than restated — so clicking the badge through
// to that tab shows exactly the rows it counted.
//
// TWO GATES, same as every other ticket route. `email_inbox` gates the surface
// (resolved AT the active location, not merely against it), and a row in
// email_mailbox_access gates each account: a coach with no grant on `accounts@`
// must not have its billing tickets counted into their badge, or the number
// tells them about mail they cannot open.
//
// Shape and posture follow /api/invoices-inbox/unread-count: no parameters,
// location off the session, `{ success, data: { count } }`, and count 0 —
// rather than an error — for a session that simply isn't eligible, because the
// 60s poll must be harmless if it ever runs for the wrong user.
//
// INBOX-SURFACE.C — AND IT COUNTS ONLY THIS SURFACE'S MAILBOXES. The badge sits
// on the tab this list route backs, so it has to be narrowed by `surface` for
// the same reason scopeToUnmerged is applied below: a badge counting rows the
// tab then refuses to show is the red dot an operator clicks, finds nothing
// behind, and learns to ignore. During the trial the moved mailbox's unanswered
// mail is real work — it is just counted on the OTHER surface's badge, which is
// exactly the comparison Richard is running.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import {
  loadVisibleMailboxes, scopeToVisibleMailboxes, scopeToNeedsReply, scopeToUnmerged,
  mailboxesForSurface, SURFACE_TICKETS,
} from '../_helpers'

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
  // A failed visibility lookup must NOT badge 0 (EMAIL-TICKET-CLEANUP.2) — that
  // is the same silent wrong answer as an empty inbox, just smaller. The poller
  // ignores a non-ok response and keeps the last good count, so a blip shows a
  // slightly stale number instead of a confident, wrong "nothing to do".
  if (visibility.response) return visibility.response
  const { elevated, mailboxes: visible } = visibility

  // Genuinely nothing visible — a studio with no addresses, or a person with no
  // grants. Zero is the honest answer, and it skips a query that would return
  // it anyway. Keyed on the PRE-surface set for the same reason the list route
  // is: an elevated caller at a studio that has moved every account to the
  // inbox can still have NULL-mailbox tickets waiting, and those are counted
  // here because they are shown here.
  if (visible.length === 0) return zero()

  const mailboxes = mailboxesForSurface(visible, SURFACE_TICKETS)

  // head: true — the badge wants a number, never the rows. Every filter here is
  // a plain column on email_tickets; the count-only select that silently
  // returns 0 is the one filtering an EMBEDDED resource (CLAUDE.md), which this
  // deliberately does not do.
  let query = db.from('email_tickets')
    .select('*', { count: 'exact', head: true })
    .eq('location_id', locationId)
  query = scopeToVisibleMailboxes(query, { mailboxes, elevated })
  query = scopeToNeedsReply(query)
  // EMAIL-MERGE.3 — and never a tombstone, by the SAME scope the list uses. A
  // finished merge leaves it `closed`, which scopeToNeedsReply already drops,
  // so this is the half-applied case (pointer stamped, status write lost) plus
  // the standing guarantee that the badge and the tab it links to count the
  // same rows: a badge counting a ticket the queue does not show is the red dot
  // an operator clicks, finds nothing behind, and stops trusting.
  query = scopeToUnmerged(query)

  const { count, error } = await query
  if (error) {
    console.error('[email/tickets/count] count failed:', error.message)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { count: count || 0 } })
}

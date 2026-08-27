import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import {
  loadVisibleMailboxes, scopeToVisibleMailboxes, scopeToNeedsReply, scopeToUnmerged,
  mailboxesForSurface, SURFACE_TICKETS,
} from './_helpers'

// GET /api/email/tickets — the studio's ticket queue (EMAIL-TICKET.4).
// Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
//
// Returns BOTH halves of the surface in one round-trip:
//   • `mailboxes` — the accounts this caller may see here, already in tab
//     order. The tab strip is not decoration: it is the access model made
//     visible, so it is not something the client should assemble itself.
//   • `tickets`   — the queue, filtered to those mailboxes.
//
// TWO GATES. `email_inbox` gates the surface (this is a service-role route,
// so the check here IS the gate — note it is NOT the older `email` key, which
// gates marketing mail). A row in email_mailbox_access gates each account,
// resolved in _helpers.js. No visible mailboxes is an EMPTY LIST, not an
// error: a studio that does not do email and a coach with no grants are both
// normal states, and a 403 there would look like a bug to whoever hit it.
//
// The surface gate resolves AT THE REQUESTED LOCATION (EMAIL-TICKET.5), not
// at the caller's active one. This route takes location_id as a parameter, so
// plain hasPermission() answered a different question than the one asked: a
// manager at Stillorgan who is only staff at Hatch was denied Stillorgan's
// queue whenever their session happened to be pointed at Hatch, and — the
// direction that actually matters — was ALLOWED Hatch's queue, mailbox grants
// and all, purely because their active location said manager. Resolving the
// permission at the target location binds capability and tenant together.
// (Same reasoning as hasPermissionInOrganization; see src/lib/permissions.js.)
//
// INBOX-SURFACE.C — THIS QUEUE IS ONE SIDE OF AN A/B, NOT THE WHOLE PILE.
// A mailbox carries `surface` (mig 575, default 'tickets'). Anything moved to
// 'inbox' is answered on the inbox surface instead and is EXCLUDED here — both
// from the tab strip and from the query behind it. If both surfaces listed
// every mailbox the trial would compare nothing, and the same member could be
// answered twice from two screens.
//
// NULL-MAILBOX TICKETS STAY HERE. See the comment on the query below: a ticket
// with no mailbox has no `surface` to read, so it cannot be routed by data, and
// it must not fall between the two surfaces.
export const VIEWS = Object.freeze(['unassigned', 'mine', 'needs_reply', 'closed'])

// One screen of queue. Well under the 1,000-row select cap; the operator
// narrows with a view or a mailbox tab rather than paging past this.
const TICKET_LIMIT = 200

function applyView(query, view, user) {
  switch (view) {
    // Nobody has picked this up yet — the queue's real backlog.
    case 'unassigned': return query.is('assigned_to', null).eq('status', 'open')
    case 'mine': return query.eq('assigned_to', user.id).in('status', ['open', 'pending'])
    // Open AND the last word was theirs, not ours. Shared with the nav badge
    // so the number and the tab it links to can never mean different things.
    case 'needs_reply': return scopeToNeedsReply(query)
    case 'closed': return query.in('status', ['solved', 'closed'])
    // Default = the live queue. Solved/closed are deliberately out of it —
    // nothing auto-closes in this design, so the open set is the work list.
    default: return query.in('status', ['open', 'pending'])
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

  // List route, and the location came from the caller — 403 here, not 404
  // (the 404 rule is for detail routes, where an id would otherwise be
  // enumerable).
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  // Surface gate, resolved at the REQUESTED location — see the header. It runs
  // after assertLocationAccess so a location the caller has no business in
  // reads as "not in your assignments" rather than a permission complaint.
  if (!hasPermissionForLocation(user, locationId, 'email_inbox')) {
    return NextResponse.json({ success: false, error: 'Forbidden — email inbox permission required' }, { status: 403 })
  }

  const view = searchParams.get('view')
  if (view && !VIEWS.includes(view)) {
    return NextResponse.json(
      { success: false, error: `Unknown view — expected one of ${VIEWS.join(', ')}` },
      { status: 400 }
    )
  }

  const db = createServerClient()
  const visibility = await loadVisibleMailboxes(db, user, locationId)
  // A FAILED visibility lookup is NOT an empty visible set
  // (EMAIL-TICKET-CLEANUP.2). Collapsed into one, the branch below served it as
  // 200 `{ mailboxes: [], tickets: [] }` — which the inbox renders as the calm
  // "no email accounts here yet" empty state. An operator reads that as "no
  // mail" and stops looking. The 500 lands in TicketInbox's own error state
  // ("Could not load the ticket inbox" + Try again), which is the whole point:
  // the two outcomes now look different to the person reading them.
  if (visibility.response) return visibility.response
  const { elevated, mailboxes: visible } = visibility

  // INBOX-SURFACE.C — this surface's half of the trial, applied BEFORE the tab
  // strip is built so the tabs and the query can never disagree about which
  // accounts belong here. An account moved to the inbox is not "hidden" from
  // this operator — it is being worked somewhere else, which is the point.
  const mailboxes = mailboxesForSurface(visible, SURFACE_TICKETS)

  // Nothing visible AT ALL → nothing to show. Not an error.
  //
  // Deliberately keyed on the PRE-surface set. A studio that has moved every
  // one of its accounts to the inbox has an empty tab strip here but may still
  // hold NULL-mailbox tickets, and returning early on the narrowed set would
  // drop those for an elevated caller — see scopeToVisibleMailboxes. A caller
  // with no visible mailboxes whatsoever has no orphans to see either (the
  // orphan fallback is elevation, and an elevated caller at a studio with
  // mailboxes always has a non-empty `visible`).
  if (visible.length === 0) {
    return NextResponse.json({ success: true, data: { mailboxes: [], tickets: [], viewer_is_elevated: elevated } })
  }

  // Asking for an account you cannot see is also empty rather than an error:
  // the mailbox id came from the caller, and answering differently for "exists
  // but not yours" would leak which addresses the studio runs.
  const mailboxId = searchParams.get('mailbox_id')
  if (mailboxId && !mailboxes.some(m => m.id === mailboxId)) {
    return NextResponse.json({ success: true, data: { mailboxes, tickets: [], viewer_is_elevated: elevated } })
  }

  let query = db.from('email_tickets')
    .select('*')
    .eq('location_id', locationId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(TICKET_LIMIT)

  // EMAIL-MERGE.3 — merged-away tickets are tombstones, hidden from EVERY view.
  // Applied to the base query rather than inside applyView on purpose: a merged
  // ticket is `closed` plus a pointer, so the `closed` view is exactly where one
  // would resurface, and a per-view filter is a filter someone can forget to add
  // to the next view. Its survivor keeps the whole conversation.
  query = scopeToUnmerged(query)

  // One tab = that mailbox (already proved visible above). No tab = the whole
  // visible set, via the shared scope the count endpoint also uses, so the
  // badge and this list can never disagree about what a person can see.
  //
  // INBOX-SURFACE.C — `mailboxes` here is already narrowed to this surface, so
  // a ticket on an inbox-surface account is out of the `.in()` and out of the
  // `.or()` branch alike.
  //
  // 🔴 WHERE A NULL-MAILBOX TICKET LIVES, AND WHY. email_tickets.mailbox_id is
  // ON DELETE SET NULL — deliberately, so removing an address never deletes a
  // member's correspondence — and mig 484's backfill predates the column, so
  // orphans genuinely exist. An orphan has no mailbox, therefore no `surface`,
  // therefore nothing to route on. It stays on THE TICKETS SURFACE, for three
  // reasons: (1) `surface` DEFAULTS to 'tickets', so "tickets is where mail
  // lives until somebody says otherwise" is already the rule the schema states
  // — an orphan is the case where nobody ever said otherwise; (2) this surface
  // exists at every location, whereas the inbox surface only exists where a
  // mailbox has been moved to it, so putting orphans there would make them
  // invisible at every studio not in the trial; (3) it is where they have
  // always been shown, to elevated callers only, so nothing an owner can see
  // today moves out from under them. The inbox side excludes them (Phase B), so
  // they appear on exactly one surface and never on none.
  query = mailboxId
    ? query.eq('mailbox_id', mailboxId)
    : scopeToVisibleMailboxes(query, { mailboxes, elevated })

  query = applyView(query, view, user)

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  // EMAIL-ASSIGN.1 — assignee names, resolved here because `profiles` is
  // unreadable client-side (no grant for `authenticated`; an embed would 500
  // the whole select). Best-effort: an unresolved name degrades to null and
  // the row renders 'Assigned', exactly like a pre-assignment ticket.
  const tickets = data || []
  const assigneeIds = [...new Set(tickets.map(t => t.assigned_to).filter(Boolean))]
  let assigneeNames = new Map()
  if (assigneeIds.length > 0) {
    try {
      const { data: profiles } = await db.from('profiles')
        .select('id, full_name').in('id', assigneeIds).limit(TICKET_LIMIT)
      assigneeNames = new Map((profiles || []).map(p => [p.id, p.full_name]))
    } catch { /* cosmetic — never fail the queue for a name */ }
  }
  const shaped = tickets.map(t => ({
    ...t,
    assignee_name: t.assigned_to ? (assigneeNames.get(t.assigned_to) || null) : null,
  }))

  return NextResponse.json({
    success: true,
    data: {
      mailboxes,
      tickets: shaped,
      // The reassign control gates on this — claiming needs no elevation,
      // assigning somebody ELSE does.
      viewer_is_elevated: elevated,
    },
  })
}

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import {
  loadVisibleMailboxes, scopeToVisibleMailboxes, scopeToNeedsReply, scopeToUnmerged,
} from './_helpers'

// GET /api/email/tickets — 🔴 DEPRECATED SHIM (RETIRE-TICKETS.1).
//
// The ticket queue UI is deleted — Mail (/communications/mail, backed by
// /api/email/mail) is the email surface, and the mig-575 surface A/B is over
// (mig 578: every mailbox is 'inbox' and the column is deprecated). This
// route survives for ONE caller: the staff app's SHIPPED bundle
// (mobile/lib/email-api.js). An OTA reaches a phone on next launch, not on
// deploy, so deleting this route in the same merge as the mobile Mail port
// would break every phone that had not relaunched yet. Delete it — with
// /count, /[id]/assign and /[id]/status — in a later sweep, once the mobile
// port's OTA has had time to land. Do NOT point new web code here.
//
// It now lists ALL visible mailboxes (surface narrowing removed — there is
// only one surface), so the shipped app keeps seeing the studio's mail. The
// response shape is frozen exactly as the bundle expects it, including
// `mailboxes_on_mail`, which is now constant [] (the split it described no
// longer exists; mobile never read it, but a frozen shape is a frozen shape).
//
// Spec: docs/superpowers/specs/2026-08-05-email-ticketing-design.md
//
// Returns BOTH halves of the surface in one round-trip:
//   • `mailboxes` — the accounts this caller may see here, already in tab
//     order. The tab strip is not decoration: it is the access model made
//     visible, so it is not something the client should assemble itself.
//   • `tickets`   — the queue, filtered to those mailboxes.
//   • `mailboxes_on_mail` (MAIL-WEEKONE.2) — the labels of the caller's OTHER
//     visible mailboxes, the ones this trial moved to /communications/mail.
//     This route already computes that split to build `mailboxes` above and
//     used to discard the excluded half; surfacing it is what lets this
//     screen tell an operator "some of your mail moved" instead of just
//     going quiet about accounts it no longer lists. ALWAYS present
//     (possibly `[]`), including on the early `visible.length === 0` return —
//     a field a consumer must guard for is a field somebody eventually reads
//     wrong.
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
  // mail" and stops looking. The 500 lands in the surface's own error state
  // ("Could not load the ticket inbox" + Try again), which is the whole point:
  // the two outcomes now look different to the person reading them.
  if (visibility.response) return visibility.response
  const { elevated, mailboxes: visible } = visibility

  // RETIRE-TICKETS.1 — surface narrowing removed with the surface itself:
  // this shim lists every mailbox the caller may see, same as /api/email/mail.
  const mailboxes = visible

  // Frozen response shape (see header) — the split this described is gone.
  const mailboxesOnMail = []

  // Nothing visible AT ALL → nothing to show. Not an error.
  if (visible.length === 0) {
    return NextResponse.json({
      success: true,
      data: { mailboxes: [], tickets: [], viewer_is_elevated: elevated, mailboxes_on_mail: mailboxesOnMail },
    })
  }

  // Asking for an account you cannot see is also empty rather than an error:
  // the mailbox id came from the caller, and answering differently for "exists
  // but not yours" would leak which addresses the studio runs.
  const mailboxId = searchParams.get('mailbox_id')
  if (mailboxId && !mailboxes.some(m => m.id === mailboxId)) {
    return NextResponse.json({
      success: true,
      data: { mailboxes, tickets: [], viewer_is_elevated: elevated, mailboxes_on_mail: mailboxesOnMail },
    })
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
  // 🔴 NULL-MAILBOX TICKETS. email_tickets.mailbox_id is ON DELETE SET NULL —
  // deliberately, so removing an address never deletes a member's
  // correspondence — and mig 484's backfill predates the column, so orphans
  // genuinely exist. Elevated callers see them here (scopeToVisibleMailboxes'
  // .or branch), and since RETIRE-TICKETS.1 the mail surface shows them too —
  // one pile now, not a split.
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
      // MAIL-WEEKONE.2 — see the computation above for why this is always
      // present rather than an occasionally-omitted field.
      mailboxes_on_mail: mailboxesOnMail,
    },
  })
}

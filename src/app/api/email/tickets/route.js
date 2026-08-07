import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { loadVisibleMailboxes } from './_helpers'

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
export const VIEWS = Object.freeze(['unassigned', 'mine', 'needs_reply', 'closed'])

// One screen of queue. Well under the 1,000-row select cap; the operator
// narrows with a view or a mailbox tab rather than paging past this.
const TICKET_LIMIT = 200

const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function applyView(query, view, user) {
  switch (view) {
    // Nobody has picked this up yet — the queue's real backlog.
    case 'unassigned': return query.is('assigned_to', null).eq('status', 'open')
    case 'mine': return query.eq('assigned_to', user.id).in('status', ['open', 'pending'])
    // Open AND the last word was theirs, not ours.
    case 'needs_reply': return query.eq('status', 'open').eq('last_message_direction', 'inbound')
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
  const { elevated, mailboxes } = await loadVisibleMailboxes(db, user, locationId)

  // Nothing visible → nothing to show. Not an error.
  if (mailboxes.length === 0) {
    return NextResponse.json({ success: true, data: { mailboxes: [], tickets: [] } })
  }

  // Asking for an account you cannot see is also empty rather than an error:
  // the mailbox id came from the caller, and answering differently for "exists
  // but not yours" would leak which addresses the studio runs.
  const mailboxId = searchParams.get('mailbox_id')
  if (mailboxId && !mailboxes.some(m => m.id === mailboxId)) {
    return NextResponse.json({ success: true, data: { mailboxes, tickets: [] } })
  }

  let query = db.from('email_tickets')
    .select('*')
    .eq('location_id', locationId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(TICKET_LIMIT)

  const visibleIds = mailboxes.map(m => m.id)
  if (mailboxId) {
    query = query.eq('mailbox_id', mailboxId)
  } else if (elevated && visibleIds.every(id => UUID_SHAPE.test(id))) {
    // Elevated only: also surface tickets with NO mailbox — mig 484's backfill
    // predates the column, and mailbox_id is ON DELETE SET NULL, so deleting
    // an address would otherwise erase its correspondence from every queue.
    // .in() never matches NULL, hence the or().
    //
    // .or() takes a RAW PostgREST filter string, so the ids are shape-checked
    // above and the whole branch falls through to the escaped .in() if any id
    // is not a plain uuid. (Same hazard the inbound webhook avoids by using
    // two .in() queries instead of one .or().)
    query = query.or(`mailbox_id.in.(${visibleIds.join(',')}),mailbox_id.is.null`)
  } else {
    query = query.in('mailbox_id', visibleIds)
  }

  query = applyView(query, view, user)

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, data: { mailboxes, tickets: data || [] } })
}

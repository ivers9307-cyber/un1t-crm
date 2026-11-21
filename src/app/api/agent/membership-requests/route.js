import { NextResponse } from 'next/server'
import { getUserLocationIds } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { selectAll } from '@/lib/select-all'
import { logWarn, logError } from '@/lib/log'
import { userIsMaster } from '@/lib/approvals/registry'

// RADAR-AGENT Phase 2 — operator approval queue for agent-captured
// requests. Two forms:
//
//   GET ?conversation_id=<uuid>  — INBOX-APPROVALS: every request for
//     one conversation (pending + decided) so the unified inbox can
//     render inline cards. Open to any staff at the conversation's
//     location — decision rights follow the comms surface.
//
//   GET (no params) — the full active-location history for the
//     /settings/customer-agent/requests review page. Manager+ (the
//     settings surface keeps its manager gate).

// APPROVALSQ.2 — who decided each row. One `profiles` read by id with named
// columns (server side only: the client gets the name, never the id or the
// profile row). A failed read leaves every name null and is logged; it never
// fails the list.
// A platform (master) decider reads "Support" to anyone who is not themselves
// a master (APPROVALSQ.3); `role` is read only to decide that and never leaves.
async function attachDeciderNames(db, rows, viewer) {
  const ids = [...new Set(rows.map(r => r.decided_by).filter(Boolean))]
  const names = new Map()
  const viewerIsMaster = userIsMaster(viewer)
  if (ids.length) {
    const { data, error } = await db.from('profiles').select('id, full_name, role').in('id', ids)
    if (error) logWarn('agent-membership-requests', 'decider name read failed', { err: error.message })
    else for (const p of data || []) names.set(p.id, p.role === 'master' && !viewerIsMaster ? 'Support' : (p.full_name || null))
  }
  return rows.map(({ decided_by, ...rest }) => ({ ...rest, decided_by_name: (decided_by && names.get(decided_by)) || null }))
}

// withAuth only signs the caller in; both forms keep their own checks below.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {

  const { searchParams } = new URL(request.url)
  const conversationId = searchParams.get('conversation_id')

  if (conversationId) {
    if (!uuidLike.safeParse(conversationId).success) {
      // Malformed id — same oracle-free empty shape as unknown/foreign ids
      // (a raw non-uuid would otherwise 500 on the PostgREST uuid cast).
      return NextResponse.json({ success: true, requests: [] })
    }
    const { data, error } = await db.from('agent_membership_requests')
      .select('id, kind, channel, conversation_id, location_id, contact_id, status, details, customer_note, retention_flagged, decided_at, decided_by, decision_note, created_at, contacts(id, name, first_name)')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(100)
    if (error) {
      logError('agent-membership-requests', 'conversation requests read failed', { err: error })
      return NextResponse.json({ success: false, error: 'Could not load the requests.' }, { status: 500 })
    }
    const rows = data || []
    // Cross-tenant probe and unknown id are indistinguishable: both get
    // the same 200-empty shape (no existence oracle — a 403 form would
    // tell a staffer at location A that a foreign conversation id exists).
    // getUserLocationIds returns every active location for master (their
    // user.locations is the full set), so masters always pass. The
    // `!== null` guard mirrors the PATCH sibling's pattern in case the
    // helper ever adopts null-means-unrestricted semantics.
    const allowedIds = getUserLocationIds(user)
    if (rows.length && allowedIds !== null && !allowedIds.includes(rows[0].location_id)) {
      return NextResponse.json({ success: true, requests: [] })
    }
    return NextResponse.json({ success: true, requests: await attachDeciderNames(db, rows, user) })
  }

  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  // AUDIT P1-2 — paginated. The approval queue shows the FULL request history
  // (pending sorts first), which accumulates without bound; an un-paginated
  // select would silently hide every request past row 1000 from staff. id is
  // the deterministic paging tiebreaker under the (status, created_at) sort.
  // selectAll throws on a DB error → map back to the existing 500 path.
  let data
  try {
    data = await selectAll((from, to) => db.from('agent_membership_requests')
      // AGENT-REQ-UX.1 — email/phone ride along for the operator's Glofox
      // lookup on the review page (manager+ surface, same fields the
      // /approvals provider exposes). AGENT-FUNNEL-CREDITS.1 adds the synced
      // membership/credit fields for the account summary line.
      .select('id, kind, channel, conversation_id, status, details, customer_note, retention_flagged, decided_at, decided_by, decision_note, created_at, contacts(id, name, first_name, email, phone, glofox_member_id, glofox_membership_plan, glofox_membership_status, glofox_membership_state, trial_credits_remaining)')
      .eq('location_id', locationId)
      .order('status', { ascending: true })   // pending sorts first alphabetically
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to))
  } catch (err) {
    logError('agent-membership-requests', 'request history read failed', { locationId, err: err?.message || String(err) })
    return NextResponse.json({ success: false, error: 'Could not load the requests.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, requests: await attachDeciderNames(db, data || [], user) })
})

import { NextResponse } from 'next/server'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { selectAll } from '@/lib/select-all'

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

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()

  const { searchParams } = new URL(request.url)
  const conversationId = searchParams.get('conversation_id')

  if (conversationId) {
    if (!uuidLike.safeParse(conversationId).success) {
      // Malformed id — same oracle-free empty shape as unknown/foreign ids
      // (a raw non-uuid would otherwise 500 on the PostgREST uuid cast).
      return NextResponse.json({ success: true, requests: [] })
    }
    const { data, error } = await db.from('agent_membership_requests')
      .select('id, kind, channel, conversation_id, location_id, contact_id, status, details, customer_note, retention_flagged, decided_at, decision_note, created_at, contacts(id, name, first_name)')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(100)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
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
    return NextResponse.json({ success: true, requests: rows })
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
      // /approvals provider exposes).
      .select('id, kind, channel, conversation_id, status, details, customer_note, retention_flagged, decided_at, decision_note, created_at, contacts(id, name, first_name, email, phone, glofox_member_id)')
      .eq('location_id', locationId)
      .order('status', { ascending: true })   // pending sorts first alphabetically
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to))
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, requests: data })
}

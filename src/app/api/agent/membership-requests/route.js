import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { selectAll } from '@/lib/select-all'

// RADAR-AGENT Phase 2 — operator approval queue for agent-captured
// pause / cancellation requests. Manager+ at the active location. The
// agent writes rows (service-role, from the webhook); staff read +
// decide here.

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const db = createServerClient()
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
      .select('id, kind, channel, status, details, customer_note, retention_flagged, decided_at, decision_note, created_at, contacts(id, name, first_name, glofox_member_id)')
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

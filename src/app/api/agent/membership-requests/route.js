import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'

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

  const { data, error } = await db.from('agent_membership_requests')
    .select('id, kind, channel, status, details, customer_note, retention_flagged, decided_at, decision_note, created_at, contacts(id, name, first_name, glofox_member_id)')
    .eq('location_id', locationId)
    .order('status', { ascending: true })   // pending sorts first alphabetically
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, requests: data || [] })
}

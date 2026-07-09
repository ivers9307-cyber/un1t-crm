// HOST-PORTAL.6 — /api/hosts/pending-events/count
//
// Sidebar badge polling: how many host events in the caller's org are
// sitting in pending_review. Same envelope as /api/approvals/count
// ({ success, data: { count } } — usePolledCount parses it). Non-admins
// and org-less sessions get a 0, not a 403 — the badge short-circuit
// pattern (the sidebar also gates the poll client-side).

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { ADMIN_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!ADMIN_ROLES.includes(user.role) || !orgId) {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }

  const db = createServerClient()
  try {
    const { data: hosts } = await db.from('event_hosts').select('id').eq('organization_id', orgId)
    const hostIds = (hosts || []).map((h) => h.id)
    if (hostIds.length === 0) {
      return NextResponse.json({ success: true, data: { count: 0 } })
    }
    // Plain column filters only — count-only (head:true) selects must
    // never use embedded-resource filters (they silently return 0).
    const { count, error } = await db
      .from('race_events')
      .select('id', { count: 'exact', head: true })
      .in('host_id', hostIds)
      .eq('status', 'pending_review')
    if (error) throw error
    return NextResponse.json({ success: true, data: { count: count || 0 } })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'count_failed' }, { status: 500 })
  }
}

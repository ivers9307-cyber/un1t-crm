// GET /api/hosts/pending-events — the org's host events awaiting review. ADMIN_ROLES.
// HOSTAUTOPUB.1 — nothing new lands in pending_review; this lists the rows
// left there from before, for the /settings/hosts queue.
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { ADMIN_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ADMIN_ROLES on user.role (the active studio's role), as before; the org is
// the active one.
export const GET = withAuth(
  { permission: null, location: false, roles: ADMIN_ROLES, forbiddenMessage: 'Manager+ required' },
  async ({ user, db }) => {
    const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
    if (!orgId) return NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 })

    const { data: hosts } = await db.from('event_hosts').select('id, name').eq('organization_id', orgId)
    const hostIds = (hosts || []).map((h) => h.id)
    const nameById = new Map((hosts || []).map((h) => [h.id, h.name]))
    if (hostIds.length === 0) return NextResponse.json({ success: true, data: [] })

    const { data: events } = await db
      .from('race_events')
      .select('id, host_id, name, venue_name, venue_address, venue_studio:locations!venue_location_id ( name ), race_date, non_member_fee_cents, description, submitted_at, race_waves ( start_time, capacity )')
      .in('host_id', hostIds)
      .eq('status', 'pending_review')
      .order('submitted_at', { ascending: true })
      .limit(200)
    const rows = (events || []).map((e) => ({ ...e, host_name: nameById.get(e.host_id) || '—' }))
    return NextResponse.json({ success: true, data: rows })
  },
)

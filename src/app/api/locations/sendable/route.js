import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Read-only: the real (non-anchor) UN1T locations in the org of the given
// event location, flagged with which one is the org master. Feeds the
// "Send comms from" picker on the event form. Access-controlled by
// assertLocationAccess on the event's own location; results are org-scoped.
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }
  const eventLocationId = new URL(request.url).searchParams.get('event_location_id')
  if (!eventLocationId) return NextResponse.json({ success: true, data: [] })
  const guard = assertLocationAccess(user, eventLocationId)
  if (guard) return guard

  const db = createServerClient()
  const { data: anchor } = await db.from('locations')
    .select('organization_id').eq('id', eventLocationId).maybeSingle()
  if (!anchor?.organization_id) return NextResponse.json({ success: true, data: [] })
  const [{ data: org }, { data: locs }] = await Promise.all([
    db.from('organizations').select('master_location_id').eq('id', anchor.organization_id).maybeSingle(),
    db.from('locations').select('id, name')
      .eq('organization_id', anchor.organization_id).eq('active', true).eq('is_host_anchor', false)
      .order('name'),
  ])
  const masterId = org?.master_location_id || null
  const data = (locs || []).map(l => ({ id: l.id, name: l.name, is_master: l.id === masterId }))
  return NextResponse.json({ success: true, data })
}

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { cancelRaceRegistration } from '@/lib/race-cancel'

// AGENT-EVENTS.3 — operator cancellation for a race/event
// registration (the first cancel primitive these rows have had).
// Capacity frees implicitly: wave counts exclude cancelled rows.
// Refunds, if any, are decided and processed by a human in Revolut.
export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: reg } = await db.from('race_registrations')
    .select('id, race_events!inner(location_id)')
    .eq('id', params.id)
    .maybeSingle()
  // 404 (not 403) so registration ids can't be enumerated.
  if (!reg) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const allowed = getUserLocationIds(user) // null = master
  if (allowed !== null && !allowed.includes(reg.race_events.location_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const result = await cancelRaceRegistration(db, params.id)
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  }
  return NextResponse.json({ success: true, already_cancelled: !!result.alreadyCancelled })
}

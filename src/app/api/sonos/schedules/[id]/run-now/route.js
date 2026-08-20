// SONOS.16 — "run now". Clears last_applied so the next cron tick treats
// the active window as unapplied and re-fires it (volume + favourite).
//
// Outside any window this is a no-op by construction: planAction only
// opens when a window is active, and it will not close a window it has no
// record of opening. The button recovers a window the room overrode; it is
// deliberately NOT a hidden stop control.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'device_control')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  const { id } = await params
  // Malformed id -> 404, never 500 from a Postgres type-cast error, and
  // never 400 either — detail routes 404 so ids can't be enumerated.
  if (!uuidLike.safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('sonos_schedules')
    .update({ last_applied: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('location_id', locationId)
    .select('id')
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true })
}

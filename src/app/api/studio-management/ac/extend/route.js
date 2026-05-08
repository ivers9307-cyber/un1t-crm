// POST /api/studio-management/ac/extend
//
// Push the auto-off time of the active session forward by N
// minutes (default 30). Useful when a class is running long and
// staff don't want the AC to cut out mid-session. Doesn't touch
// Sensibo — the AC is already on, we're just nudging our timer.
//
// Body: { minutes?: number }   default 30, capped at 240.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { AC_SESSION_STATUS, AC_SESSION_ACTIVE_STATUSES } from '@/lib/enums'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ExtendSchema = z.object({
  minutes: z.number().int().min(5).max(240).optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'studio_management')) {
    return NextResponse.json(
      { success: false, error: 'Studio management is not enabled for your role at this location.' },
      { status: 403 }
    )
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location.' }, { status: 400 })
  }

  const validation = await validateBody(request, ExtendSchema)
  if (!validation.ok) return validation.response
  const minutes = validation.data.minutes ?? 30

  const db = createServerClient()
  const { data: openRows } = await db
    .from('ac_sessions')
    .select('id, auto_off_at, status')
    .eq('location_id', locationId)
    .in('status', AC_SESSION_ACTIVE_STATUSES)
    .order('started_at', { ascending: false })
    .limit(1)
  const session = openRows?.[0]
  if (!session) {
    return NextResponse.json({
      success: false, error: 'No active AC session to extend.', code: 'no_active_session',
    }, { status: 409 })
  }

  // Add to whatever auto_off_at currently is — extending mid-class
  // gives the operator the full extra block from the existing end,
  // not "30 min from now" which would shorten things if they hit
  // the button early.
  const base = session.auto_off_at ? new Date(session.auto_off_at).getTime() : Date.now()
  const newAutoOff = new Date(base + minutes * 60_000).toISOString()

  const { data: updated, error } = await db
    .from('ac_sessions')
    .update({ status: AC_SESSION_STATUS.EXTENDED, auto_off_at: newAutoOff })
    .eq('id', session.id)
    .in('status', AC_SESSION_ACTIVE_STATUSES)
    .select()
    .single()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data: updated })
}

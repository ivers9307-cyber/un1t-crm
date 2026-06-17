// POST /api/automations/[key]/run-now — operator-triggered "Run check now".
// Only class_climate supports it today. Refreshes the location's Glofox
// class schedule, then runs the climate logic so the operator can watch
// the AC respond on demand instead of waiting for the cron. { dry_run:true }
// previews what WOULD fire without touching the AC.

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation } from '@/lib/glofox'
import { syncOccurrencesForLocation } from '@/lib/class-occurrences'
import { runClassClimate } from '@/lib/class-climate-runner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({
  location_id: uuidLike,
  dry_run: z.boolean().optional(),
})

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { key } = await params
  if (key !== 'class_climate') {
    return NextResponse.json({ success: false, error: 'run-now is not supported for this automation' }, { status: 400 })
  }

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { location_id, dry_run } = validation.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard

  const db = createServerClient()

  // Refresh the schedule first so "run now" reflects the live timetable.
  const creds = await glofoxCredentialsForLocation(db, location_id)
  const missing = missingGlofoxCredentialsForLocation(creds)
  let synced = null
  if (missing.length === 0) {
    synced = await syncOccurrencesForLocation(db, { locationId: location_id, creds })
  }

  const out = await runClassClimate(db, { locationId: location_id, dryRun: Boolean(dry_run) })
  const loc = out.locations?.[0] || { planned: [], actions: [], errors: [] }

  return NextResponse.json({
    success: true,
    glofox_configured: missing.length === 0,
    synced,
    planned: loc.planned,
    actions: loc.actions,
    errors: loc.errors,
  })
}

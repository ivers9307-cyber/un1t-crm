// GET (count) + POST (run one batch) — Glofox lead-provisioning backfill.
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { getAutomation } from '@/lib/automations/registry'
import { runGlofoxBackfillBatch } from '@/lib/automations/glofox-backfill'

export const runtime = 'nodejs'
export const maxDuration = 300

const BATCH = 20

function unauthorized() {
  return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
}

// withAuth only signs the caller in (a signed-out call is its 401, where this
// route said 403); the coarse role pre-check, the automation key, the studio
// and the role AT that studio follow in their old order.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  // ROLESWEEP.1a — coarse pre-check; the role is judged at location_id below.
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) return unauthorized()
  const key = params?.key
  if (key !== 'glofox_lead_provisioning' || !getAutomation(key)) {
    return NextResponse.json({ success: false, error: 'unknown_automation' }, { status: 400 })
  }
  const locationId = new URL(request.url).searchParams.get('location_id')
  if (!locationId) return NextResponse.json({ success: false, error: 'missing location_id' }, { status: 400 })
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) return unauthorized()

  const { data, error } = await db.rpc('glofox_backfill_eligible_count', { p_location_id: locationId })
  if (error) {
    logError('automations', 'backfill count failed', { locationId, code: error.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not count the contacts to backfill.' }, { status: 400 })
  }
  return NextResponse.json({ success: true, data: { eligible: Number(data) || 0 } })
})

const PostSchema = z.object({ location_id: uuidLike })

export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  if (!hasRoleAtAnyLocation(user, MANAGER_ROLES)) return unauthorized()
  const key = params?.key
  if (key !== 'glofox_lead_provisioning' || !getAutomation(key)) {
    return NextResponse.json({ success: false, error: 'unknown_automation' }, { status: 400 })
  }
  const validation = await validateBody(request, PostSchema)
  if (!validation.ok) return validation.response
  const guard = assertLocationAccess(user, validation.data.location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, validation.data.location_id, MANAGER_ROLES)) return unauthorized()

  const result = await runGlofoxBackfillBatch({ db, locationId: validation.data.location_id, limit: BATCH })
  return NextResponse.json({ success: true, data: result })
})

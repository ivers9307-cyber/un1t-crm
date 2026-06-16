// GET (count) + POST (run one batch) — Glofox lead-provisioning backfill.
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
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

export async function GET(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) return unauthorized()
  const { key } = await params
  if (key !== 'glofox_lead_provisioning' || !getAutomation(key)) {
    return NextResponse.json({ success: false, error: 'unknown_automation' }, { status: 400 })
  }
  const locationId = new URL(request.url).searchParams.get('location_id')
  if (!locationId) return NextResponse.json({ success: false, error: 'missing location_id' }, { status: 400 })
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db.rpc('glofox_backfill_eligible_count', { p_location_id: locationId })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data: { eligible: Number(data) || 0 } })
}

const PostSchema = z.object({ location_id: uuidLike })

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) return unauthorized()
  const { key } = await params
  if (key !== 'glofox_lead_provisioning' || !getAutomation(key)) {
    return NextResponse.json({ success: false, error: 'unknown_automation' }, { status: 400 })
  }
  const validation = await validateBody(request, PostSchema)
  if (!validation.ok) return validation.response
  const guard = assertLocationAccess(user, validation.data.location_id)
  if (guard) return guard

  const db = createServerClient()
  const result = await runGlofoxBackfillBatch({ db, locationId: validation.data.location_id, limit: BATCH })
  return NextResponse.json({ success: true, data: result })
}

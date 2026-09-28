// PUT /api/automations/[key] — toggle/configure a per-location automation.
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { getAutomation } from '@/lib/automations/registry'

export const runtime = 'nodejs'

const Schema = z.object({
  location_id: uuidLike,
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()).optional(),
})

export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  // ROLESWEEP.1a — coarse pre-check only; the role is judged at
  // body.location_id below, never at the active studio (user.role).
  if (!user || !hasRoleAtAnyLocation(user, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { key } = await params
  if (!getAutomation(key)) {
    return NextResponse.json({ success: false, error: 'unknown_automation' }, { status: 400 })
  }

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard
  if (!hasRoleAtLocation(user, body.location_id, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('location_automations')
    .upsert({
      location_id: body.location_id,
      automation_key: key,
      enabled: body.enabled,
      config: body.config || {},
      updated_at: new Date().toISOString(),
      updated_by: user.id,
    }, { onConflict: 'location_id,automation_key' })
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

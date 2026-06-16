// PUT /api/automations/[key] — toggle/configure a per-location automation.
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
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
  if (!user || !MANAGER_ROLES.includes(user.role)) {
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

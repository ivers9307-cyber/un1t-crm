import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { maskConnectionRow, buildConnectionPatch } from '@/lib/agent/channels'
import { validateBody } from '@/lib/validate'

const ChannelPatchSchema = z.object({
  label: z.string().optional(),
  external_account_id: z.string().nullable().optional(),
  page_id: z.string().nullable().optional(),
  app_id: z.string().nullable().optional(),
  display_name: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
  agent_enabled: z.boolean().optional(),
}).passthrough()

// PATCH /api/locations/[id]/channels/[connId] — update a connection.
// Secrets are only overwritten when a fresh value is supplied (a masked
// echo or blank leaves the stored secret untouched).
export async function PATCH(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { id: locationId, connId } = params
  const allowed = user.role === 'master' || (MANAGER_ROLES.includes(user.role) && (user.locations || []).some(l => l.id === locationId))
  if (!allowed) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const validation = await validateBody(request, ChannelPatchSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // Look up the row's platform for the one-active deactivation step.
  const { data: existing } = await db.from('channel_connections')
    .select('platform')
    .eq('id', connId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (!existing) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const patch = buildConnectionPatch(body, {
    fields: ['label', 'external_account_id', 'page_id', 'app_id', 'display_name', 'is_active', 'agent_enabled'],
  })
  patch.updated_at = new Date().toISOString()
  patch.updated_by = user.id

  // If re-activating this row, clear any other active row for the platform.
  if (patch.is_active === true) {
    await db.from('channel_connections')
      .update({ is_active: false })
      .eq('location_id', locationId)
      .eq('platform', existing.platform)
      .eq('is_active', true)
      .neq('id', connId)
  }

  const { data, error } = await db.from('channel_connections')
    .update(patch)
    .eq('id', connId)
    .eq('location_id', locationId)
    .select()
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, connection: maskConnectionRow(data) })
}

// DELETE /api/locations/[id]/channels/[connId]
export async function DELETE(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { id: locationId, connId } = params
  const allowed = user.role === 'master' || (MANAGER_ROLES.includes(user.role) && (user.locations || []).some(l => l.id === locationId))
  if (!allowed) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const db = createServerClient()
  const { error } = await db.from('channel_connections')
    .delete()
    .eq('id', connId)
    .eq('location_id', locationId)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}

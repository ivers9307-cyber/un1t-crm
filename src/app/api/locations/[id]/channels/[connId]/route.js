import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation } from '@/lib/auth'
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

// LOCFIX-ROLEGATE.1 — both handlers judge the role AT params.id, never via
// `user.role`. That field resolves at the caller's ACTIVE location (with a
// highest-role-anywhere fallback in auth.js), while these writes land on the
// path-param location — so the old single `allowed` boolean
// (`user.role === 'master' || (MANAGER_ROLES.includes(user.role) && member)`)
// let a manager at studio A who is plain STAFF at studio B repoint B's
// connection at their own IG account, flip `agent_enabled`, or delete the row
// outright and silence B's DMs, with a 200: membership was judged at the
// target but the ROLE was judged at A.
//
// The boolean is split into the two questions it was conflating, in the #1589
// email-copy order: MEMBERSHIP (assertLocationAccess) then the role AT THAT
// TARGET. The membership half now answers the guard's own copy — "Forbidden —
// location not in your assignments" instead of the generic "Forbidden" — an
// intended, more informative change; the ROLE miss keeps this route's
// "Forbidden". Tier is MANAGER_ROLES (head_coach INCLUDED), deliberately wider
// than the ['master','owner','manager'] the stripe-connect routes use.

// PATCH /api/locations/[id]/channels/[connId] — update a connection.
// Secrets are only overwritten when a fresh value is supplied (a masked
// echo or blank leaves the stored secret untouched).
export async function PATCH(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { id: locationId, connId } = params
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

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
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { error } = await db.from('channel_connections')
    .delete()
    .eq('id', connId)
    .eq('location_id', locationId)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}

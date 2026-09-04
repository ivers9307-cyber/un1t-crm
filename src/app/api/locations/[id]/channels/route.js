import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess, hasRoleAtLocation } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { maskConnectionRow, buildConnectionPatch, SUPPORTED_PLATFORMS } from '@/lib/agent/channels'
import { validateBody } from '@/lib/validate'

const ChannelConnectionSchema = z.object({
  platform: z.string().min(1),
  label: z.string().max(200).optional(),
  external_account_id: z.string().max(200).optional(),
  page_id: z.string().max(200).optional(),
  app_id: z.string().max(200).optional(),
  display_name: z.string().max(200).optional(),
  is_active: z.boolean().optional(),
  agent_enabled: z.boolean().optional(),
  access_token: z.string().max(2000).optional(),
  app_secret: z.string().max(500).optional(),
})

// GET /api/locations/[id]/channels — list channel connections for a
// location. Masks secrets (access_token, app_secret). Mirrors the
// whatsapp/numbers route conventions.
export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const locationId = params.id
  const allowed = user.role === 'master' || (user.locations || []).some(l => l.id === locationId)
  if (!allowed) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const db = createServerClient()
  const { data, error } = await db.from('channel_connections')
    .select('*')
    .eq('location_id', locationId)
    .order('platform', { ascending: true })
    .order('updated_at', { ascending: false })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, connections: (data || []).map(maskConnectionRow) })
}

// POST /api/locations/[id]/channels — add a connection.
//
// LOCFIX-ROLEGATE.1 — the role is judged AT params.id, never via `user.role`.
// That field resolves at the caller's ACTIVE location (with a
// highest-role-anywhere fallback in auth.js), while this write lands on the
// path-param location — so the old single `allowed` boolean
// (`user.role === 'master' || (MANAGER_ROLES.includes(user.role) && member)`)
// let a manager at studio A who is plain STAFF at studio B attach their own
// Instagram account to B and take over B's DMs, with a 200: membership was
// judged at the target but the ROLE was judged at A.
//
// The boolean is split into the two questions it was conflating, in the #1589
// email-copy order: MEMBERSHIP (assertLocationAccess) then the role AT THAT
// TARGET. The membership half now answers the guard's own copy — "Forbidden —
// location not in your assignments" instead of the generic "Forbidden" — an
// intended, more informative change; the ROLE miss keeps this route's
// "Forbidden". Tier is MANAGER_ROLES (head_coach INCLUDED), deliberately wider
// than the ['master','owner','manager'] the stripe-connect routes use.
export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const locationId = params.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const validation = await validateBody(request, ChannelConnectionSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  if (!SUPPORTED_PLATFORMS.includes(body.platform)) {
    return NextResponse.json({ success: false, error: `platform must be one of: ${SUPPORTED_PLATFORMS.join(', ')}` }, { status: 400 })
  }

  const db = createServerClient()
  const patch = buildConnectionPatch(body)

  // Partial unique index enforces one active per (location, platform).
  // Deactivate any existing active row for this platform first so the
  // new one becomes the active connection cleanly.
  if (patch.is_active !== false) {
    await db.from('channel_connections')
      .update({ is_active: false })
      .eq('location_id', locationId)
      .eq('platform', body.platform)
      .eq('is_active', true)
    patch.is_active = true
  }

  const { data, error } = await db.from('channel_connections').insert({
    location_id: locationId,
    updated_by: user.id,
    ...patch,
  }).select().single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, connection: maskConnectionRow(data) })
}

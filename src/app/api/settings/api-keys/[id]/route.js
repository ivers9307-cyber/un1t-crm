// APIKEYS.2 — revoke a per-org API key.
//
// DELETE /api/settings/api-keys/:id → sets revoked_at (soft revoke;
// authenticateApiKey ignores revoked rows). Scoped to the caller's
// active organization so one org can't revoke another's key.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(request, ctx) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!['master', 'owner'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 })
  }
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 })

  const { id } = (await ctx.params) || {}
  if (!id) return NextResponse.json({ success: false, error: 'bad_id' }, { status: 400 })

  const db = createServerClient()
  // Scope the update to the caller's org so an owner can't revoke a key
  // belonging to another organization by guessing its id.
  const { data, error } = await db
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 })
  return NextResponse.json({ success: true })
}

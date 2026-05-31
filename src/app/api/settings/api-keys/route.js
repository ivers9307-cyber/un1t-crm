// APIKEYS.2 — management API: list + create per-org API keys.
//
// Auth: master/owner only (sensitive — a key grants programmatic access
// to the org's data). Keys are always scoped to the caller's ACTIVE
// organization; an owner can only manage keys for an org they operate in.
//
// GET  /api/settings/api-keys           → { success, keys: [...] }  (no secrets)
// POST /api/settings/api-keys { name }  → { success, key, secret }  (secret shown ONCE)

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { generateApiKey } from '@/lib/api-keys'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
})

// Resolve the caller + the org they're managing keys for. Returns either
// { user, orgId } or a NextResponse to return immediately.
async function gate() {
  const user = await getCurrentUser()
  if (!user) return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!['master', 'owner'].includes(user.role)) {
    return { error: NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 }) }
  }
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) {
    return { error: NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 }) }
  }
  return { user, orgId }
}

export async function GET() {
  const g = await gate()
  if (g.error) return g.error
  const db = createServerClient()
  const { data, error } = await db
    .from('api_keys')
    .select('id, name, key_prefix, created_at, last_used_at, revoked_at')
    .eq('organization_id', g.orgId)
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, keys: data || [] })
}

export async function POST(request) {
  const g = await gate()
  if (g.error) return g.error
  const validation = await validateBody(request, CreateSchema)
  if (!validation.ok) return validation.response

  const { full, prefix, hash } = generateApiKey()
  const db = createServerClient()
  const { data, error } = await db
    .from('api_keys')
    .insert({
      organization_id: g.orgId,
      name: validation.data.name,
      key_prefix: prefix,
      key_hash: hash,
      created_by: g.user.id,
    })
    .select('id, name, key_prefix, created_at')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  // `secret` is the full raw key — returned exactly once, never stored.
  return NextResponse.json({ success: true, key: data, secret: full })
}

// APIKEYS.2 — management API: list + create per-org API keys.
//
// Auth: organisation admins only (sensitive — a key grants programmatic
// access to the org's data). Keys are always scoped to the caller's ACTIVE
// organization, and the caller must be an admin of it (C18 ORGROLE.1:
// master or an org_admin grant; a studio owner is not one — it used to ask
// the ACTIVE studio's role).
//
// GET  /api/settings/api-keys           → { success, keys: [...] }  (no secrets)
// POST /api/settings/api-keys { name }  → { success, key, secret }  (secret shown ONCE)

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { activeOrganizationId, isOrgAdmin } from '@/lib/org-admin'
import { validateBody } from '@/lib/validate'
import { generateApiKey } from '@/lib/api-keys'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
})

// Resolve the org the signed-in caller (withAuth) is managing keys for.
// Returns either { user, orgId } or a NextResponse to return immediately.
function gate(user) {
  const orgId = activeOrganizationId(user)
  if (!isOrgAdmin(user, orgId)) {
    return { error: NextResponse.json({ success: false, error: 'forbidden' }, { status: 403 }) }
  }
  if (!orgId) {
    return { error: NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 }) }
  }
  return { user, orgId }
}

export const GET = withAuth({ permission: null, location: false }, async ({ user, db }) => {
  const g = gate(user)
  if (g.error) return g.error
  const { data, error } = await db
    .from('api_keys')
    .select('id, name, key_prefix, created_at, last_used_at, revoked_at')
    .eq('organization_id', g.orgId)
    .order('created_at', { ascending: false })
  if (error) {
    logError('api-keys', 'key list read failed', { organizationId: g.orgId, code: error.code ?? null, message: error.message })
    return NextResponse.json({ success: false, error: 'Could not load API keys just now.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, keys: data || [] })
})

export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request }) => {
  const g = gate(user)
  if (g.error) return g.error
  const validation = await validateBody(request, CreateSchema)
  if (!validation.ok) return validation.response

  const { full, prefix, hash } = generateApiKey()
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
  if (error) {
    logError('api-keys', 'key create failed', { organizationId: g.orgId, code: error.code ?? null, message: error.message })
    return NextResponse.json({ success: false, error: 'Could not create the key just now.' }, { status: 500 })
  }

  // `secret` is the full raw key — returned exactly once, never stored.
  return NextResponse.json({ success: true, key: data, secret: full })
})

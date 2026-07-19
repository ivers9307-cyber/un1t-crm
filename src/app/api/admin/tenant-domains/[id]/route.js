// /api/admin/tenant-domains/[id] — master-only detail mutations for
// a tenant_domains mapping (SAAS-8, mig 415).
//
//   PATCH  — update hostname / organization_id / brand / active
//            (active=false is the soft kill switch: the hostname
//            falls through to the CRM auth gate within the proxy
//            cache TTL, config kept)
//   DELETE — remove the mapping outright
//
// Unknown ids return 404 (detail routes never 403 on a missing row).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike, tenantHostname, tenantDomainBrandConfigSchema } from '@/lib/schemas'
import { reservedHostnameError } from '../route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const TenantDomainPatchSchema = z.object({
  hostname: tenantHostname.optional(),
  organization_id: uuidLike.optional(),
  brand: tenantDomainBrandConfigSchema.optional(),
  active: z.boolean().optional(),
})

async function requireMaster() {
  const user = await getCurrentUser()
  if (!user) return { response: NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 }) }
  if (user.profileRole !== 'master') {
    return { response: NextResponse.json({ success: false, error: 'Master only' }, { status: 403 }) }
  }
  return { user }
}

async function loadRow(db, id) {
  if (!id || !uuidLike.safeParse(id).success) return null
  const { data } = await db
    .from('tenant_domains')
    .select('id, hostname, organization_id, brand, active')
    .eq('id', id)
    .maybeSingle()
  return data || null
}

export async function PATCH(request, props) {
  const params = await props.params
  const gate = await requireMaster()
  if (gate.response) return gate.response

  const validation = await validateBody(request, TenantDomainPatchSchema)
  if (!validation.ok) return validation.response
  const patch = {}
  for (const k of ['hostname', 'organization_id', 'brand', 'active']) {
    if (validation.data[k] !== undefined) patch[k] = validation.data[k]
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ success: false, error: 'No fields to update' }, { status: 400 })
  }

  const db = createServerClient()
  const row = await loadRow(db, params?.id)
  if (!row) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  if (patch.hostname && patch.hostname !== row.hostname) {
    const reserved = reservedHostnameError(patch.hostname)
    if (reserved) {
      return NextResponse.json({ success: false, error: reserved }, { status: 400 })
    }
  }

  const { data: updated, error } = await db
    .from('tenant_domains')
    .update(patch)
    .eq('id', row.id)
    .select()
    .single()
  if (error) {
    if (error.code === '23505' || /duplicate key|already exists|unique/i.test(error.message || '')) {
      return NextResponse.json({
        success: false,
        error: `A mapping for "${patch.hostname}" already exists.`,
        code: 'duplicate_hostname',
      }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data: updated })
}

export async function DELETE(request, props) {
  const params = await props.params
  const gate = await requireMaster()
  if (gate.response) return gate.response

  const db = createServerClient()
  const row = await loadRow(db, params?.id)
  if (!row) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const { error } = await db
    .from('tenant_domains')
    .delete()
    .eq('id', row.id)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { id: row.id } })
}

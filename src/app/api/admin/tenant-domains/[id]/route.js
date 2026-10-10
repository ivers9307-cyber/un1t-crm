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
// A source='platform' row (W1.L1, mig 716) answers 409 to DELETE and to
// any PATCH other than the active kill switch.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike, tenantHostname, tenantDomainBrandConfigSchema } from '@/lib/schemas'
import { reservedHostnameError, locationOrgMismatchError } from '../route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const TenantDomainPatchSchema = z.object({
  hostname: tenantHostname.optional(),
  organization_id: uuidLike.optional(),
  // OPTIONAL per-location scoping (mig 432). null clears it back to
  // whole-org; a uuid scopes to that studio (must belong to the org).
  location_id: uuidLike.nullish(),
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

// W1.L1 (mig 716): the org's <slug>.repset.ie row is automatic — its
// hostname, org, location and brand are never edited by hand and it is
// never deleted (it lives and dies with the org). `active` is the ONE
// exception: tenant_domains.active is the hostname kill switch the suspend
// route (admin/orgs/[id]/suspend) deliberately leaves to this screen, so a
// PATCH whose only key is `active` goes through.
function platformRowError(row, patch = null) {
  if (row.source !== 'platform') return null
  if (patch && Object.keys(patch).every((k) => k === 'active')) return null
  return NextResponse.json({
    success: false,
    error: `"${row.hostname}" is the organisation's automatic platform host; only its active flag can change, and it cannot be deleted.`,
    code: 'platform_host',
  }, { status: 409 })
}

async function loadRow(db, id) {
  if (!id || !uuidLike.safeParse(id).success) return null
  const { data } = await db
    .from('tenant_domains')
    .select('id, hostname, organization_id, location_id, brand, active, source')
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
  for (const k of ['hostname', 'organization_id', 'location_id', 'brand', 'active']) {
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
  const platform = platformRowError(row, patch)
  if (platform) return platform

  if (patch.hostname && patch.hostname !== row.hostname) {
    const reserved = reservedHostnameError(patch.hostname)
    if (reserved) {
      return NextResponse.json({ success: false, error: reserved }, { status: 400 })
    }
  }

  // Per-location scoping (mig 432): the effective location must belong
  // to the effective org — covers changing the location, the org, or
  // both. A null effective location is whole-org (no check).
  const effectiveOrg = patch.organization_id ?? row.organization_id
  const effectiveLoc = ('location_id' in patch) ? patch.location_id : row.location_id
  const locErr = await locationOrgMismatchError(db, effectiveLoc, effectiveOrg)
  if (locErr) {
    return NextResponse.json({ success: false, error: locErr }, { status: 400 })
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
  const platform = platformRowError(row)
  if (platform) return platform

  const { error } = await db
    .from('tenant_domains')
    .delete()
    .eq('id', row.id)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { id: row.id } })
}

// /api/admin/tenant-domains — master-only CRUD for the DB tier of the
// multi-brand hostname registry (SAAS-8, mig 415).
//
//   GET   — list every mapping (with the org's name/slug for display)
//   POST  — create a mapping; the hostname is live within the proxy
//           cache TTL (~5 min) — no deploy
//
// Hostnames that the in-code BRANDS registry already resolves are
// refused (the registry is the authoritative first tier — a row for
// one of them would be dead data + dual-source drift), as is the
// CRM's own hostname (a brand row there would gate the staff CRM
// itself). Duplicate hostnames surface as a clean 409, not a raw
// Postgres error.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike, tenantHostname, tenantDomainBrandConfigSchema } from '@/lib/schemas'
import { resolveBrand, getCrmHostnames } from '@/lib/brands'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const TenantDomainCreateSchema = z.object({
  hostname: tenantHostname,
  organization_id: uuidLike,
  // OPTIONAL per-location scoping (mig 432). Null/omitted = whole org.
  // Must belong to organization_id — validated below.
  location_id: uuidLike.nullish(),
  brand: tenantDomainBrandConfigSchema.optional(),
  active: z.boolean().optional(),
})

/**
 * Validate that a location (if given) belongs to organizationId.
 * Returns an error string for a 400, or null when OK / no location.
 * A location_id of null/undefined is the whole-org default — no check.
 */
export async function locationOrgMismatchError(db, locationId, organizationId) {
  if (!locationId) return null
  const { data: loc } = await db
    .from('locations')
    .select('id, organization_id')
    .eq('id', locationId)
    .maybeSingle()
  if (!loc || loc.organization_id !== organizationId) {
    return 'The chosen location does not belong to the selected organization.'
  }
  return null
}

/**
 * Hostnames the DB tier must never carry. The in-code registry is
 * checked directly; the CRM hosts are the SET from getCrmHostnames()
 * (REPSET-P6 dual-domain: {crm.un1tdublin.com, crm.repset.ie} plus
 * the NEXT_PUBLIC_APP_URL host) — an admin must not be able to
 * insert ANY of them as a tenant row, or that row would brand-gate
 * the staff CRM on that domain. hostname arrives lowercased by the
 * tenantHostname schema.
 */
export function reservedHostnameError(hostname) {
  if (resolveBrand(hostname)) {
    return `"${hostname}" is handled by the in-code brand registry (src/lib/brands.js) — it must not have a tenant_domains row.`
  }
  if (getCrmHostnames().includes(hostname)) {
    return `"${hostname}" is the CRM's own hostname — a brand row here would gate the staff CRM itself.`
  }
  return null
}

async function requireMaster() {
  const user = await getCurrentUser()
  if (!user) return { response: NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 }) }
  if (user.profileRole !== 'master') {
    return { response: NextResponse.json({ success: false, error: 'Master only' }, { status: 403 }) }
  }
  return { user }
}

export async function GET() {
  const gate = await requireMaster()
  if (gate.response) return gate.response

  const db = createServerClient()
  const { data, error } = await db
    .from('tenant_domains')
    .select('id, hostname, organization_id, location_id, brand, active, created_at, organizations:organization_id (name, slug), locations:location_id (name)')
    .order('hostname')
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: data || [] })
}

export async function POST(request) {
  const gate = await requireMaster()
  if (gate.response) return gate.response

  const validation = await validateBody(request, TenantDomainCreateSchema)
  if (!validation.ok) return validation.response
  const { hostname, organization_id, location_id = null, brand = {}, active = true } = validation.data

  const reserved = reservedHostnameError(hostname)
  if (reserved) {
    return NextResponse.json({ success: false, error: reserved }, { status: 400 })
  }

  const db = createServerClient()

  // Clean errors for the two common mistakes; the DB constraints
  // (FK, UNIQUE) remain the race-safe backstop below.
  const { data: org } = await db
    .from('organizations')
    .select('id')
    .eq('id', organization_id)
    .maybeSingle()
  if (!org) {
    return NextResponse.json({ success: false, error: 'Unknown organization' }, { status: 400 })
  }

  // Per-location scoping (mig 432): the location must belong to the org.
  const locErr = await locationOrgMismatchError(db, location_id, organization_id)
  if (locErr) {
    return NextResponse.json({ success: false, error: locErr }, { status: 400 })
  }
  const { data: existing } = await db
    .from('tenant_domains')
    .select('id')
    .eq('hostname', hostname)
    .maybeSingle()
  if (existing) {
    return NextResponse.json({
      success: false,
      error: `A mapping for "${hostname}" already exists.`,
      code: 'duplicate_hostname',
    }, { status: 409 })
  }

  const { data: created, error: insertErr } = await db
    .from('tenant_domains')
    .insert({ hostname, organization_id, location_id: location_id ?? null, brand, active })
    .select()
    .single()
  if (insertErr) {
    if (insertErr.code === '23505' || /duplicate key|already exists|unique/i.test(insertErr.message || '')) {
      return NextResponse.json({
        success: false,
        error: `A mapping for "${hostname}" already exists.`,
        code: 'duplicate_hostname',
      }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: insertErr.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data: created })
}

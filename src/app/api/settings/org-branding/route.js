import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { isOrgAdminSomewhere, resolveAdminOrgId } from '@/lib/org-admin'
import { validateBody, uuidLike } from '@/lib/validate'
import { httpUrl } from '@/lib/schemas'

// Organisation-level branding defaults (mig 317). Locations inherit these via
// getLocationBranding when they have not set their own. Mirrors
// /api/settings/branding but keyed on organization_id. C18 ORGROLE.1:
// organisation admins only — master may target any org, an org admin
// (org_admin grant) only the orgs they administer; a studio owner is not one.
const OrgBrandingSchema = z.object({
  organization_id: uuidLike.optional(),
  // HYGIENE-PII.1 — http(s) only; these render into <img src> / <link rel=icon>.
  logo_url: httpUrl.nullable().optional(),
  favicon_url: httpUrl.nullable().optional(),
  company_name: z.string().max(200).nullable().optional(),
  // W1.B1 — the SHORT wordmark productName() builds "{Brand} Points" /
  // "{Brand} HR" from (mig 715; column CHECK length 1..40, so a blank is
  // written as null below). NULL = use company_name.
  short_name: z.string().trim().max(40).nullable().optional(),
  // SAAS4-C2 — the tenant's legal identity for their privacy notice
  // (mig 425). Entity name + privacy email must BOTH be set before the
  // tenant's hostname serves the tenant-entity notice.
  legal_entity_name: z.string().max(200).nullable().optional(),
  legal_trading_name: z.string().max(200).nullable().optional(),
  legal_address: z.string().max(500).nullable().optional(),
  privacy_contact_email: z.string().email().max(200).nullable().optional(),
})

// Resolve the org the caller may act on (resolveAdminOrgId). Returns null when
// the caller is not an admin of the requested/active org.
function resolveOrgId(user, requested) {
  return resolveAdminOrgId(user, requested).orgId || null
}

// GET /api/settings/org-branding?organization_id=xxx — org branding defaults
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const orgId = resolveOrgId(user, searchParams.get('organization_id'))
  if (!orgId) return NextResponse.json({ success: false, error: 'No organisation access' }, { status: 403 })

  const db = createServerClient()
  const { data, error } = await db.from('org_settings')
    .select('*')
    .eq('organization_id', orgId)
    .maybeSingle()
  if (error) {
    return NextResponse.json({ success: false, error: 'Could not load the organisation branding just now.' }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: data || null })
}

// PUT /api/settings/org-branding — upsert org branding (organisation admin)
export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!isOrgAdminSomewhere(user)) {
    return NextResponse.json({ success: false, error: 'Only organisation admins can update organisation branding' }, { status: 403 })
  }

  const validation = await validateBody(request, OrgBrandingSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const orgId = resolveOrgId(user, body.organization_id)
  if (!orgId) return NextResponse.json({ success: false, error: 'No organisation access' }, { status: 403 })

  const db = createServerClient()
  const record = {
    organization_id: orgId,
    logo_url: body.logo_url ?? null,
    favicon_url: body.favicon_url ?? null,
    company_name: body.company_name ?? null,
    short_name: body.short_name || null,
    updated_at: new Date().toISOString(),
    updated_by: user.id,
  }
  // SAAS4-C2 legal fields: included ONLY when present in the body —
  // unlike the branding trio above, an older client saving branding
  // must never null-out the tenant's legal identity.
  for (const key of ['legal_entity_name', 'legal_trading_name', 'legal_address', 'privacy_contact_email']) {
    if (key in body) record[key] = body[key]
  }

  const { data, error } = await db.from('org_settings')
    .upsert(record, { onConflict: 'organization_id' })
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

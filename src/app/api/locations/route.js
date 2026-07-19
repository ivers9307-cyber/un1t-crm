import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey } from '@/lib/api-auth'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { toSlug } from '@/lib/slug'
import { seedLocationDefaults } from '@/lib/location-seed'

// GET /api/locations — List all active locations
export async function GET(request) {
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const db = createServerClient()
  let query = db
    .from('locations')
    .select('id, name, slug, address, active, timezone, country')
    .eq('active', true)
    .eq('is_host_anchor', false)
    .order('name')
  // APIKEYS.3 — per-org key: only this org's locations (locations carries
  // organization_id directly). Legacy/cookie callers unchanged.
  if (auth.orgId) query = query.eq('organization_id', auth.orgId)
  const { data, error } = await query

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}

// POST /api/locations — Create a location (master-only) and seed its
// per-location defaults server-side. SAAS4-W0.1: creation moved out of
// LocationForm's browser-client insert — the client-side path seeded a
// stale pre-FUNNEL pipeline taxonomy (the mig 150 incident class) and
// left seeding at the mercy of the browser session. Edits stay
// browser-side in LocationForm (RLS-checked, unchanged).
const INVOICE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/

const LocationCreate = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  organization_id: uuidLike,
  address: z.string().trim().max(300).nullish(),
  phone: z.string().trim().max(50).nullish(),
  email: z.string().trim().email().max(200).nullish(),
  timezone: z.string().trim().min(1).max(64).default('Europe/Dublin'),
  country: z.string().trim().length(2).toUpperCase().default('IE'),
  active: z.boolean().default(true),
  monthly_contractor_budget_eur: z.number().min(0).nullish(),
  invoices_inbound_slug: z.string().trim().regex(INVOICE_SLUG_RE).nullish(),
  email_inbox_reply_to: z.string().trim().toLowerCase().email().nullish(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  // Matches the RBAC matrix + the master-only /settings/locations/new page.
  if (user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const validation = await validateBody(request, LocationCreate)
  if (!validation.ok) return validation.response
  const body = validation.data

  const slug = toSlug(body.name)
  if (!slug) {
    return NextResponse.json({
      success: false,
      error: 'Could not derive a valid slug from the name.',
    }, { status: 400 })
  }

  const db = createServerClient()
  const { data: created, error: insertErr } = await db
    .from('locations')
    .insert({
      name: body.name,
      slug,
      address: body.address ?? null,
      phone: body.phone ?? null,
      email: body.email ?? null,
      timezone: body.timezone,
      country: body.country,
      active: body.active,
      organization_id: body.organization_id,
      monthly_contractor_budget_eur: body.monthly_contractor_budget_eur ?? null,
      invoices_inbound_slug: body.invoices_inbound_slug ?? null,
      email_inbox_reply_to: body.email_inbox_reply_to ?? null,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (insertErr) {
    if (insertErr.code === '23505' || /duplicate key|already exists|unique/i.test(insertErr.message || '')) {
      return NextResponse.json({
        success: false,
        error: `A location with slug "${slug}" already exists. Pick a different name.`,
        code: 'duplicate_slug',
      }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: insertErr.message }, { status: 400 })
  }

  try {
    await seedLocationDefaults(db, created)
  } catch (seedErr) {
    // The location row exists but its defaults don't — surface loudly
    // rather than handing back a half-provisioned location. Seeding is
    // idempotent, so retrying via support/SQL is safe; the operator
    // message names the location id for exactly that.
    return NextResponse.json({
      success: false,
      error: `Location ${created.id} was created but seeding its pipeline stages failed: ${seedErr.message}. Re-running the seed is safe.`,
      data: created,
    }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: created })
}

// POST /api/admin/organizations — Master-only route to create a new
// tenant organization. Slug is auto-derived from the name unless one
// is supplied explicitly. Slug uniqueness is enforced by the table's
// UNIQUE constraint (mig 079) — surface as a clean 409 instead of a
// raw Postgres error.
//
// W1.L1: the org's automatic host <slug>.repset.ie (a tenant_domains
// row, source='platform', mig 716) is inserted right after the org.
//
// Adding orgs is a platform-level operation: the new org has no
// locations, no members, and no operational meaning until at least
// one location is provisioned under it. The flow we expect operators
// to follow:
//   1. /admin/matrix — click "Add organization", supply name
//   2. /settings/locations/new — pick the new org from the dropdown
//      and create the first location in it
//   3. /admin/matrix again — assign users to the new location via the
//      access matrix's bulk action bar

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { toSlug } from '@/lib/slug'
import { logError } from '@/lib/log'
import { platformHostnameFor, isReservedPlatformLabel } from '@/lib/tenant-host'
import { inCodeOrCrmHostnameError } from '@/app/api/admin/tenant-domains/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  // Optional — auto-derived from name if absent.
  // max 63: the slug becomes the DNS label <slug>.repset.ie (W1.L1).
  slug: z.string().trim().min(1).max(63, 'Slug must be at most 63 characters (it becomes a DNS label)')
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug must be lowercase kebab-case (a-z, 0-9, hyphens)')
    .optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const { name, slug: providedSlug } = validation.data

  const slug = providedSlug || toSlug(name)
  if (!slug) {
    return NextResponse.json({
      success: false,
      error: 'Could not derive a valid slug from the name. Provide one explicitly.',
    }, { status: 400 })
  }

  // W1.L1: the slug becomes <slug>.repset.ie, so it must not be a label the
  // platform owns (www, crm, api, …) nor a hostname the in-code registry /
  // CRM set already answers. Checked BEFORE the org exists — an org with no
  // host is worse than no org. A derived slug (toSlug) can trip this too.
  const hostname = platformHostnameFor(slug)
  if (isReservedPlatformLabel(slug)) {
    return NextResponse.json({
      success: false,
      error: `"${slug}" is a reserved platform label (${hostname} belongs to the platform). Pick a different slug.`,
      code: 'reserved_slug',
    }, { status: 400 })
  }
  const reserved = inCodeOrCrmHostnameError(hostname)
  if (reserved) {
    return NextResponse.json({ success: false, error: `"${slug}" is reserved: ${reserved}`, code: 'reserved_slug' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: created, error: insertErr } = await db
    .from('organizations')
    .insert({ name, slug })
    .select()
    .single()

  if (insertErr) {
    // Postgres UNIQUE violation on slug → 409 with a readable error.
    // The error code from PostgREST is '23505' for unique_violation.
    if (insertErr.code === '23505' || /duplicate key|already exists|unique/i.test(insertErr.message || '')) {
      return NextResponse.json({
        success: false,
        error: `Organization with slug "${slug}" already exists. Pick a different name or supply a unique slug.`,
        code: 'duplicate_slug',
      }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: insertErr.message }, { status: 400 })
  }

  // W1.L1 — the platform host is born with the org (mig 716). The org is
  // already committed; a failed row is logged, not fatal — the migration's
  // idempotent backfill (or a re-run of it) repairs the gap.
  const { error: hostErr } = await db.from('tenant_domains').insert({
    hostname, organization_id: created.id, brand: {}, active: true, source: 'platform',
  })
  if (hostErr) {
    logError('organizations.create.platform_host', hostErr.message || 'tenant_domains insert failed', { orgId: created.id, hostname })
  }

  return NextResponse.json({ success: true, data: created })
}

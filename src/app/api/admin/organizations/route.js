// POST /api/admin/organizations — Master-only route to create a new
// tenant organization. Slug is auto-derived from the name unless one
// is supplied explicitly. Slug uniqueness is enforced by the table's
// UNIQUE constraint (mig 079) — surface as a clean 409 instead of a
// raw Postgres error.
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

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  // Optional — auto-derived from name if absent.
  slug: z.string().trim().min(1).max(100)
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

  return NextResponse.json({ success: true, data: created })
}

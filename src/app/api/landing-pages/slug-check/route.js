// PAGES.1 — GET /api/landing-pages/slug-check?slug=[&location_id=]: is this
// path free for a new page? { available, problem: 'reserved' | 'invalid' |
// 'taken' | null }. The organisation judged is the one POST would create the
// page in: with `location_id` (a one-studio page), that studio's organisation,
// for a caller holding landing_page there (else 403; a studio no organisation
// holds is 404); without it, the caller's ACTIVE organisation. A `?org=` is
// never honoured, so another tenant's slugs cannot be probed. The create and
// rename routes are the authority; this is the form's pre-check.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { activeOrganizationId } from '@/lib/org-admin'
import { hasPermissionForLocation } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'
import { slugProblem, normaliseSlug } from '@/lib/page-slug'
import { slugTakenInOrg, PageReadError } from '@/lib/landing-pages'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (status, error) => NextResponse.json({ success: false, error }, { status })
const answer = (available, problem) => NextResponse.json({ success: true, data: { available, problem } })

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return fail(401, 'Unauthorised')

  const params = new URL(request.url).searchParams
  const locationId = params.get('location_id') || null
  const db = createServerClient()
  let orgId
  if (locationId) {
    if (!uuidLike.safeParse(locationId).success) return fail(404, 'not_found')
    // The permission first: a studio the caller holds nothing at is a 403
    // whether or not it exists, so studio ids cannot be probed.
    if (!hasPermissionForLocation(user, locationId, 'landing_page')) return fail(403, 'Landing pages are not enabled for your role at this studio')
    const { data: loc, error } = await db
      .from('locations')
      .select('id, organization_id')
      .eq('id', locationId)
      .maybeSingle()
    if (error) return fail(503, 'unavailable')
    if (!loc?.organization_id) return fail(404, 'not_found')
    orgId = loc.organization_id
  } else {
    orgId = activeOrganizationId(user)
    if (!orgId) return fail(400, 'no_organisation')
  }

  const raw = params.get('slug') || ''
  const problem = slugProblem(raw)
  if (problem) return answer(false, problem)
  try {
    const taken = await slugTakenInOrg(db, { orgId, slug: normaliseSlug(raw) })
    return taken ? answer(false, 'taken') : answer(true, null)
  } catch (err) {
    if (!(err instanceof PageReadError)) throw err
    return fail(503, 'unavailable')
  }
}

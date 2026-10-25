import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKeyOrManager, orgScopeLocationIds } from '@/lib/api-auth'
import { assertLocationAccess, getUserLocationIds, hasRoleAtLocation } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'

// GET /api/stages — List pipeline stages.
//
// Accepts either a per-org API key (Bearer) OR a manager+ cookie session
// — same dual-auth pattern as /api/contacts/[id]. (The SequenceEditor
// stage-slug picker that used the cookie path went with the
// move_pipeline_stage step type, retired in FUNNEL.1; integrations hit
// this with an API key.)
export async function GET(request) {
  const auth = await requireApiKeyOrManager(request)
  if (!auth.ok) return auth.response

  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  let query = db.from('pipeline_stages').select('*').order('display_order')
  if (locationId) query = query.eq('location_id', locationId)
  // SAAS-12 — cookie/session callers: orgScopeLocationIds no-ops for
  // them (auth.orgId is null), so without an explicit filter a manager
  // could read every tenant's stages. Constrain to the caller's own
  // locations (master's set is every active location, so they still see
  // all), and reject a foreign ?location_id up front (403 — this is a
  // list route with a caller-supplied param, not a detail lookup). The
  // per-org-key path (auth.orgId set) and the legacy global-key path
  // (auth.user + auth.orgId both null) are unchanged — auth.user is null
  // for both, so this block is skipped.
  //
  // ROLESWEEP.2 — requireApiKeyOrManager's cookie branch only says "Manager+
  // somewhere". Judge MANAGER_ROLES at the asked-for location (the helper's
  // 401 body), and list only the locations where the caller holds it.
  if (auth.user) {
    if (locationId) {
      const guard = assertLocationAccess(auth.user, locationId)
      if (guard) return guard
      if (!hasRoleAtLocation(auth.user, locationId, MANAGER_ROLES)) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
      }
    }
    const managed = getUserLocationIds(auth.user).filter((id) => hasRoleAtLocation(auth.user, id, MANAGER_ROLES))
    query = query.in('location_id', managed)
  }
  // APIKEYS.3 — keyed caller (per-org key): restrict to the org's locations
  // (no-op for cookie callers only).
  const orgLocs = await orgScopeLocationIds(db, auth.orgId)
  if (orgLocs) query = query.in('location_id', orgLocs)
  const { data, error } = await query

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}

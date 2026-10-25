// INTEGONE.1 — GET /api/integrations/hub/locations/[id]. The Integrations
// hub's Manage drawer reads this when it opens, then hosts the location's full
// per-provider tab (the ones that lived only on /settings/locations/[id]).
//
// READ ONLY. It returns exactly what /settings/locations/[id]/page.js
// assembled for LocationIntegrations (src/lib/integrations-hub-location.js):
// the shaped location row (toClientLocation: no credential value crosses),
// the Xero connection, the BCA sample car, the membership-source state, the
// un1t.online presence flag and the viewer's role flags. Writes stay on the
// existing per-provider routes the hosted tabs already call.
//
// ACCESS — the same two gates as that page, judged AT THIS location:
//   1. membership (assertLocationAccess): a location the caller is not at
//      answers 404, so ids cannot be probed;
//   2. master or owner AT this location (guardMasterOrOwner). An organisation
//      admin passes where getCurrentUser gave them the synthetic owner role
//      (SAAS-4: every active studio of their org where they hold no explicit
//      membership); an explicit non-owner membership keeps its role and is
//      refused, as the page refused it. Refused answers 404 as well: a
//      detail route never tells a caller which ids exist elsewhere.
// The service-role client bypasses RLS, so these two checks ARE the boundary.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess, guardMasterOrOwner } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { loadHubLocationContext } from '@/lib/integrations-hub-location'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const locationId = params?.id
  if (!locationId) return notFound()
  if (assertLocationAccess(user, locationId)) return notFound()
  if (guardMasterOrOwner(user, locationId)) return notFound()

  const db = createServerClient()
  const { data, notFound: missing, error } = await loadHubLocationContext(db, user, locationId)
  if (error) {
    return NextResponse.json({ success: false, error: 'Could not load this location just now.' }, { status: 500 })
  }
  if (missing || !data) return notFound()

  return NextResponse.json({ success: true, data })
}

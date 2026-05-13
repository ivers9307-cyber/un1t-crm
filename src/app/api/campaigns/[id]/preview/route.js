import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { buildAudienceQueryAsync } from '@/lib/postmark'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// Shared count logic — used by both GET (saved filter) and POST
// (in-flight filter override).
async function computeCount(db, filter, locationId) {
  let query
  try {
    // Destructure { query } — see resolveTagFilters in audience-filter.js
    // for the thenable-unwrap reason.
    ;({ query } = await buildAudienceQueryAsync(db, filter, locationId))
  } catch (err) {
    return { ok: false, status: 400, error: err.message }
  }
  // CAMPAIGN.6 — preserve the contact_preferences!inner join when
  // switching to a count-only select. Plain `.select('id', ...)` here
  // would overwrite the join that buildAudienceQueryAsync set up, and
  // PostgREST would then reject the `.eq('contact_preferences.email_marketing', true)`
  // filter with "'contact_preferences' is not an embedded resource in
  // this request".
  const { count, error } = await query.select(
    'id, contact_preferences!inner(id)',
    { count: 'exact', head: true }
  )
  if (error) {
    return { ok: false, status: 400, error: error.message }
  }
  return { ok: true, count: count || 0 }
}

// GET /api/campaigns/[id]/preview — Audience count for the SAVED filter.
export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: campaign } = await db.from('campaigns')
    .select('audience_filter, location_id')
    .eq('id', params.id)
    .single()

  if (!campaign) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, campaign.location_id)
  if (guard) return guard

  const r = await computeCount(db, campaign.audience_filter, campaign.location_id)
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: r.status })
  return NextResponse.json({ success: true, audience_count: r.count })
}

// POST /api/campaigns/[id]/preview — Audience count for an IN-FLIGHT
// filter (what the operator is currently editing). Body: { filter }.
//
// CAMPAIGN.5 — the count banner used to GET this endpoint and so always
// reflected the SAVED filter, not what the operator was looking at. Even
// worse, if the saved filter was malformed (older shape, unknown field)
// the GET 400'd and the banner silently stayed as "Save the campaign to
// compute the recipient count" — even though the campaign WAS saved.
// POST lets the editor compute against the live filter so the number is
// always meaningful, and errors actually surface.
export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: campaign } = await db.from('campaigns')
    .select('audience_filter, location_id')
    .eq('id', params.id)
    .single()

  if (!campaign) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, campaign.location_id)
  if (guard) return guard

  // Use the filter the operator is editing, fall back to the saved one.
  let body = {}
  let bodyParseError = null
  try {
    body = await request.json()
  } catch (e) {
    bodyParseError = e?.message || String(e)
    body = {}
  }
  const hasInFlight = body && typeof body === 'object' && body.filter !== undefined
  const filter = hasInFlight ? body.filter : campaign.audience_filter

  // TEMP DEBUG (CAMPAIGN.7 diagnostic) — log what the server actually
  // sees so we can find why the count is 0 even though the in-flight
  // filter should match 3,205 rows. Remove once root cause is fixed.
  console.log('[preview POST debug]', JSON.stringify({
    campaignId: params.id,
    bodyParseError,
    hasInFlightFilter: hasInFlight,
    savedFilter: campaign.audience_filter,
    receivedFilter: body?.filter,
    filterUsed: filter,
    locationId: campaign.location_id,
  }))

  const r = await computeCount(db, filter, campaign.location_id)

  console.log('[preview POST debug] result', JSON.stringify({
    ok: r.ok, count: r.count, error: r.error,
  }))

  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: r.status })
  return NextResponse.json({ success: true, audience_count: r.count })
}

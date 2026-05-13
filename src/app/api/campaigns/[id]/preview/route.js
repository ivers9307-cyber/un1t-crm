import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { applyAudienceFilterAsync } from '@/lib/audience-filter'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// CAMPAIGN.9 — count without relying on PostgREST's embedded-resource
// filter. Earlier attempts used buildAudienceQueryAsync which sets up
// `.select('*, contact_preferences!inner(*)').eq('contact_preferences.email_marketing', true)`.
// That worked when the query was awaited for full rows (sendCampaign),
// but when we tried to overlay a count-only select with head:true the
// embedded filter silently lost its binding and returned 0 — no matter
// what shape (`id`, `id, contact_preferences!inner(id)`, or
// `*, contact_preferences!inner(*)`) we used.
//
// New approach: pre-fetch the contact_ids at this location that have
// email_marketing=true, then build the count query against contacts
// using `.in('id', ids)` — no embed, no PostgREST embedded-filter
// brittleness. Same final result, ~one extra round-trip.
async function computeCount(db, filter, locationId) {
  // Step 1 — collect opted-in contact_ids at this location.
  const optInIds = []
  const PAGE = 1000
  let from = 0
  while (true) {
    const { data, error } = await db
      .from('contact_preferences')
      .select('contact_id, contacts!inner(id)')
      .eq('email_marketing', true)
      .eq('contacts.location_id', locationId)
      .range(from, from + PAGE - 1)
    if (error) return { ok: false, status: 400, error: error.message }
    const chunk = (data || []).map(r => r.contact_id).filter(Boolean)
    optInIds.push(...chunk)
    if (chunk.length < PAGE) break
    from += PAGE
  }
  if (optInIds.length === 0) return { ok: true, count: 0 }

  // Step 2 — build the count query against contacts. No embed needed.
  let query = db
    .from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .in('id', optInIds)
    .not('email_status', 'in', '("bounced","complained")')

  // Step 3 — apply the user's audience filter on top.
  try {
    const result = await applyAudienceFilterAsync({ db, query, filter, locationId })
    query = result.query
  } catch (err) {
    return { ok: false, status: 400, error: err.message }
  }

  // PostgREST has a URL-length cap and very large `.in()` lists can
  // exceed it. If the opt-in list is huge, paginate the count too.
  // For Stillorgan's ~3k opt-in list this is fine in a single shot.
  const { count, error } = await query
  if (error) return { ok: false, status: 400, error: error.message }
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
  let rawBody = ''
  let bodyParseError = null
  try {
    rawBody = await request.text()
    body = rawBody ? JSON.parse(rawBody) : {}
  } catch (e) {
    bodyParseError = e?.message || String(e)
    body = {}
  }
  const hasInFlight = body && typeof body === 'object' && body.filter !== undefined
  const filter = hasInFlight ? body.filter : campaign.audience_filter

  const r = await computeCount(db, filter, campaign.location_id)
  const _debug = {
    rawBodyLen: rawBody.length,
    bodyParseError,
    hasInFlight,
    receivedFilter: body?.filter,
    savedFilter: campaign.audience_filter,
    filterUsed: filter,
  }
  if (!r.ok) return NextResponse.json({ success: false, error: r.error, _debug }, { status: r.status })
  return NextResponse.json({ success: true, audience_count: r.count, _debug })
}

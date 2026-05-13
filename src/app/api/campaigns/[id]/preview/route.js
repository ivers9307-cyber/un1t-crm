import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { buildAudienceQueryAsync } from '@/lib/postmark'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// CLASSIFY.1 — count now goes through buildAudienceQueryAsync which
// uses denormalised contacts.email_marketing instead of an inner-join
// on contact_preferences. Single-table filtering — count:'exact' +
// head:true works cleanly because there's no embedded resource for
// PostgREST to drop its filter binding on.
//
// History: CAMPAIGN.6-9 each tried to thread the embedded-resource
// filter through a count-only select and each fix exposed a new seam
// (silently zero rows, then URL-length 400s when we tried to
// pre-fetch ids and use `.in(...)`). Mig 155 makes those workarounds
// obsolete.
async function computeCount(db, filter, locationId) {
  let query
  try {
    ;({ query } = await buildAudienceQueryAsync(db, filter, locationId))
  } catch (err) {
    return { ok: false, status: 400, error: err.message }
  }
  const { count, error } = await query.select('id', { count: 'exact', head: true })
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
// reflected the SAVED filter, not what the operator was looking at.
// POST lets the editor compute against the live filter so the number
// is always meaningful, and errors actually surface.
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
  try { body = await request.json() } catch { body = {} }
  const filter = (body && typeof body === 'object' && body.filter !== undefined)
    ? body.filter
    : campaign.audience_filter

  const r = await computeCount(db, filter, campaign.location_id)
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: r.status })
  return NextResponse.json({ success: true, audience_count: r.count })
}

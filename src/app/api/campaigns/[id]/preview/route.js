import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { buildAudienceQueryAsync, consentFieldForStream } from '@/lib/postmark'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// CLASSIFY.1 — count now goes through buildAudienceQueryAsync which
// uses denormalised contacts.email_marketing instead of an inner-join
// on contact_preferences. Single-table filtering — count:'exact' +
// head:true works cleanly because there's no embedded resource for
// PostgREST to drop its filter binding on.
//
// CAMPAIGN.10 — request the count via the FIRST .select() call.
// postgrest-js's PostgrestTransformBuilder.select(columns) (the one
// you reach after applying any .eq/.not/etc filter) accepts ONLY a
// columns argument; a chained .select('id', { count, head }) silently
// drops the options. We were getting GET (not HEAD) requests with no
// Prefer:count=exact header, supabase-js parsed count as null, and
// `count || 0` always rendered 0. CAMPAIGN.6-9 each tried to fix a
// nearby symptom (the embedded-resource filter) and didn't catch this
// underlying bug because CLASSIFY.1's denormalisation came first.
async function computeCount(db, filter, locationId, consentField) {
  let query
  try {
    ;({ query } = await buildAudienceQueryAsync(db, filter, locationId, {
      columns: 'id',
      selectOpts: { count: 'exact', head: true },
      consentField,
    }))
  } catch (err) {
    return { ok: false, status: 400, error: err.message }
  }
  const { count, error } = await query
  if (error) return { ok: false, status: 400, error: error.message }
  return { ok: true, count: count || 0 }
}

// GET /api/campaigns/[id]/preview — Audience count for the SAVED filter.
export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: campaign } = await db.from('campaigns')
    .select('audience_filter, location_id, postmark_stream')
    .eq('id', params.id)
    .single()

  if (!campaign) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, campaign.location_id)
  if (guard) return guard

  const r = await computeCount(db, campaign.audience_filter, campaign.location_id, consentFieldForStream(campaign.postmark_stream))
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
export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: campaign } = await db.from('campaigns')
    .select('audience_filter, location_id, postmark_stream')
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

  const r = await computeCount(db, filter, campaign.location_id, consentFieldForStream(campaign.postmark_stream))
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: r.status })
  return NextResponse.json({ success: true, audience_count: r.count })
}

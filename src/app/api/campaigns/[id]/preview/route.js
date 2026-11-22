import { NextResponse } from 'next/server'
import { z } from 'zod'
import { buildAudienceQueryAsync, consentFieldForStream } from '@/lib/postmark'
import { assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { validateBody } from '@/lib/validate'
import { audienceFilterSchema } from '@/lib/schemas'

// All optional — omitted fields fall back to the saved campaign values
const CampaignPreviewSchema = z.object({
  filter:     audienceFilterSchema,
  email_type: z.enum(['marketing', 'utility']).optional(),
})

export const dynamic = 'force-dynamic'

const COUNT_FAILED = 'Could not count the audience'

// SECGAPS.1 — the same gate as the campaign's editor routes (loadCampaignForUser)
// and /send: email at the CAMPAIGN's studio, after membership (404).
const noEmailHere = (user, locationId) => (hasPermissionForLocation(user, locationId, 'email')
  ? null
  : NextResponse.json({ success: false, error: 'No email permission at this location' }, { status: 403 }))

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
    // InvalidAudienceFilterError is the operator's filter being wrong, in our
    // own words; anything else is logged and answered fixed (still 400).
    if (err?.name === 'InvalidAudienceFilterError' && err.message) return { ok: false, status: 400, error: err.message }
    logError('campaign-preview', 'audience build failed', { locationId, err: err?.message || String(err) })
    return { ok: false, status: 400, error: COUNT_FAILED }
  }
  const { count, error } = await query
  if (error) {
    logError('campaign-preview', 'audience count failed', { locationId, err: error })
    return { ok: false, status: 400, error: COUNT_FAILED }
  }
  return { ok: true, count: count || 0 }
}

// withAuth only signs the caller in (the same 401); the campaign (404), its
// studio (404) and email there (403) keep their order on both verbs.

// GET /api/campaigns/[id]/preview — Audience count for the SAVED filter.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const { data: campaign } = await db.from('campaigns')
    .select('audience_filter, location_id, postmark_stream')
    .eq('id', params.id)
    .single()

  if (!campaign) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, campaign.location_id)
  if (guard) return guard
  const perm = noEmailHere(user, campaign.location_id)
  if (perm) return perm

  const r = await computeCount(db, campaign.audience_filter, campaign.location_id, consentFieldForStream(campaign.postmark_stream))
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: r.status })
  return NextResponse.json({ success: true, audience_count: r.count })
})

// POST /api/campaigns/[id]/preview — Audience count for an IN-FLIGHT
// filter (what the operator is currently editing). Body: { filter }.
//
// CAMPAIGN.5 — the count banner used to GET this endpoint and so always
// reflected the SAVED filter, not what the operator was looking at.
// POST lets the editor compute against the live filter so the number
// is always meaningful, and errors actually surface.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  const { data: campaign } = await db.from('campaigns')
    .select('audience_filter, location_id, postmark_stream')
    .eq('id', params.id)
    .single()

  if (!campaign) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, campaign.location_id)
  if (guard) return guard
  const perm = noEmailHere(user, campaign.location_id)
  if (perm) return perm

  // Use the filter the operator is editing, fall back to the saved one.
  const v = await validateBody(request, CampaignPreviewSchema, { allowEmpty: true })
  if (!v.ok) return v.response
  const body = v.data
  const filter = (body && body.filter !== undefined) ? body.filter : campaign.audience_filter

  // Reflect the in-flight Marketing/Utility toggle if the editor sent it,
  // so the count updates before the campaign is saved; fall back to the
  // saved postmark_stream otherwise.
  const stream = body?.email_type === 'utility' ? 'outbound'
    : body?.email_type === 'marketing' ? 'broadcast'
    : campaign.postmark_stream
  const r = await computeCount(db, filter, campaign.location_id, consentFieldForStream(stream))
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: r.status })
  return NextResponse.json({ success: true, audience_count: r.count })
})

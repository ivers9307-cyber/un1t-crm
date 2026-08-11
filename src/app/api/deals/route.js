import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey, orgLocationIds } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, dealStatusSchema } from '@/lib/schemas'

const DealCreateSchema = z.object({
  title: z.string().min(1).max(200),
  contact_id: uuidLike,
  stage_id: uuidLike.optional(),
  stage_slug: z.string().max(100).optional(),
  status: dealStatusSchema.optional(),
  value: z.number().finite().min(0).max(10_000_000).optional(),
  location_id: uuidLike.optional(),
})

// POST /api/deals — Create a deal (replaces Pipedrive POST /v1/deals)
export async function POST(request) {
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const validation = await validateBody(request, DealCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // DEALSCOPE.2 — read the contact's own location up front. The per-org check
  // below already needed it; the stage lookup needs the same anchor on EVERY
  // path, so read it once and share it (same shape as STAGETRIG.1 on PUT).
  const { data: contact } = await db
    .from('contacts')
    .select('location_id')
    .eq('id', body.contact_id)
    .maybeSingle()

  // APIKEYS.3 — per-org key: the deal must belong to the caller's org,
  // anchored on its contact's location (plus the explicit location_id if
  // given). Legacy shared key + cookie callers (orgId null) unchanged.
  if (auth.orgId) {
    const locIds = await orgLocationIds(db, auth.orgId)
    if (!contact || !locIds.includes(contact.location_id)) {
      return NextResponse.json({ success: false, error: 'contact not in your organization' }, { status: 403 })
    }
    if (body.location_id && !locIds.includes(body.location_id)) {
      return NextResponse.json({ success: false, error: 'location not in your organization' }, { status: 403 })
    }
  }

  // Stage by slug or id — DEALSCOPE.2, both scoped to the new deal's location.
  //
  // The POST sibling of #1357. The slug lookup was `.eq('slug', …).single()`
  // with no location filter, and that is not a latent risk: every core slug
  // already exists on five locations, so the query matched five rows, PostgREST
  // errored, the error was discarded, and `stageId` stayed undefined. The deal
  // was then CREATED WITH NO STAGE and the caller got a success — worse than on
  // PUT, because a stageless deal never shows up on the board at all.
  //
  // `stage_id` had the mirror problem: taken verbatim, with nothing checking the
  // stage belonged to this deal's location. Both now resolve through the same
  // scoped lookup, and an unresolvable stage is a 400 rather than a quiet skip.
  // maybeSingle, not single: slug is unique PER LOCATION (mig 150), so once the
  // location is pinned the answer is exactly 0 or 1 rows.
  let stageId = body.stage_id
  if (body.stage_id || body.stage_slug) {
    // The deal's location is the explicit one if given, else the contact's.
    const locationId = body.location_id || contact?.location_id
    if (!locationId) {
      return NextResponse.json(
        { success: false, error: 'unknown_stage_for_location' },
        { status: 400 },
      )
    }
    const scoped = db.from('pipeline_stages').select('id').eq('location_id', locationId)
    const { data: stage } = body.stage_slug
      ? await scoped.eq('slug', body.stage_slug).maybeSingle()
      : await scoped.eq('id', body.stage_id).maybeSingle()
    if (!stage) {
      return NextResponse.json(
        { success: false, error: 'unknown_stage_for_location' },
        { status: 400 },
      )
    }
    stageId = stage.id
  }

  const { data, error } = await db.from('deals').insert({
    title: body.title,
    contact_id: body.contact_id,
    stage_id: stageId,
    status: body.status || 'open',
    value: body.value || 0,
    ...(body.location_id ? { location_id: body.location_id } : {}),
  }).select().single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}

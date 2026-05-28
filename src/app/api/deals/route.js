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

  // APIKEYS.3 — per-org key: the deal must belong to the caller's org,
  // anchored on its contact's location (plus the explicit location_id if
  // given). Legacy shared key + cookie callers (orgId null) unchanged.
  if (auth.orgId) {
    const locIds = await orgLocationIds(db, auth.orgId)
    const { data: contact } = await db.from('contacts').select('location_id').eq('id', body.contact_id).maybeSingle()
    if (!contact || !locIds.includes(contact.location_id)) {
      return NextResponse.json({ success: false, error: 'contact not in your organization' }, { status: 403 })
    }
    if (body.location_id && !locIds.includes(body.location_id)) {
      return NextResponse.json({ success: false, error: 'location not in your organization' }, { status: 403 })
    }
  }

  // Look up stage by slug if stage_slug is provided instead of stage_id
  let stageId = body.stage_id
  if (body.stage_slug && !stageId) {
    const { data: stage } = await db.from('pipeline_stages').select('id').eq('slug', body.stage_slug).single()
    stageId = stage?.id
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

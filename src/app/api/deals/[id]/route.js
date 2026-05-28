import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey, orgLocationIds } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, dealStatusSchema } from '@/lib/schemas'

const DealUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  status: dealStatusSchema.optional(),
  value: z.number().finite().min(0).max(10_000_000).optional(),
  stage_id: uuidLike.optional(),
  stage_slug: z.string().max(100).optional(),
})

// PUT /api/deals/:id — Update a deal (replaces Pipedrive PUT /v1/deals/:id)
// This triggers the deal_webhook_trigger in Postgres if stage/status changes
export async function PUT(request, props) {
  const params = await props.params;
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const { id } = params
  const validation = await validateBody(request, DealUpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // APIKEYS.3 — per-org key may only update a deal whose location is in
  // its org. 404 (not 403) so we don't confirm the id exists. Legacy +
  // cookie callers (orgId null) unchanged.
  if (auth.orgId) {
    const locIds = await orgLocationIds(db, auth.orgId)
    const { data: existing } = await db.from('deals').select('location_id').eq('id', id).maybeSingle()
    if (!existing || !locIds.includes(existing.location_id)) {
      return NextResponse.json({ success: false, error: 'not_found' }, { status: 404 })
    }
  }

  const updates = {}
  if (body.title !== undefined) updates.title = body.title
  if (body.status !== undefined) updates.status = body.status
  if (body.value !== undefined) updates.value = body.value

  // Allow stage update by slug or ID
  if (body.stage_id) updates.stage_id = body.stage_id
  if (body.stage_slug) {
    const { data: stage } = await db.from('pipeline_stages').select('id').eq('slug', body.stage_slug).single()
    if (stage) updates.stage_id = stage.id
  }

  const { data, error } = await db.from('deals').update(updates).eq('id', id).select().single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}

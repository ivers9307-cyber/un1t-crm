import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'
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
export async function PUT(request, { params }) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const { id } = params
  const validation = await validateBody(request, DealUpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

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

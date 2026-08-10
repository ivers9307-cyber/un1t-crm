import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey, orgLocationIds } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, dealStatusSchema } from '@/lib/schemas'
import { logWarn } from '@/lib/log'

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

  // STAGETRIG.1 — read the pre-update row unconditionally. It was already
  // read on the per-org path for the scope check; the stage-change trigger
  // needs the same row (contact_id + the stage we're moving FROM) on every
  // path, so read it once and share it.
  const { data: existing } = await db
    .from('deals')
    .select('location_id, contact_id, stage_id')
    .eq('id', id)
    .maybeSingle()

  // APIKEYS.3 — per-org key may only update a deal whose location is in
  // its org. 404 (not 403) so we don't confirm the id exists. Legacy +
  // cookie callers (orgId null) unchanged.
  if (auth.orgId) {
    const locIds = await orgLocationIds(db, auth.orgId)
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

  // STAGETRIG.1 — a manual stage move here writes deals.stage_id and lets
  // the mig-155 trigger re-derive contacts.pipeline_stage_slug inside the
  // database, which the sequence engine never hears about. Combined with the
  // other unwired paths that meant no pipeline_stage_change sequence with a
  // to_status other than the creation stage could fire at all.
  //
  // Only a genuine stage CHANGE counts — a PUT that renames the deal, or one
  // that re-sends the stage it is already in, enrols nobody. Slugs are
  // resolved from the ids on both sides because trigger_config speaks slugs
  // (cfg.to_status / cfg.from_status), and a caller may have sent either
  // form. Best-effort, after the write, and it never throws.
  if (existing?.contact_id && updates.stage_id && updates.stage_id !== existing.stage_id) {
    try {
      const stageIds = [existing.stage_id, updates.stage_id].filter(Boolean)
      const { data: stageRows } = await db
        .from('pipeline_stages')
        .select('id, slug')
        .in('id', stageIds)
      const slugById = new Map((stageRows || []).map((r) => [r.id, r.slug]))
      const { triggerSequencesForDealPlacement } = await import('@/lib/sequences/triggers')
      await triggerSequencesForDealPlacement(existing.contact_id, {
        action: 'move',
        from_slug: slugById.get(existing.stage_id) ?? null,
        to_slug: slugById.get(updates.stage_id) ?? null,
      })
    } catch (e) {
      logWarn('deals.PUT', `pipeline_stage_change trigger failed for deal ${id}`, { err: e })
    }
  }

  return NextResponse.json({ success: true, data })
}

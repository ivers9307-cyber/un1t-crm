import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

const StepShape = z.object({
  step_order: z.number().int().min(0).max(1000).optional(),
  delay_days: z.number().int().min(0).max(365).optional(),
  delay_hours: z.number().int().min(0).max(23).optional(),
  // Channel selector. 'wait' = no send, just the delay before the
  // following step. Defaults to 'email' for back-compat with rows
  // pre-mig 039 that didn't set step_type explicitly. Mig 087 adds
  // apply_tag / update_field / internal_task — all use `config`.
  step_type: z.enum(['email', 'whatsapp', 'sms', 'wait', 'apply_tag', 'update_field', 'internal_task', 'webhook', 'branch']).optional(),
  // Email step content
  subject: z.string().max(500).optional(),
  html_content: z.string().max(1_000_000).optional(),
  design_json: z.unknown().nullable().optional(),
  template_id: uuidLike.nullable().optional(),
  // WhatsApp step content (mig 039)
  whatsapp_template_id: uuidLike.nullable().optional(),
  whatsapp_variables: z.record(z.string()).nullable().optional(),
  whatsapp_header_media_url: z.string().url().max(2000).nullable().optional(),
  // SMS step content (mig 062). Same 1600-char hard cap as broadcasts.
  sms_body: z.string().max(1600).nullable().optional(),
  // Generic config bag for non-message step types (mig 087).
  // Schema by step_type:
  //   apply_tag      → { tag }
  //   update_field   → { field, value }
  //   internal_task  → { subject, note, assignee_user_id, due_offset_minutes }
  config: z.record(z.unknown()).nullable().optional(),
})

const StepCreateSchema = StepShape

const StepBulkUpdateSchema = z.object({
  steps: z.array(StepShape.extend({ id: uuidLike })).min(1).max(200),
})

async function loadSequenceLocation(db, sequenceId) {
  const { data } = await db.from('email_sequences')
    .select('location_id').eq('id', sequenceId).single()
  return data?.location_id
}

// GET /api/sequences/[id]/steps
export async function GET(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const seqLocation = await loadSequenceLocation(db, params.id)
  if (!seqLocation) return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  const guard = assertLocationAccess(user, seqLocation)
  if (guard) return guard

  const { data, error } = await db.from('sequence_steps')
    .select('*')
    .eq('sequence_id', params.id)
    .order('step_order', { ascending: true })

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, steps: data })
}

// POST /api/sequences/[id]/steps — add a step
export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const seqLocation = await loadSequenceLocation(db, params.id)
  if (!seqLocation) return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  const guard = assertLocationAccess(user, seqLocation)
  if (guard) return guard

  const validation = await validateBody(request, StepCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // Get next step order
  const { data: existing } = await db.from('sequence_steps')
    .select('step_order')
    .eq('sequence_id', params.id)
    .order('step_order', { ascending: false })
    .limit(1)

  const nextOrder = existing?.length ? existing[0].step_order + 1 : 1

  const stepType = body.step_type || 'email'
  const { data, error } = await db.from('sequence_steps').insert({
    sequence_id: params.id,
    step_order: body.step_order ?? nextOrder,
    delay_days: body.delay_days ?? 1,
    delay_hours: body.delay_hours ?? 0,
    step_type: stepType,
    // Email fields (only meaningful when step_type=email)
    subject: stepType === 'email' ? (body.subject || '') : '',
    html_content: stepType === 'email' ? (body.html_content || '') : '',
    design_json: stepType === 'email' ? (body.design_json || null) : null,
    template_id: stepType === 'email' ? (body.template_id || null) : null,
    // WhatsApp fields (only meaningful when step_type=whatsapp)
    whatsapp_template_id: stepType === 'whatsapp' ? (body.whatsapp_template_id || null) : null,
    whatsapp_variables: stepType === 'whatsapp' ? (body.whatsapp_variables || {}) : {},
    whatsapp_header_media_url: stepType === 'whatsapp' ? (body.whatsapp_header_media_url || null) : null,
    // SMS field (mig 062 — only meaningful when step_type=sms)
    sms_body: stepType === 'sms' ? (body.sms_body || null) : null,
    // Mig 087+ generic config bag. Mig 091 added 'branch' which
    // also uses config (predicate + then/else_step_order). Anything
    // outside this list gets {} so a stray config payload on an
    // email step doesn't leak into the runner's hot path.
    config: ['apply_tag', 'update_field', 'internal_task', 'webhook', 'branch'].includes(stepType)
      ? (body.config || {})
      : {},
  }).select().single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, step: data })
}

// PUT /api/sequences/[id]/steps — bulk update step order
export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const seqLocation = await loadSequenceLocation(db, params.id)
  if (!seqLocation) return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  const guard = assertLocationAccess(user, seqLocation)
  if (guard) return guard

  const validation = await validateBody(request, StepBulkUpdateSchema)
  if (!validation.ok) return validation.response
  const { steps } = validation.data

  for (const step of steps) {
    // Build update payload incrementally so undefined fields aren't
    // written (lets the bulk-reorder path leave content untouched).
    const updates = {
      step_order: step.step_order,
      delay_days: step.delay_days,
      delay_hours: step.delay_hours,
    }
    if (step.step_type !== undefined) updates.step_type = step.step_type
    if (step.subject !== undefined) updates.subject = step.subject
    if (step.html_content !== undefined) updates.html_content = step.html_content
    if (step.design_json !== undefined) updates.design_json = step.design_json
    if (step.template_id !== undefined) updates.template_id = step.template_id
    if (step.whatsapp_template_id !== undefined) updates.whatsapp_template_id = step.whatsapp_template_id
    if (step.whatsapp_variables !== undefined) updates.whatsapp_variables = step.whatsapp_variables
    if (step.whatsapp_header_media_url !== undefined) updates.whatsapp_header_media_url = step.whatsapp_header_media_url
    if (step.sms_body !== undefined) updates.sms_body = step.sms_body
    if (step.config !== undefined) updates.config = step.config

    await db.from('sequence_steps')
      .update(updates)
      .eq('id', step.id)
      .eq('sequence_id', params.id)  // also constrain by parent so cross-sequence writes can't sneak through
  }

  return NextResponse.json({ success: true })
}

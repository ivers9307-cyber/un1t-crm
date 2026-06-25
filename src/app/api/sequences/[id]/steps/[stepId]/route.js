import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

const StepUpdateSchema = z.object({
  step_order: z.number().int().min(0).max(1000).optional(),
  delay_days: z.number().int().min(0).max(365).optional(),
  delay_hours: z.number().int().min(0).max(23).optional(),
  // Mig 087 (apply_tag/update_field/internal_task), 089 (webhook),
  // and 091 (branch) added new step types — keep this enum in sync
  // with the create-route enum so individual-step PUTs aren't more
  // restrictive than the bulk PUT.
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
  // SMS step content (mig 062)
  sms_body: z.string().max(1600).nullable().optional(),
  // Mig 087+ generic step config bag (apply_tag, update_field,
  // internal_task, branch).
  config: z.record(z.unknown()).nullable().optional(),
})

async function loadSequenceLocation(db, sequenceId) {
  const { data } = await db.from('email_sequences')
    .select('location_id').eq('id', sequenceId).single()
  return data?.location_id
}

// PUT /api/sequences/[id]/steps/[stepId]
export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const seqLocation = await loadSequenceLocation(db, params.id)
  if (!seqLocation) return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, seqLocation)
  if (guard) return guard

  const validation = await validateBody(request, StepUpdateSchema)
  if (!validation.ok) return validation.response
  const updates = { ...validation.data }

  const { data, error } = await db.from('sequence_steps')
    .update(updates)
    .eq('id', params.stepId)
    .eq('sequence_id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, step: data })
}

// DELETE /api/sequences/[id]/steps/[stepId]
export async function DELETE(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const seqLocation = await loadSequenceLocation(db, params.id)
  if (!seqLocation) return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, seqLocation)
  if (guard) return guard

  const { error } = await db.from('sequence_steps')
    .delete()
    .eq('id', params.stepId)
    .eq('sequence_id', params.id)

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

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
  subject: z.string().max(500).optional(),
  html_content: z.string().max(1_000_000).optional(),
  design_json: z.unknown().nullable().optional(),
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
export async function GET(request, { params }) {
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
export async function POST(request, { params }) {
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

  const { data, error } = await db.from('sequence_steps').insert({
    sequence_id: params.id,
    step_order: body.step_order ?? nextOrder,
    delay_days: body.delay_days ?? 1,
    delay_hours: body.delay_hours ?? 0,
    subject: body.subject || '',
    html_content: body.html_content || '',
    design_json: body.design_json || null,
  }).select().single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, step: data })
}

// PUT /api/sequences/[id]/steps — bulk update step order
export async function PUT(request, { params }) {
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
    await db.from('sequence_steps')
      .update({
        step_order: step.step_order,
        delay_days: step.delay_days,
        delay_hours: step.delay_hours,
        subject: step.subject,
        html_content: step.html_content,
        design_json: step.design_json,
      })
      .eq('id', step.id)
      .eq('sequence_id', params.id)  // also constrain by parent so cross-sequence writes can't sneak through
  }

  return NextResponse.json({ success: true })
}

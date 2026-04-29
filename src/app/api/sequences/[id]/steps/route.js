import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'

// GET /api/sequences/[id]/steps
export async function GET(request, { params }) {
  const db = createServerClient()
  const { data, error } = await db.from('sequence_steps')
    .select('*')
    .eq('sequence_id', params.id)
    .order('step_order', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, steps: data })
}

// POST /api/sequences/[id]/steps — add a step
export async function POST(request, { params }) {
  const db = createServerClient()
  const body = await request.json()

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

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, step: data })
}

// PUT /api/sequences/[id]/steps — bulk update step order
export async function PUT(request, { params }) {
  const db = createServerClient()
  const body = await request.json()

  if (body.steps && Array.isArray(body.steps)) {
    for (const step of body.steps) {
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
    }
  }

  return NextResponse.json({ success: true })
}

import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'

// PUT /api/sequences/[id]/steps/[stepId]
export async function PUT(request, { params }) {
  const db = createServerClient()
  const body = await request.json()

  const updates = {}
  if (body.step_order !== undefined) updates.step_order = body.step_order
  if (body.delay_days !== undefined) updates.delay_days = body.delay_days
  if (body.delay_hours !== undefined) updates.delay_hours = body.delay_hours
  if (body.subject !== undefined) updates.subject = body.subject
  if (body.html_content !== undefined) updates.html_content = body.html_content
  if (body.design_json !== undefined) updates.design_json = body.design_json

  const { data, error } = await db.from('sequence_steps')
    .update(updates)
    .eq('id', params.stepId)
    .eq('sequence_id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, step: data })
}

// DELETE /api/sequences/[id]/steps/[stepId]
export async function DELETE(request, { params }) {
  const db = createServerClient()
  const { error } = await db.from('sequence_steps')
    .delete()
    .eq('id', params.stepId)
    .eq('sequence_id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'

// GET /api/sequences/[id]
export async function GET(request, { params }) {
  const db = createServerClient()
  const { data, error } = await db.from('email_sequences')
    .select('*, sequence_steps(*)')
    .eq('id', params.id)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 404 })

  // Sort steps by step_order
  if (data.sequence_steps) {
    data.sequence_steps.sort((a, b) => a.step_order - b.step_order)
  }

  return NextResponse.json({ success: true, sequence: data })
}

// PUT /api/sequences/[id]
export async function PUT(request, { params }) {
  const db = createServerClient()
  const body = await request.json()

  const updates = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.description !== undefined) updates.description = body.description
  if (body.trigger_type !== undefined) updates.trigger_type = body.trigger_type
  if (body.trigger_config !== undefined) updates.trigger_config = body.trigger_config
  if (body.status !== undefined) updates.status = body.status

  const { data, error } = await db.from('email_sequences')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, sequence: data })
}

// DELETE /api/sequences/[id]
export async function DELETE(request, { params }) {
  const db = createServerClient()
  // Delete steps first
  await db.from('sequence_steps').delete().eq('sequence_id', params.id)
  const { error } = await db.from('email_sequences').delete().eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

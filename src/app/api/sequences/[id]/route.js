import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'

const SequenceUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  // Must match what the runner (lib/sequences.js) handles AND the
  // editor offers (SequenceEditor.jsx TRIGGER_TYPES).
  trigger_type: z.enum([
    'manual', 'booking_created', 'first_booking', 'status_change',
    'event_reminder', 'tag_added',
    'race_registered', 'race_finished',
    'order_completed', 'order_failed', 'order_abandoned',
    'anniversary', 'inactivity',
  ]).optional(),
  trigger_config: z.unknown().optional(),
  goal_config: z.unknown().nullable().optional(),
  send_window: z.unknown().nullable().optional(),
  // Mig 090 (Tier 3C). See create-route comment for semantics.
  re_enrolment_cooldown_days: z.number().int().min(0).max(3650).nullable().optional(),
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
})

// GET /api/sequences/[id]
export async function GET(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data, error } = await db.from('email_sequences')
    .select('*, sequence_steps(*)')
    .eq('id', params.id)
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 404 })

  const guard = assertLocationAccess(user, data.location_id)
  if (guard) return guard

  // Sort steps by step_order
  if (data.sequence_steps) {
    data.sequence_steps.sort((a, b) => a.step_order - b.step_order)
  }

  return NextResponse.json({ success: true, sequence: data })
}

// PUT /api/sequences/[id]
export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()

  // Verify caller can write to this sequence's location
  const { data: existing } = await db.from('email_sequences')
    .select('location_id')
    .eq('id', params.id)
    .single()
  if (!existing) return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  const guard = assertLocationAccess(user, existing.location_id)
  if (guard) return guard

  const validation = await validateBody(request, SequenceUpdateSchema)
  if (!validation.ok) return validation.response
  const updates = { ...validation.data }

  const { data, error } = await db.from('email_sequences')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, sequence: data })
}

// DELETE /api/sequences/[id]
export async function DELETE(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()

  const { data: existing } = await db.from('email_sequences')
    .select('location_id')
    .eq('id', params.id)
    .single()
  if (!existing) return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  const guard = assertLocationAccess(user, existing.location_id)
  if (guard) return guard

  // Delete steps first
  await db.from('sequence_steps').delete().eq('sequence_id', params.id)
  const { error } = await db.from('email_sequences').delete().eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

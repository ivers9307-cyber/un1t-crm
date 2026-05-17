import { randomBytes } from 'node:crypto'
import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'

const SequenceUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  // Must match what the runner (lib/sequences.js) handles AND the
  // editor offers (SequenceEditor.jsx TRIGGER_TYPES). FLOW2 (mig
  // 131): added 'webhook' for inbound webhook-fired sequences.
  trigger_type: z.enum([
    'manual', 'booking_created', 'first_booking', 'status_change',
    'event_reminder', 'tag_added',
    'race_registered', 'race_finished',
    'order_completed', 'order_failed', 'order_abandoned',
    'anniversary', 'inactivity',
    'webhook',
  ]).optional(),
  trigger_config: z.unknown().optional(),
  goal_config: z.unknown().nullable().optional(),
  send_window: z.unknown().nullable().optional(),
  // Mig 090 (Tier 3C). See create-route comment for semantics.
  re_enrolment_cooldown_days: z.number().int().min(0).max(3650).nullable().optional(),
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
  // FLOW2 — operator can ROTATE the secret via the editor;
  // null clears it (token-in-URL becomes the only auth). The
  // token itself is not operator-editable (auto-managed below).
  webhook_secret: z.string().min(0).max(128).nullable().optional(),
  // FLOW2 — pseudo-action: client sets this true to ROTATE the
  // webhook_token. We never accept the new value from the
  // client; server generates fresh hex.
  rotate_webhook_token: z.boolean().optional(),
})

// GET /api/sequences/[id]
export async function GET(request, props) {
  const params = await props.params;
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
export async function PUT(request, props) {
  const params = await props.params;
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

  // FLOW2 webhook handling:
  // 1. Auto-generate webhook_token when the operator switches an
  //    existing sequence TO trigger_type='webhook' for the first
  //    time. We need to load the current row to know whether a
  //    token already exists.
  // 2. Honour explicit rotate_webhook_token=true from the client
  //    by generating a fresh token (operator clicked Regenerate).
  // 3. Strip rotate_webhook_token before passing updates to the
  //    DB — it's a pseudo-action, not a column.
  const wantsRotate = updates.rotate_webhook_token === true
  delete updates.rotate_webhook_token
  if (updates.trigger_type === 'webhook' || wantsRotate) {
    const { data: cur } = await db.from('email_sequences')
      .select('webhook_token, trigger_type')
      .eq('id', params.id)
      .single()
    const switchingToWebhook = updates.trigger_type === 'webhook' && cur?.trigger_type !== 'webhook'
    const needsToken = wantsRotate || (switchingToWebhook && !cur?.webhook_token)
    if (needsToken) updates.webhook_token = randomBytes(16).toString('hex')
  }

  const { data, error } = await db.from('email_sequences')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, sequence: data })
}

// DELETE /api/sequences/[id]
export async function DELETE(request, props) {
  const params = await props.params;
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

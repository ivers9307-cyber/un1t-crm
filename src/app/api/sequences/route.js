import { randomBytes } from 'node:crypto'
import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess, getUserLocationIds } from '@/lib/auth'
import { canBuildSequencesAt, canBuildSequencesSomewhere, sequencePermissionRequired } from '@/lib/sequence-access'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

const SequenceCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  // Must match what the runner (lib/sequences.js) handles AND the
  // editor offers (SequenceEditor.jsx TRIGGER_TYPES). The previous
  // enum had stale draft values ('on_signup' / 'on_status_change')
  // that would silently reject legitimate sequences from the editor.
  // FLOW2 (mig 131): added 'webhook' for inbound webhook-fired
  // sequences. Token + optional secret on email_sequences.
  trigger_type: z.enum([
    'manual', 'audience_match', 'booking_created', 'first_booking', 'status_change',
    'event_reminder', 'tag_added',
    'race_registered', 'race_finished',
    'order_completed', 'order_failed', 'order_abandoned',
    'anniversary', 'inactivity',
    // pipeline_stage_change is the live name (CLASSIFY.2 renamed status_change,
    // kept as a legacy alias until the classic editor retires). segment_* and
    // achievement_unlocked were missing — the runner (triggers.js) fires them
    // but the API rejected them. Now aligned to the engine's trigger vocabulary.
    'pipeline_stage_change', 'segment_added', 'segment_removed', 'membership_state_change', 'achievement_unlocked',
    'webhook', 'contact_created',
  ]).optional(),
  trigger_config: z.unknown().optional(),
  goal_config: z.unknown().nullable().optional(),
  send_window: z.unknown().nullable().optional(),
  // Mig 090 (Tier 3C): NULL/0 = single-enrolment-per-contact (default).
  // > 0 = same contact may re-enrol after their previous run ended that
  // many days ago. Capped at ~10 years to avoid silly inputs.
  re_enrolment_cooldown_days: z.number().int().min(0).max(3650).nullable().optional(),
  location_id: uuidLike.optional(),
})

// SEQROUTEGATE.1 — named columns. Never webhook_token / webhook_secret: the
// builder's settings panel gets those from the /automations/[id] page's own
// read. The one list caller (SequencePicker) reads id, name, description,
// status and trigger_type.
const SEQUENCE_LIST_COLUMNS = 'id, location_id, name, description, status, trigger_type, total_enrolled, created_at, updated_at, sequence_steps(count)'

// GET /api/sequences — list sequences
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  // SEQROUTEGATE.1 — the builder's rule (email or whatsapp), judged at the
  // location listed; a coarse pre-check first.
  if (!canBuildSequencesSomewhere(user)) return sequencePermissionRequired()

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (locationId && !canBuildSequencesAt(user, locationId)) return sequencePermissionRequired()

  const db = createServerClient()
  let query = db.from('email_sequences')
    .select(SEQUENCE_LIST_COLUMNS)
    .order('created_at', { ascending: false })

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    // Only the member studios where the caller may build sequences.
    const userLocationIds = getUserLocationIds(user).filter((id) => canBuildSequencesAt(user, id))
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, sequences: [] })
    query = query.in('location_id', userLocationIds)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, sequences: data })
}

// POST /api/sequences — create sequence
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!canBuildSequencesSomewhere(user)) return sequencePermissionRequired()

  const validation = await validateBody(request, SequenceCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const locationId = body.location_id || user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'location_id required' }, { status: 400 })
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!canBuildSequencesAt(user, locationId)) return sequencePermissionRequired()

  const db = createServerClient()
  // FLOW2 — auto-generate a webhook_token whenever the sequence
  // is created with trigger_type='webhook'. Operator can rotate
  // it later via the editor's "Regenerate" button.
  const triggerType = body.trigger_type || 'manual'
  const webhookToken = triggerType === 'webhook' ? randomBytes(16).toString('hex') : null
  const { data, error } = await db.from('email_sequences').insert({
    name: body.name || 'Untitled Sequence',
    description: body.description || null,
    trigger_type: triggerType,
    trigger_config: body.trigger_config || {},
    goal_config: body.goal_config ?? null,
    send_window: body.send_window ?? null,
    re_enrolment_cooldown_days: body.re_enrolment_cooldown_days ?? null,
    webhook_token: webhookToken,
    status: 'draft',
    location_id: locationId,
    created_by: user.id,
  }).select().single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, sequence: data })
}

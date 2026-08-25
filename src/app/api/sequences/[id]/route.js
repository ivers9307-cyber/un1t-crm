import { randomBytes } from 'node:crypto'
import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { validateAudienceFilter, InvalidAudienceFilterError } from '@/lib/audience-filter'

const SequenceUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  // Must match what the runner (lib/sequences.js) handles AND the
  // editor offers (SequenceEditor.jsx TRIGGER_TYPES). FLOW2 (mig
  // 131): added 'webhook' for inbound webhook-fired sequences.
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
  // The sequence-level audience gate (contactMatchesSequenceAudience). Same
  // { logic, filters } shape as campaigns/segments. PILLAR2.0b made it editable
  // in the builder so any sequence can be gated by a contact attribute (the
  // "trigger on an attribute, not just a saved segment" gap).
  audience_filter: z.unknown().nullable().optional(),
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

  const guard = assertLocationAccessOr404(user, data.location_id)
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

  // Verify caller can write to this sequence's location. trigger_type /
  // trigger_config / status feed the activation guard below (effective
  // values = request merged over the stored row).
  const { data: existing } = await db.from('email_sequences')
    .select('location_id, trigger_type, trigger_config, status')
    .eq('id', params.id)
    .single()
  if (!existing) return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, existing.location_id)
  if (guard) return guard

  const validation = await validateBody(request, SequenceUpdateSchema)
  if (!validation.ok) return validation.response
  const updates = { ...validation.data }

  // COMMSFIX.B.7 — reject an invalid audience_filter at save time. A bad
  // filter used to save cleanly, then contactMatchesSequenceAudience failed
  // closed at every trigger evaluation — the sequence silently enrolled
  // NOBODY with only a server log line as evidence. null clears the gate.
  if (updates.audience_filter != null) {
    try {
      validateAudienceFilter(updates.audience_filter)
    } catch (e) {
      if (e instanceof InvalidAudienceFilterError) {
        return NextResponse.json({ success: false, error: e.message }, { status: 400 })
      }
      throw e
    }
  }

  // AUDIENCEMATCH.1 — editing the audience REVOKES the enrolment confirmation.
  //
  // audience_seeded_at records that a human saw a specific headcount and said
  // "enrol those people". Widen the filter afterwards and that consent no
  // longer covers who it would now sweep in — the number they agreed to is not
  // the number that would be enrolled. Clearing the stamp makes them re-confirm
  // against the new figure; it does NOT un-enrol anyone already in, which is
  // impossible anyway (full unique index on sequence_enrollments).
  //
  // Deliberately fires on ANY audience_filter write, including a narrowing or a
  // no-op re-save. Deciding whether an edit widened the set means comparing two
  // filters against live data, which is exactly the judgement the operator is
  // being asked to make. Re-confirming a narrowed audience costs one click;
  // getting the comparison wrong costs an unintended mass-enrol.
  if (Object.hasOwn(updates, 'audience_filter')) {
    updates.audience_seeded_at = null
    updates.audience_seeded_by = null
    updates.audience_seed_count = null
  }

  // COMMSFIX.E.5 — refuse to ACTIVATE a sequence that can never fire.
  // segment_added/segment_removed triggers require trigger_config.
  // segment_id (triggers.js skips any sequence without it), yet two
  // dunning sequences sat in the DB with an empty config, so activating
  // them would have enrolled nobody with no signal to the operator. Gate
  // on EFFECTIVE values so a status-only PUT on a stored segment sequence
  // is caught too. Drafts stay saveable without a segment — only
  // activation is gated.
  //
  // Sibling of the B.7 check above: both refuse to persist a sequence that
  // silently enrols nobody, one via a broken audience, one via a trigger
  // that can never match.
  const effTriggerType = updates.trigger_type ?? existing.trigger_type
  const effStatus = updates.status ?? existing.status
  if (effStatus === 'active' && ['segment_added', 'segment_removed'].includes(effTriggerType)) {
    const effTriggerConfig = updates.trigger_config !== undefined ? updates.trigger_config : existing.trigger_config
    const segmentId = (effTriggerConfig && typeof effTriggerConfig === 'object') ? effTriggerConfig.segment_id : null
    if (!segmentId) {
      return NextResponse.json({
        success: false,
        error: 'This sequence fires when contacts enter or leave a segment, but no segment is selected — it would never enrol anyone. Pick a segment in the trigger settings, then activate.',
      }, { status: 400 })
    }
  }

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
  const guard = assertLocationAccessOr404(user, existing.location_id)
  if (guard) return guard

  // Delete steps first
  await db.from('sequence_steps').delete().eq('sequence_id', params.id)
  const { error } = await db.from('email_sequences').delete().eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

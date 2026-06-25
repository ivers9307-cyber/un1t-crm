// POST /api/sequences/[id]/clone
//
// Clones an existing sequence (and all its steps) into a fresh
// draft so the operator can dup-and-tweak instead of starting
// over. Pairs with the Flow templates gallery: templates seed
// new sequences from canned recipes, clone seeds new sequences
// from the operator's already-customised ones.
//
// The clone always starts as draft (regardless of source status)
// and gets a "Copy of …" name prefix so it's visually distinct in
// the list. Trigger / config / goal / send window / audience
// filter / re-enrolment cooldown all carry over verbatim.

import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'email')) {
    return NextResponse.json({ success: false, error: 'Email permission required' }, { status: 403 })
  }

  const sourceId = params?.id
  if (!sourceId || !uuidLike.safeParse(sourceId).success) {
    return NextResponse.json({ success: false, error: 'Invalid sequence id' }, { status: 400 })
  }

  const db = createServerClient()

  // 1. Load the source sequence + its steps. select() with the
  // nested sequence_steps relation gives us both in a single
  // round-trip.
  const { data: source, error: srcErr } = await db
    .from('email_sequences')
    .select('*, sequence_steps(*)')
    .eq('id', sourceId)
    .single()
  if (srcErr || !source) {
    return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  }

  // Membership check — operator must be assigned to the source's
  // location. Master bypasses via assertLocationAccessOr404.
  const guard = assertLocationAccessOr404(user, source.location_id)
  if (guard) return guard

  // 2. Insert the new sequence as a draft. Pull every config /
  // metadata column from the source so the clone is a true copy
  // minus the runtime state (status, total_enrolled, timestamps).
  // FLOW2 — webhook_token + webhook_secret are NEVER copied: a
  // clone needs its own URL (otherwise two sequences would share
  // a token, which is a unique-index violation anyway), and the
  // secret is operator-managed per-sequence. Token is freshly
  // minted here so the clone is immediately usable.
  const webhookToken = source.trigger_type === 'webhook' ? randomBytes(16).toString('hex') : null
  const { data: cloned, error: cloneErr } = await db
    .from('email_sequences')
    .insert({
      name: `Copy of ${source.name}`,
      description: source.description || null,
      trigger_type: source.trigger_type,
      trigger_config: source.trigger_config || {},
      goal_config: source.goal_config || null,
      send_window: source.send_window || null,
      audience_filter: source.audience_filter || null,
      re_enrolment_cooldown_days: source.re_enrolment_cooldown_days ?? null,
      webhook_token: webhookToken,
      status: 'draft',
      location_id: source.location_id,
      created_by: user.id,
    })
    .select()
    .single()
  if (cloneErr) {
    return NextResponse.json({ success: false, error: cloneErr.message }, { status: 500 })
  }

  // 3. Duplicate the steps in order. Strip the source's id +
  // sequence_id (Postgres assigns fresh ids on insert) plus the
  // created_at / updated_at timestamps the DB default will set.
  const steps = (source.sequence_steps || []).slice().sort((a, b) => a.step_order - b.step_order)
  if (steps.length > 0) {
    const stepRows = steps.map((s, i) => ({
      sequence_id: cloned.id,
      step_order: i + 1,
      delay_days: s.delay_days ?? 0,
      delay_hours: s.delay_hours ?? 0,
      delay_minutes: s.delay_minutes ?? 0,
      step_type: s.step_type,
      subject: s.subject || '',
      html_content: s.html_content || '',
      template_id: s.template_id || null,
      whatsapp_template_id: s.whatsapp_template_id || null,
      whatsapp_variables: s.whatsapp_variables || {},
      sms_body: s.sms_body || null,
      config: s.config || {},
    }))
    const { error: stepsErr } = await db.from('sequence_steps').insert(stepRows)
    if (stepsErr) {
      // Roll the cloned husk back so we don't leave an empty
      // shell — same pattern the from-template route uses.
      await db.from('email_sequences').delete().eq('id', cloned.id)
      return NextResponse.json({
        success: false,
        error: `Steps failed: ${stepsErr.message}`,
      }, { status: 500 })
    }
  }

  return NextResponse.json({
    success: true,
    data: { sequence_id: cloned.id, name: cloned.name, source_sequence_id: source.id },
  })
}

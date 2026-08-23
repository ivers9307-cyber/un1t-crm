// POST /api/sequences/from-template
//
// Tier 3B — clone a template recipe into a fresh draft sequence.
// Operator can then rename/edit/activate it like any other.
//
// Body: { template_id: string, location_id?: uuid }
//
// Always creates the new sequence with status='draft' and the
// operator's userId as created_by. location_id defaults to
// the operator's active location.

import { NextResponse } from 'next/server'
import { resolveWhatsappTemplateIds } from '@/lib/sequences/template-install'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { getTemplate } from '@/lib/sequence-templates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({
  template_id: z.string().min(1).max(100),
  location_id: uuidLike.optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const tpl = getTemplate(body.template_id)
  if (!tpl) {
    return NextResponse.json({
      success: false,
      error: `Template "${body.template_id}" not found`,
    }, { status: 404 })
  }

  const locationId = body.location_id || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!locationId) {
    return NextResponse.json({
      success: false,
      error: 'No active location — cannot create sequence',
    }, { status: 400 })
  }

  const db = createServerClient()
  // FLOW2 — auto-generate webhook_token when the template uses
  // the webhook trigger so the operator gets a working URL the
  // moment they install (no need to save once first to mint one).
  const webhookToken = tpl.trigger_type === 'webhook' ? randomBytes(16).toString('hex') : null
  // 1. Insert the sequence as a draft.
  const { data: seq, error: seqErr } = await db
    .from('email_sequences')
    .insert({
      name: tpl.name,
      description: tpl.description || null,
      trigger_type: tpl.trigger_type,
      trigger_config: tpl.trigger_config || {},
      goal_config: tpl.goal_config || null,
      send_window: tpl.send_window || null,
      audience_filter: tpl.audience_filter || null,
      re_enrolment_cooldown_days: tpl.re_enrolment_cooldown_days ?? null,
      webhook_token: webhookToken,
      status: 'draft',
      location_id: locationId,
      created_by: user.id,
    })
    .select()
    .single()
  if (seqErr) {
    return NextResponse.json({ success: false, error: seqErr.message }, { status: 500 })
  }

  // 2. Insert each step in order.
  // DUNNING.6 — resolve WhatsApp steps named by template (gallery templates
  // can't carry a location's uuid) against this location's approved templates.
  let steps = tpl.steps || []
  if (steps.some((st) => st?.step_type === 'whatsapp' && st.whatsapp_template_name)) {
    const { data: waRows } = await db
      .from('whatsapp_templates')
      .select('id, name, status')
      .eq('location_id', locationId)
    steps = resolveWhatsappTemplateIds(steps, waRows || [])
  }
  const stepRows = steps.map((s, i) => ({
    sequence_id: seq.id,
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
  if (stepRows.length > 0) {
    const { error: stepsErr } = await db.from('sequence_steps').insert(stepRows)
    if (stepsErr) {
      // Roll the sequence back so we don't leave an empty husk.
      await db.from('email_sequences').delete().eq('id', seq.id)
      return NextResponse.json({
        success: false,
        error: `Steps failed: ${stepsErr.message}`,
      }, { status: 500 })
    }
  }

  return NextResponse.json({
    success: true,
    data: { sequence_id: seq.id, template_id: tpl.id, name: seq.name },
  })
}

// GET /api/sequences/from-template — list available templates for
// the picker UI. Pure metadata, no DB hit.
export async function GET() {
  const { SEQUENCE_TEMPLATES } = await import('@/lib/sequence-templates')
  return NextResponse.json({
    success: true,
    data: SEQUENCE_TEMPLATES.map((t) => ({
      id: t.id,
      category: t.category,
      name: t.name,
      description: t.description,
      trigger_type: t.trigger_type,
      step_count: (t.steps || []).length,
    })),
  })
}

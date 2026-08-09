import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey, assertRowInOrg } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, email, audienceFilterSchema } from '@/lib/schemas'
import { validateAudienceFilter, InvalidAudienceFilterError } from '@/lib/audience-filter'

const CampaignUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  subject: z.string().max(500).optional(),
  preview_text: z.string().max(500).nullable().optional(),
  from_name: z.string().max(100).nullable().optional(),
  from_email: email.nullable().optional(),
  reply_to: email.nullable().optional(),
  design_json: z.unknown().nullable().optional(),
  html_content: z.string().max(1_000_000).nullable().optional(),
  audience_filter: audienceFilterSchema,
  scheduled_at: z.string().datetime().nullable().optional(),
  template_id: uuidLike.nullable().optional(),
  // Only the editable states may be set through this generic update —
  // 'sending'/'sent'/'cancelled' are owned by the send cron and the
  // dedicated send/cancel endpoints. Letting a client force them here could
  // mark a campaign 'sent' without sending, or reset a 'sending' one to
  // 'draft' (→ re-populate → double-send).
  status: z.enum(['draft', 'scheduled']).optional(),
  // API speaks email_type (marketing/utility); mapped to postmark_stream below.
  email_type: z.enum(['marketing', 'utility']).optional(),
  // CAMPAIGN-AB (mig 398) — optional subject-line A/B test. Setting
  // ab_subject_b turns the test on (NULL turns it off); bounds mirror
  // the DB CHECKs. Only editable while draft/scheduled (guard below),
  // so the send state machine's ab_* stamps can never be raced.
  ab_subject_b: z.string().min(1).max(500).nullable().optional(),
  ab_test_pct: z.number().int().min(5).max(50).nullable().optional(),
  ab_wait_hours: z.number().int().min(1).max(24).nullable().optional(),
})

// GET /api/campaigns/[id] — Get campaign with metrics
export async function GET(request, props) {
  const params = await props.params;
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const db = createServerClient()
  const scopeErr = await assertRowInOrg({ db, orgId: auth.orgId, table: 'campaigns', id: params.id })
  if (scopeErr) return scopeErr
  const { data, error } = await db.from('campaigns')
    .select('*')
    .eq('id', params.id)
    .single()

  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }

  return NextResponse.json({ success: true, data })
}

// PUT /api/campaigns/[id] — Update campaign (only drafts)
export async function PUT(request, props) {
  const params = await props.params;
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const validation = await validateBody(request, CampaignUpdateSchema)
  if (!validation.ok) return validation.response
  const updates = { ...validation.data }

  // FILTER-P1.5 — reject an audience filter that can never resolve at SAVE
  // time, not when the send tries to populate. Mirrors COMMSFIX.B.7, which
  // closed this on email-draft, the SMS/WA broadcast creates and the
  // sequences PUT and missed these routes.
  try {
    validateAudienceFilter(updates.audience_filter)
  } catch (e) {
    if (e instanceof InvalidAudienceFilterError) {
      return NextResponse.json({ success: false, error: e.message }, { status: 400 })
    }
    throw e
  }
  // API speaks email_type (marketing/utility); the column is postmark_stream.
  if (updates.email_type !== undefined) {
    updates.postmark_stream = updates.email_type === 'utility' ? 'outbound' : 'broadcast'
    delete updates.email_type
  }
  const db = createServerClient()
  const scopeErr = await assertRowInOrg({ db, orgId: auth.orgId, table: 'campaigns', id: params.id })
  if (scopeErr) return scopeErr

  // Only a draft or a (not-yet-due) scheduled campaign may be edited. Once
  // it's queued / sending / sent / cancelled the send state machine owns it —
  // an edit here would race the cron or rewrite an already-sent record.
  const { data: current } = await db.from('campaigns').select('status').eq('id', params.id).single()
  if (current && !['draft', 'scheduled'].includes(current.status)) {
    return NextResponse.json({
      success: false,
      error: `Campaign is '${current.status}' — only draft or scheduled campaigns can be edited.`,
    }, { status: 409 })
  }

  const { data, error } = await db.from('campaigns')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}

// DELETE /api/campaigns/[id]
export async function DELETE(request, props) {
  const params = await props.params;
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const db = createServerClient()
  const scopeErr = await assertRowInOrg({ db, orgId: auth.orgId, table: 'campaigns', id: params.id })
  if (scopeErr) return scopeErr
  const { error } = await db.from('campaigns').delete().eq('id', params.id)

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true })
}

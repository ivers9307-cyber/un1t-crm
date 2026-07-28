// GET   /api/host/emails/[id] — one of the host's own campaigns, full body
//       (body_html + design_json + audience) so a draft round-trips into the
//       visual composer for editing (HOST-EMAIL.4).
// PATCH /api/host/emails/[id] — update a DRAFT campaign (subject / body /
//       design / audience). CAS on status='draft' so a campaign that started
//       sending can never be rewritten mid-flight. Same validation as create.
// Tenancy: every query .eq('host_id', session.host.id) → 404, not 403.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { designJsonTooBig, assertAudienceEventOwned } from '@/lib/host-campaign-draft'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CampaignUpdateSchema = z.object({
  subject: z.string().min(1, 'Subject is required').max(200, 'Subject is too long (max 200 characters)'),
  body: z.string().min(1, 'Body is required').max(300000, 'Body is too long'),
  design_json: z.unknown().optional().nullable(),
  audience_event_id: z.string().regex(UUIDISH).optional().nullable(),
  email_type: z.enum(['marketing', 'utility']).optional(),
})

export async function GET(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data, error } = await db
    .from('host_campaigns')
    .select('id, subject, body_html, design_json, audience_event_id, email_type, status, recipient_count, sent_count, created_at, sent_at')
    .eq('id', params.id)
    .eq('host_id', session.host.id)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true, data })
}

export async function PATCH(request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let body
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = CampaignUpdateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Invalid email', issues: parsed.error.issues }, { status: 400 })
  }
  if (designJsonTooBig(parsed.data.design_json)) {
    return NextResponse.json({ success: false, error: 'Design is too large.' }, { status: 400 })
  }

  const db = createServerClient()
  const audienceErr = await assertAudienceEventOwned(db, session.host.id, parsed.data.audience_event_id)
  if (audienceErr) return NextResponse.json({ success: false, error: audienceErr }, { status: 404 })

  // CAS on draft — a concurrent send flipped it → 0 rows → 409.
  const { data: updated, error } = await db
    .from('host_campaigns')
    .update({
      subject: parsed.data.subject,
      body_html: parsed.data.body,
      design_json: parsed.data.design_json ?? null,
      audience_event_id: parsed.data.audience_event_id || null,
      email_type: parsed.data.email_type === 'utility' ? 'utility' : 'marketing',
    })
    .eq('id', params.id)
    .eq('host_id', session.host.id)
    .eq('status', 'draft')
    .select('id')
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  if (!updated || updated.length === 0) {
    return NextResponse.json({ success: false, error: 'This email is no longer a draft.' }, { status: 409 })
  }
  return NextResponse.json({ success: true, data: { id: params.id } })
}

// POST /api/host/emails/[id]/duplicate — HOST-EMAILS.2. A new draft copied
// from any of the host's campaigns: content, design, audience and type;
// never the schedule, counts or timestamps. Subject "Copy of …" capped at
// 200 (copySubject, src/lib/host-campaign-draft.js — route modules may only
// export handlers, so the helper lives there).

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { HOST_CAMPAIGN_LIST_COLUMNS, copySubject } from '@/lib/host-campaign-draft'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()

  // Own campaign or 404 — .eq('host_id') is the tenancy boundary, and any
  // status may be duplicated (a sent campaign is a common source).
  const { data: source, error: readErr } = await db
    .from('host_campaigns')
    .select('id, subject, body_html, design_json, audience_kind, audience_event_id, audience_campaign_id, email_type')
    .eq('id', params.id)
    .eq('host_id', session.host.id)
    .maybeSingle()
  if (readErr) return NextResponse.json({ success: false, error: readErr.message }, { status: 500 })
  if (!source) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const { data: row, error: insertErr } = await db
    .from('host_campaigns')
    .insert({
      host_id: session.host.id,
      subject: copySubject(source.subject),
      body_html: source.body_html,
      design_json: source.design_json,
      audience_kind: source.audience_kind,
      audience_event_id: source.audience_event_id,
      audience_campaign_id: source.audience_campaign_id,
      email_type: source.email_type,
      status: 'draft',
    })
    .select(HOST_CAMPAIGN_LIST_COLUMNS)
    .single()
  if (insertErr) return NextResponse.json({ success: false, error: insertErr.message }, { status: 500 })
  return NextResponse.json({ success: true, data: row })
}

// POST /api/host/emails/[id]/reminder-draft — HOST-EMAILS.2. A new draft
// "Reminder: <subject>" whose audience is the parent's delivered-but-never-
// opened-or-clicked contacts (audience_kind 'non_openers', resolved at send
// time by resolveHostRecipients). The parent must be a SENT campaign — a
// reminder for a draft or scheduled email makes no sense (nobody has seen
// it yet to not-open it).

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

  const { data: parent, error: readErr } = await db
    .from('host_campaigns')
    .select('id, subject, body_html, design_json, email_type, status')
    .eq('id', params.id)
    .eq('host_id', session.host.id)
    .maybeSingle()
  if (readErr) return NextResponse.json({ success: false, error: readErr.message }, { status: 500 })
  if (!parent) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (parent.status !== 'sent') {
    return NextResponse.json({ success: false, error: 'Only a sent email can have a reminder.' }, { status: 409 })
  }

  const { data: row, error: insertErr } = await db
    .from('host_campaigns')
    .insert({
      host_id: session.host.id,
      subject: copySubject(parent.subject, 'Reminder: '),
      body_html: parent.body_html,
      design_json: parent.design_json,
      audience_kind: 'non_openers',
      audience_event_id: null,
      audience_campaign_id: parent.id,
      email_type: parent.email_type,
      status: 'draft',
    })
    .select(HOST_CAMPAIGN_LIST_COLUMNS)
    .single()
  if (insertErr) return NextResponse.json({ success: false, error: insertErr.message }, { status: 500 })
  return NextResponse.json({ success: true, data: row })
}

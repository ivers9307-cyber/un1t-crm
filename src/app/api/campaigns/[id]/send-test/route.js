// POST /api/campaigns/[id]/send-test
//
// CAMPAIGN.1 — sends ONE rendered copy of a draft campaign to a
// specified recipient (defaults to the operator's own email) so the
// operator can preview it in their actual inbox before sending the
// real campaign to the audience.
//
// Differences vs the real send:
//   - Single recipient (the operator), no audience query
//   - Subject is prefixed with "[TEST] " so it's obvious in the inbox
//   - Personalisation tokens render against the operator's own
//     contact record if found, else fake sample values
//   - No campaign_recipients / email_sends rows written — this isn't
//     a "real" send and shouldn't pollute campaign metrics
//   - Stream stays 'broadcast' so the rendering and footer match the
//     real send EXACTLY (different stream = different unsubscribe
//     handling, different from address, etc.)

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { sendEmail, applyMergeTags } from '@/lib/postmark'
import { getAppUrl } from '@/lib/app-url'
import { ADMIN_ROLES } from '@/lib/schemas'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({
  // Defaults to the current user's email server-side if omitted.
  to: z.string().email().optional(),
})

export async function POST(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  // Same gate as the real send — anyone who can send a campaign
  // can also send a test of it.
  if (!user.isMaster && !ADMIN_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Admin only' }, { status: 403 })
  }

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response

  const recipient = (validation.data.to || user.email || '').trim().toLowerCase()
  if (!recipient || !recipient.includes('@')) {
    return NextResponse.json({
      success: false,
      error: 'No recipient email — pass `to` in the body or set an email on your profile.',
    }, { status: 400 })
  }

  const db = createServerClient()
  const { data: campaign, error: campErr } = await db
    .from('campaigns')
    .select('id, name, subject, html_content, from_name, from_email, reply_to, location_id, locations(name)')
    .eq('id', params.id)
    .single()
  if (campErr || !campaign) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }
  // Mirror the real send: a cross-location admin must not be able to
  // fire a real test email for another location's campaign. Service-role
  // bypasses RLS, so this app-layer check is the only scoping.
  const guard = assertLocationAccess(user, campaign.location_id)
  if (guard) return guard
  if (!campaign.subject || !campaign.html_content) {
    return NextResponse.json({
      success: false,
      error: 'Campaign needs a subject and body before you can test-send it.',
    }, { status: 400 })
  }

  // Pull the operator's own contact (matched by email at the
  // campaign's location) so personalisation renders with real data.
  // Fallback to fake values when no contact exists — better than
  // showing literal "{{first_name}}" in the test email.
  let sampleContact = null
  if (user.email) {
    const { data } = await db
      .from('contacts')
      .select('id, name, first_name, last_name, email, phone, pipeline_stage_slug')
      .eq('email', user.email.toLowerCase())
      .eq('location_id', campaign.location_id)
      .maybeSingle()
    sampleContact = data || null
  }
  const renderContact = sampleContact || {
    id:         'test-' + Date.now(),
    name:       user.full_name || 'Test Recipient',
    first_name: (user.full_name || 'Test').split(/\s+/)[0],
    last_name:  (user.full_name || 'Recipient').split(/\s+/).slice(1).join(' ') || 'Recipient',
    email:      recipient,
    phone:      null,
    pipeline_stage_slug: 'new_lead',
  }

  // Mirror the real send's URL building so the unsubscribe + preference
  // links in the test email are real and clickable. Useful for verifying
  // the footer renders correctly.
  let baseUrl
  try { baseUrl = getAppUrl() } catch { baseUrl = '' }
  const unsubscribeUrl = `${baseUrl}/unsubscribe/test-token`
  const preferenceUrl  = `${baseUrl}/preferences/test-token`

  const html = applyMergeTags(campaign.html_content, renderContact, {
    location_name: campaign.locations?.name || '',
    unsubscribe_url: unsubscribeUrl,
    preference_url: preferenceUrl,
  })
  const subject = '[TEST] ' + applyMergeTags(campaign.subject, renderContact)

  const fromHeader = campaign.from_name
    ? `${campaign.from_name} <${campaign.from_email || process.env.POSTMARK_FROM_EMAIL}>`
    : undefined

  try {
    const result = await sendEmail({
      to: recipient,
      subject,
      htmlBody: html,
      from: fromHeader,
      replyTo: campaign.reply_to,
      stream: 'broadcast',
      tag: `campaign-test-${params.id}`,
      metadata: {
        campaign_id: params.id,
        test_send: '1',
        sent_by: user.id || '',
      },
      unsubscribeUrl,
    })
    return NextResponse.json({
      success: true,
      to: recipient,
      message_id: result?.messageId || null,
      using_real_contact: !!sampleContact,
      message: sampleContact
        ? `Sent to ${recipient} with personalisation from your contact record.`
        : `Sent to ${recipient} with sample personalisation (no matching contact found at this location).`,
    })
  } catch (e) {
    return NextResponse.json({
      success: false,
      error: `Test send failed: ${e?.message || e}`,
    }, { status: 502 })
  }
}

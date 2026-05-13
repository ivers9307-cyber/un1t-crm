// CAMPAIGN.11 recovery endpoint — resend the campaign to recipients
// who matched the audience filter but never made it into
// campaign_recipients because of the 1,000-row select cap fixed in
// CAMPAIGN.11. One-off use; delete this file after the operator has
// successfully run it.
//
// Hit with:
//   POST /api/admin/campaigns/<campaign-id>/resend-missing
//
// Auth: master/owner only. Idempotent — repeat calls skip contacts
// already in campaign_recipients, so re-runs are safe.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import {
  buildAudienceQueryAsync,
  applyMergeTags,
  buildUnsubscribeUrl,
  appendUnsubscribeFooter,
  sendBatch,
} from '@/lib/postmark'
import { getAppUrl } from '@/lib/app-url'

export const dynamic = 'force-dynamic'

export async function POST(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!['master', 'owner'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden — master/owner only' }, { status: 403 })
  }

  const db = createServerClient()
  const campaignId = params.id

  const { data: campaign, error: campError } = await db
    .from('campaigns')
    .select('*, locations(name, slug)')
    .eq('id', campaignId)
    .single()
  if (campError || !campaign) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }

  // Load existing recipient contact_ids so we can exclude them
  // from the resend. Paginate because this set can exceed 1000 too.
  const PAGE_SIZE = 1000
  const alreadySent = new Set()
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from('campaign_recipients')
      .select('contact_id')
      .eq('campaign_id', campaignId)
      .range(from, from + PAGE_SIZE - 1)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    if (!data || data.length === 0) break
    for (const r of data) alreadySent.add(r.contact_id)
    if (data.length < PAGE_SIZE) break
  }

  // Now load the full audience (paginated — same pattern as the
  // CAMPAIGN.11 fix in sendCampaign).
  const audienceContacts = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { query } = await buildAudienceQueryAsync(db, campaign.audience_filter, campaign.location_id)
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    if (!data || data.length === 0) break
    audienceContacts.push(...data)
    if (data.length < PAGE_SIZE) break
  }

  const missing = audienceContacts.filter(c => !alreadySent.has(c.id))
  if (missing.length === 0) {
    return NextResponse.json({
      success: true,
      message: 'No missing recipients — every audience match is already in campaign_recipients.',
      audience_count: audienceContacts.length,
      already_sent: alreadySent.size,
      to_resend: 0,
    })
  }

  const baseUrl = getAppUrl()

  const emailBatch = missing.map(contact => {
    const unsubscribeUrl = buildUnsubscribeUrl(contact, baseUrl)
    const prefs = contact.contact_preferences?.[0] || contact.contact_preferences
    const preferenceUrl = `${baseUrl}/preferences/${prefs?.unsubscribe_token || contact.id}`

    const merged = applyMergeTags(campaign.html_content, contact, {
      location_name: campaign.locations?.name || '',
      unsubscribe_url: unsubscribeUrl,
      preference_url: preferenceUrl,
    })
    const personalizedHtml = appendUnsubscribeFooter(merged, unsubscribeUrl)

    return {
      to: contact.email,
      subject: applyMergeTags(campaign.subject, contact),
      htmlBody: personalizedHtml,
      from: campaign.from_name
        ? `${campaign.from_name} <${campaign.from_email || process.env.POSTMARK_FROM_EMAIL}>`
        : undefined,
      replyTo: campaign.reply_to,
      stream: 'broadcast',
      tag: `campaign-${campaignId}`,
      metadata: {
        campaign_id: campaignId,
        contact_id: contact.id,
        resend: 'campaign-11-recovery',
      },
      unsubscribeUrl,
      _contactId: contact.id,
    }
  })

  // Insert campaign_recipients rows (queued) for every missing contact.
  const recipientRecords = missing.map(c => ({
    campaign_id: campaignId,
    contact_id: c.id,
    status: 'queued',
  }))
  // Insert in chunks of 1000 to stay polite with PostgREST.
  for (let i = 0; i < recipientRecords.length; i += PAGE_SIZE) {
    const chunk = recipientRecords.slice(i, i + PAGE_SIZE)
    const { error } = await db.from('campaign_recipients').insert(chunk)
    if (error) return NextResponse.json({ success: false, error: `recipient insert failed: ${error.message}` }, { status: 500 })
  }

  // Send via Postmark batch.
  const results = await sendBatch(emailBatch)

  // Update each recipient + log to email_sends.
  let sentCount = 0
  let bouncedCount = 0
  const sendRecords = []
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const contact = missing[i]
    if (result.ErrorCode === 0 || result.MessageID) {
      sentCount++
      await db.from('campaign_recipients')
        .update({
          status: 'sent',
          postmark_message_id: result.MessageID,
          sent_at: new Date().toISOString(),
        })
        .eq('campaign_id', campaignId)
        .eq('contact_id', contact.id)

      sendRecords.push({
        contact_id: contact.id,
        location_id: campaign.location_id,
        source_type: 'campaign',
        campaign_id: campaignId,
        subject: campaign.subject,
        from_email: campaign.from_email || process.env.POSTMARK_FROM_EMAIL,
        to_email: contact.email,
        postmark_message_id: result.MessageID,
        postmark_stream: 'broadcast',
        status: 'sent',
      })
    } else {
      bouncedCount++
      await db.from('campaign_recipients')
        .update({
          status: 'bounced',
          bounce_type: 'rejected',
        })
        .eq('campaign_id', campaignId)
        .eq('contact_id', contact.id)
    }
  }

  // Log to email_sends in chunks.
  for (let i = 0; i < sendRecords.length; i += PAGE_SIZE) {
    const chunk = sendRecords.slice(i, i + PAGE_SIZE)
    await db.from('email_sends').insert(chunk)
  }

  // Bump total_recipients by the count we just sent.
  await db.from('campaigns')
    .update({ total_recipients: (campaign.total_recipients || 0) + sentCount })
    .eq('id', campaignId)

  return NextResponse.json({
    success: true,
    audience_count: audienceContacts.length,
    already_sent: alreadySent.size,
    resent: sentCount,
    bounced: bouncedCount,
  })
}

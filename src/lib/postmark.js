import { createServerClient } from './supabase'
import { getAppUrl } from './app-url'
import { applyAudienceFilter } from './audience-filter'

const POSTMARK_API_URL = 'https://api.postmarkapp.com'

function getPostmarkToken() {
  const token = process.env.POSTMARK_API_KEY || process.env.POSTMARK_SERVER_TOKEN
  if (!token) {
    throw new Error(
      'Postmark API key not configured. Set POSTMARK_API_KEY in your environment variables. ' +
      `Available env vars: POSTMARK_API_KEY=${process.env.POSTMARK_API_KEY ? 'SET' : 'MISSING'}, ` +
      `POSTMARK_SERVER_TOKEN=${process.env.POSTMARK_SERVER_TOKEN ? 'SET' : 'MISSING'}`
    )
  }
  return token
}

// ============================================================
// CORE SENDING
// ============================================================

/**
 * Send a single email via Postmark
 * @param {Object} options
 * @param {string} options.to - recipient email
 * @param {string} options.subject - email subject
 * @param {string} options.htmlBody - HTML content
 * @param {string} options.from - sender (e.g. "UN1T <hello@un1t.ie>")
 * @param {string} options.replyTo - reply-to address
 * @param {string} options.stream - 'broadcast' or 'outbound' (transactional)
 * @param {string} options.tag - tracking tag
 * @param {Object} options.metadata - custom metadata
 * @param {string} options.unsubscribeUrl - List-Unsubscribe URL for GDPR
 */
export async function sendEmail({
  to,
  subject,
  htmlBody,
  from,
  replyTo,
  stream = 'broadcast',
  tag,
  metadata = {},
  unsubscribeUrl,
}) {
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Postmark-Server-Token': getPostmarkToken(),
  }

  const body = {
    From: from || process.env.POSTMARK_FROM_EMAIL || 'UN1T <hello@un1t.ie>',
    To: to,
    Subject: subject,
    HtmlBody: htmlBody,
    ReplyTo: replyTo || undefined,
    MessageStream: stream,
    Tag: tag || undefined,
    Metadata: metadata,
    TrackOpens: true,
    TrackLinks: 'HtmlOnly',
  }

  // Add List-Unsubscribe header for GDPR compliance (required for marketing emails)
  if (stream === 'broadcast' && unsubscribeUrl) {
    body.Headers = [
      { Name: 'List-Unsubscribe', Value: `<${unsubscribeUrl}>` },
      { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
    ]
  }

  const response = await fetch(`${POSTMARK_API_URL}/email`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const result = await response.json()

  if (!response.ok) {
    console.error('Postmark send error:', result)
    throw new Error(result.Message || 'Failed to send email')
  }

  return {
    messageId: result.MessageID,
    to: result.To,
    submittedAt: result.SubmittedAt,
  }
}

/**
 * Send batch emails via Postmark (up to 500 per call)
 */
export async function sendBatch(emails) {
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Postmark-Server-Token': getPostmarkToken(),
  }

  // Postmark batch limit is 500
  const chunks = []
  for (let i = 0; i < emails.length; i += 500) {
    chunks.push(emails.slice(i, i + 500))
  }

  const results = []

  for (const chunk of chunks) {
    const body = chunk.map(email => ({
      From: email.from || process.env.POSTMARK_FROM_EMAIL || 'UN1T <hello@un1t.ie>',
      To: email.to,
      Subject: email.subject,
      HtmlBody: email.htmlBody,
      ReplyTo: email.replyTo || undefined,
      MessageStream: email.stream || 'broadcast',
      Tag: email.tag || undefined,
      Metadata: email.metadata || {},
      TrackOpens: true,
      TrackLinks: 'HtmlOnly',
      ...(email.stream !== 'outbound' && email.unsubscribeUrl ? {
        Headers: [
          { Name: 'List-Unsubscribe', Value: `<${email.unsubscribeUrl}>` },
          { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
        ],
      } : {}),
    }))

    const response = await fetch(`${POSTMARK_API_URL}/email/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    const result = await response.json()
    results.push(...(Array.isArray(result) ? result : [result]))
  }

  return results
}

// ============================================================
// MERGE TAGS — personalise email content
// ============================================================

/**
 * Replace merge tags in HTML with contact data
 * Supported tags: {{first_name}}, {{name}}, {{email}}, {{phone}},
 *   {{lead_status}}, {{location_name}}, {{unsubscribe_url}}
 */
export function applyMergeTags(html, contact, extras = {}) {
  if (!html) return html

  const replacements = {
    '{{first_name}}': contact.first_name || contact.name?.split(' ')[0] || '',
    '{{last_name}}': contact.last_name || '',
    '{{name}}': contact.name || '',
    '{{email}}': contact.email || '',
    '{{phone}}': contact.phone || '',
    '{{lead_status}}': contact.lead_status?.replace('_', ' ') || '',
    '{{location_name}}': extras.location_name || '',
    '{{unsubscribe_url}}': extras.unsubscribe_url || '',
    '{{preference_url}}': extras.preference_url || '',
    '{{current_year}}': new Date().getFullYear().toString(),
  }

  let result = html
  for (const [tag, value] of Object.entries(replacements)) {
    result = result.replaceAll(tag, value)
  }

  return result
}

// ============================================================
// AUDIENCE BUILDER — filter contacts for campaigns
// ============================================================

/**
 * Build a Supabase query from audience filter JSON
 * Filter format: { "filters": [...], "logic": "and" | "or" }
 * Each filter: { "field": string, "op": string, "value": any }
 *
 * Supported ops: eq, neq, gt, lt, gte, lte, contains, not_contains, is_null, is_not_null,
 *   days_since_gt, days_since_lt (for date fields)
 */
export function buildAudienceQuery(db, filter, locationId) {
  let query = db
    .from('contacts')
    .select('*, contact_preferences!inner(*)')
    .eq('location_id', locationId)
    .eq('contact_preferences.email_marketing', true)  // Always respect consent

  // Exclude bounced/complained contacts
  query = query.not('email_status', 'in', '("bounced","complained")')

  // Apply user-supplied filters via the whitelisted helper. Throws
  // InvalidAudienceFilterError if the filter contains an unknown field
  // or unsupported operator — let it bubble up so the caller returns 400.
  return applyAudienceFilter(query, filter)
}

// ============================================================
// CAMPAIGN SENDING ORCHESTRATOR
// ============================================================

/**
 * Send a campaign to all matching recipients
 * Called by the /api/campaigns/[id]/send route
 */
export async function sendCampaign(campaignId) {
  const db = createServerClient()

  // Get campaign
  const { data: campaign, error: campError } = await db
    .from('campaigns')
    .select('*, locations(name, slug)')
    .eq('id', campaignId)
    .single()

  if (campError || !campaign) throw new Error('Campaign not found')
  if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
    throw new Error(`Campaign is ${campaign.status}, cannot send`)
  }

  // Update status to sending
  await db.from('campaigns').update({ status: 'sending' }).eq('id', campaignId)

  // Get audience
  const audienceQuery = buildAudienceQuery(db, campaign.audience_filter, campaign.location_id)
  const { data: contacts, error: contactError } = await audienceQuery

  if (contactError) throw new Error(`Audience query failed: ${contactError.message}`)
  if (!contacts?.length) {
    await db.from('campaigns').update({ status: 'sent', sent_at: new Date().toISOString(), total_recipients: 0 }).eq('id', campaignId)
    return { sent: 0 }
  }

  // Throws if NEXT_PUBLIC_APP_URL is unset — campaign emails embed
  // unsubscribe URLs that recipients click from their inbox; if the env var
  // is wrong every recipient lands on a dead domain. Fail fast.
  const baseUrl = getAppUrl()

  // Prepare batch emails
  const emailBatch = contacts.map(contact => {
    const prefs = contact.contact_preferences?.[0] || contact.contact_preferences
    const unsubscribeUrl = `${baseUrl}/unsubscribe/${prefs?.unsubscribe_token || contact.id}`
    const preferenceUrl = `${baseUrl}/preferences/${prefs?.unsubscribe_token || contact.id}`

    const personalizedHtml = applyMergeTags(campaign.html_content, contact, {
      location_name: campaign.locations?.name || '',
      unsubscribe_url: unsubscribeUrl,
      preference_url: preferenceUrl,
    })

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
      },
      unsubscribeUrl,
      _contactId: contact.id,
    }
  })

  // Create recipient records
  const recipientRecords = contacts.map(c => ({
    campaign_id: campaignId,
    contact_id: c.id,
    status: 'queued',
  }))

  await db.from('campaign_recipients').insert(recipientRecords)

  // Send in batches
  const results = await sendBatch(emailBatch)

  // Update recipient records with Postmark message IDs and create email_sends
  let sentCount = 0
  const sendRecords = []

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const contact = contacts[i]

    if (result.ErrorCode === 0 || result.MessageID) {
      sentCount++

      // Update recipient
      await db.from('campaign_recipients')
        .update({
          status: 'sent',
          postmark_message_id: result.MessageID,
          sent_at: new Date().toISOString(),
        })
        .eq('campaign_id', campaignId)
        .eq('contact_id', contact.id)

      // Log to email_sends
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
      // Mark as bounced/failed
      await db.from('campaign_recipients')
        .update({
          status: 'bounced',
          bounce_type: 'rejected',
          bounced_at: new Date().toISOString(),
        })
        .eq('campaign_id', campaignId)
        .eq('contact_id', contact.id)
    }
  }

  // Bulk insert send records
  if (sendRecords.length) {
    await db.from('email_sends').insert(sendRecords)
  }

  // Update campaign metrics
  await db.from('campaigns').update({
    status: 'sent',
    sent_at: new Date().toISOString(),
    total_recipients: contacts.length,
    total_sent: sentCount,
  }).eq('id', campaignId)

  return { sent: sentCount, total: contacts.length }
}

// ============================================================
// TRANSACTIONAL EMAILS (event reminders, booking confirmations)
// ============================================================

/**
 * Send a transactional email (uses Postmark's transactional stream)
 */
export async function sendTransactionalEmail({ to, subject, htmlBody, contactId, locationId, tag }) {
  const result = await sendEmail({
    to,
    subject,
    htmlBody,
    stream: 'outbound',  // Postmark transactional stream
    tag: tag || 'transactional',
  })

  // Log to email_sends
  if (contactId) {
    const db = createServerClient()
    await db.from('email_sends').insert({
      contact_id: contactId,
      location_id: locationId,
      source_type: 'transactional',
      subject,
      from_email: process.env.POSTMARK_FROM_EMAIL,
      to_email: to,
      postmark_message_id: result.messageId,
      postmark_stream: 'outbound',
      status: 'sent',
    })
  }

  return result
}

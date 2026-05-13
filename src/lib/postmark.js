import { createServerClient } from './supabase'
import { getAppUrl } from './app-url'
import { applyAudienceFilter, applyAudienceFilterAsync } from './audience-filter'

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
 *   {{pipeline_stage}} (canonical, CLASSIFY.2 — reads
 *   contacts.pipeline_stage_slug), {{lead_status}} (deprecated alias,
 *   kept for back-compat with existing campaign HTML — also reads
 *   pipeline_stage_slug), {{location_name}}, {{unsubscribe_url}},
 *   {{glofox_passcode}} (GLOFOX3.5; one-time Glofox passcode minted
 *   when CRM creates a new Glofox account — read by the welcome
 *   sequence; stored on contacts.glofox_passcode by glofox-push.js).
 */
export function applyMergeTags(html, contact, extras = {}) {
  if (!html) return html

  const stageLabel = contact.pipeline_stage_slug?.replaceAll('_', ' ') || ''
  const replacements = {
    '{{first_name}}': contact.first_name || contact.name?.split(' ')[0] || '',
    '{{last_name}}': contact.last_name || '',
    '{{name}}': contact.name || '',
    '{{email}}': contact.email || '',
    '{{phone}}': contact.phone || '',
    '{{pipeline_stage}}': stageLabel,
    // Deprecated alias — kept so existing campaign HTML / sequence
    // step bodies that reference {{lead_status}} keep rendering.
    // Now reads pipeline_stage_slug (CLASSIFY.2).
    '{{lead_status}}': stageLabel,
    '{{location_name}}': extras.location_name || '',
    '{{unsubscribe_url}}': extras.unsubscribe_url || '',
    '{{preference_url}}': extras.preference_url || '',
    '{{current_year}}': new Date().getFullYear().toString(),
    '{{glofox_passcode}}': contact.glofox_passcode || '',
  }

  let result = html
  for (const [tag, value] of Object.entries(replacements)) {
    result = result.replaceAll(tag, value)
  }

  return result
}

// ============================================================
// UNSUBSCRIBE FOOTER — appended automatically to every marketing
// email (campaign broadcasts + sequence step emails). Transactional
// emails (booking confirmation, password reset, deposit receipt,
// etc.) do NOT call this — they go through sendTransactionalEmail
// directly without the footer wrapper.
// ============================================================

/**
 * Build the canonical /unsubscribe/<token> URL for a contact.
 * Prefers the per-contact unsubscribe_token (from
 * contact_preferences) and falls back to contact.id, mirroring the
 * lookup logic the unsubscribe page already accepts. The caller
 * provides baseUrl from getAppUrl() so this is unit-testable
 * without env vars.
 */
export function buildUnsubscribeUrl(contact, baseUrl) {
  const prefs = contact?.contact_preferences?.[0] || contact?.contact_preferences
  const token = prefs?.unsubscribe_token || contact?.id
  return `${baseUrl}/unsubscribe/${token}`
}

/**
 * Append a small "Unsubscribe" footer (7pt, muted) to a fully-
 * rendered marketing email body. Always appends regardless of
 * whether the operator already placed a {{unsubscribe_url}} link
 * in the body — operator choice was "always append" so the
 * compliance link is guaranteed and nobody has to remember.
 *
 * Insertion strategy: insert immediately before the LAST </body>
 * tag if one exists (so the footer lands inside the body), else
 * append at the end. Either way the link is the last visual
 * element in the rendered email.
 *
 * Email-client safe: table layout, inline styles only, no
 * external CSS, no JS. font-size:7pt matches the operator's
 * spec; color #888 is muted-grey on white/light backgrounds
 * (the email itself owns its background — we don't try to match).
 */
export function appendUnsubscribeFooter(html, unsubscribeUrl) {
  if (!html || !unsubscribeUrl) return html

  const footer = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0 0 0;border-collapse:collapse;"><tr><td align="center" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:7pt;color:#888888;padding:16px 8px;line-height:1.4;"><a href="${unsubscribeUrl}" style="color:#888888;text-decoration:underline;">Unsubscribe</a></td></tr></table>`

  // Case-insensitive search for the LAST </body>. Most HTML
  // emails have exactly one; some templates have none (snippet
  // bodies). lastIndexOf is fine for single-occurrence — and for
  // the pathological multi-body case, the operator's last body
  // close is where the footer logically belongs.
  const bodyCloseIdx = html.toLowerCase().lastIndexOf('</body>')
  if (bodyCloseIdx === -1) return html + footer
  return html.slice(0, bodyCloseIdx) + footer + html.slice(bodyCloseIdx)
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
export function buildAudienceQuery(db, filter, locationId, { columns = '*', selectOpts } = {}) {
  // CLASSIFY.1 — uses denormalised contacts.email_marketing instead of
  // an inner-join on contact_preferences. Single-table filtering kills
  // a long line of PostgREST embedded-resource bugs in the count path
  // (head:true + .select() override silently dropping the relationship
  // binding). The trigger in mig 155 keeps contacts.email_marketing in
  // sync with contact_preferences.email_marketing.
  //
  // CAMPAIGN.10 — pass count/head via the FIRST .select() call.
  // postgrest-js v2 has two select() overloads:
  //   - PostgrestQueryBuilder.select(columns, options) — accepts
  //     { count, head }, sets HTTP method to HEAD, adds the
  //     Prefer: count=exact header.
  //   - PostgrestTransformBuilder.select(columns) — accepts ONLY
  //     columns. Any options object passed in is silently ignored.
  // Calling .select() again AFTER filters (i.e. on the filter builder)
  // hits the TransformBuilder overload — the head/count options vanish.
  // Callers that need a count must therefore request it on the FIRST
  // select(), which is what this helper does for them.
  let query = db
    .from('contacts')
    .select(columns, selectOpts)
    .eq('location_id', locationId)
    .eq('email_marketing', true)
    .not('email_status', 'in', '("bounced","complained")')

  return applyAudienceFilter(query, filter)
}

/**
 * Async sibling of buildAudienceQuery — supports the `tag` field
 * (Phase 3 retargeting). Use from any async caller that handles
 * an audience filter from the UI; the AudienceBuilder may contain
 * tag clauses now.
 *
 * To get a count without fetching rows, pass:
 *   buildAudienceQueryAsync(db, filter, locationId, {
 *     columns: 'id',
 *     selectOpts: { count: 'exact', head: true },
 *   })
 * See buildAudienceQuery's CAMPAIGN.10 comment for the postgrest-js
 * select-overload gotcha.
 */
export async function buildAudienceQueryAsync(db, filter, locationId, { columns = '*', selectOpts } = {}) {
  let query = db
    .from('contacts')
    .select(columns, selectOpts)
    .eq('location_id', locationId)
    .eq('email_marketing', true)
    .not('email_status', 'in', '("bounced","complained")')
  // Returns { query } so the caller can destructure without the
  // thenable-protocol auto-unwrap firing the underlying HTTP call
  // before the caller intends. See audience-filter.js resolveTagFilters
  // header for the full reasoning.
  return applyAudienceFilterAsync({ db, query, filter, locationId })
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

  // Get audience — paginated to bypass Supabase/PostgREST's default
  // 1000-row select cap.
  //
  // CAMPAIGN.11 — operator's first real campaign ("15 mins?") sent
  // to 1,000 contacts when 2,998 should have received it. The
  // truncation was silent: PostgREST returned exactly 1,000 rows
  // (its default max) and downstream code processed the partial
  // result as if it were the full audience. Fix is to page through
  // with .range() until a partial page comes back. Each page
  // rebuilds the query because PostgrestFilterBuilder instances
  // are single-use (awaiting once consumes the thenable). Tag-
  // filter resolution re-runs per page, but that's cheap (one
  // contact_tags lookup) and audiences rarely have many pages.
  const AUDIENCE_PAGE_SIZE = 1000
  const contacts = []
  for (let from = 0; ; from += AUDIENCE_PAGE_SIZE) {
    const { query } = await buildAudienceQueryAsync(db, campaign.audience_filter, campaign.location_id)
    const { data, error } = await query.range(from, from + AUDIENCE_PAGE_SIZE - 1)
    if (error) throw new Error(`Audience query failed: ${error.message}`)
    if (!data || data.length === 0) break
    contacts.push(...data)
    if (data.length < AUDIENCE_PAGE_SIZE) break
  }

  if (!contacts.length) {
    await db.from('campaigns').update({ status: 'sent', sent_at: new Date().toISOString(), total_recipients: 0 }).eq('id', campaignId)
    return { sent: 0 }
  }

  // Throws if NEXT_PUBLIC_APP_URL is unset — campaign emails embed
  // unsubscribe URLs that recipients click from their inbox; if the env var
  // is wrong every recipient lands on a dead domain. Fail fast.
  const baseUrl = getAppUrl()

  // Prepare batch emails
  const emailBatch = contacts.map(contact => {
    const unsubscribeUrl = buildUnsubscribeUrl(contact, baseUrl)
    const prefs = contact.contact_preferences?.[0] || contact.contact_preferences
    const preferenceUrl = `${baseUrl}/preferences/${prefs?.unsubscribe_token || contact.id}`

    const merged = applyMergeTags(campaign.html_content, contact, {
      location_name: campaign.locations?.name || '',
      unsubscribe_url: unsubscribeUrl,
      preference_url: preferenceUrl,
    })
    // Compliance footer — auto-appended for every marketing send so
    // no operator has to remember to add {{unsubscribe_url}} to the
    // body. Operator-placed inline links via the merge tag still
    // work; this just guarantees a final-line "Unsubscribe" link.
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

  // CAMPAIGN.12 — final pass: recompute every counter from email_sends
  // (the source of truth) so the campaign rollup is consistent even
  // if any individual webhook fires before this finalise step lands
  // (webhooks would otherwise increment a then-yet-unwritten value).
  // Idempotent — running it again does nothing.
  await db.rpc('recalculate_campaign_stats', { p_campaign_id: campaignId })
    .then(({ error }) => {
      if (error) console.error('[sendCampaign] recalculate_campaign_stats failed:', error.message)
    })

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

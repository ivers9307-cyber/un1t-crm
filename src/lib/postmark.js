import { createServerClient } from './supabase'
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
 * UNSUB.3 — derive the POST-able one-click unsubscribe URL from
 * a friendly page URL. The body-visible link stays on /unsubscribe/
 * (a Next.js page); the List-Unsubscribe header needs an endpoint
 * that actually accepts POST. /api/unsubscribe/[token] is that
 * endpoint — it parses an optional `{ channels: [...] }` body and
 * defaults to ['email_marketing'] when called with no body
 * (which is what email-client one-click sends).
 *
 * Exported so the test suite can lock the URL transform.
 */
export function toListUnsubscribeUrl(pageUrl) {
  if (!pageUrl || typeof pageUrl !== 'string') return pageUrl
  return pageUrl.replace('/unsubscribe/', '/api/unsubscribe/')
}

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

  // Add List-Unsubscribe header for GDPR compliance (required for
  // marketing emails). UNSUB.3 — point the header URL at the POST
  // endpoint, NOT the friendly page. Gmail / Outlook / Apple Mail
  // do List-Unsubscribe=One-Click by POSTing to this URL with an
  // empty body. If the URL resolves to a Next.js page route, the
  // POST returns 405 and the unsubscribe is silently lost (the
  // bug we hit: user clicks Unsubscribe in Gmail, Postmark records
  // nothing changed on our side, contact stays opted-in).
  // /api/unsubscribe/[token] does accept POST and writes
  // contact_preferences + consent_log correctly.
  if (stream === 'broadcast' && unsubscribeUrl) {
    body.Headers = [
      { Name: 'List-Unsubscribe', Value: `<${toListUnsubscribeUrl(unsubscribeUrl)}>` },
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
          // UNSUB.3 — POST endpoint, not the friendly page (see
          // sendEmail above for the bug history).
          { Name: 'List-Unsubscribe', Value: `<${toListUnsubscribeUrl(email.unsubscribeUrl)}>` },
          { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
        ],
      } : {}),
    }))

    // Postmark's batch endpoint returns an ARRAY of per-message results on
    // success. On a non-2xx (auth, rate-limit, malformed batch) — or a
    // network/JSON failure — it returns a single { ErrorCode, Message }
    // object (or nothing). The old code pushed that as ONE result for the
    // whole chunk, so the caller mis-mapped it to email[0] and silently
    // dropped the other 499 (or treated the chunk as sent). Always emit one
    // result PER email, in order, so every recipient is accounted for and a
    // failed batch is recorded as failed (and retried) rather than lost.
    let result
    try {
      const response = await fetch(`${POSTMARK_API_URL}/email/batch`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      result = await response.json()
      if (!response.ok || !Array.isArray(result)) {
        const code = result?.ErrorCode || -1
        const message = result?.Message || `Postmark batch failed (HTTP ${response.status})`
        results.push(...chunk.map(() => ({ ErrorCode: code, Message: message })))
        continue
      }
    } catch (err) {
      results.push(...chunk.map(() => ({ ErrorCode: -1, Message: err?.message || 'Postmark batch request failed' })))
      continue
    }
    results.push(...result)
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
 * rendered marketing email body — but only when the body does not
 * already contain an unsubscribe link.
 *
 * Idempotent by design: operators can insert a {{unsubscribe_url}}
 * merge tag from the Campaign / Template / Unlayer editors, and
 * many branded templates already carry a styled unsubscribe link.
 * Appending unconditionally rendered TWO "Unsubscribe" links
 * (operator-reported — a styled one plus this plain footer). We
 * now skip the auto-footer when the contact's unsubscribe URL is
 * already present, so recipients see exactly one link. Compliance
 * is still guaranteed: templates with no unsubscribe link get the
 * footer, and the List-Unsubscribe email-client header is added
 * separately in sendBatch/sendTransactionalEmail regardless.
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

  // Already has this contact's unsubscribe link (e.g. an inlined
  // {{unsubscribe_url}} merge tag) → don't add a duplicate.
  if (html.includes(unsubscribeUrl)) return html

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
// Email consent columns the audience gate may filter on. Whitelisted so a
// caller can never smuggle an arbitrary column into the .eq(). 'broadcast'
// (marketing) gates on email_marketing; 'outbound' (transactional/Utility)
// gates on email_administrative (denormalised onto contacts in mig 301).
const ALLOWED_CONSENT_FIELDS = new Set(['email_marketing', 'email_administrative'])

export function consentFieldForStream(stream) {
  return stream === 'outbound' ? 'email_administrative' : 'email_marketing'
}

function assertConsentField(consentField) {
  if (!ALLOWED_CONSENT_FIELDS.has(consentField)) {
    throw new Error(`Invalid consentField: ${consentField}`)
  }
  return consentField
}

export function buildAudienceQuery(db, filter, locationId, { columns = '*', selectOpts, consentField = 'email_marketing' } = {}) {
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
    .eq(assertConsentField(consentField), true)
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
export async function buildAudienceQueryAsync(db, filter, locationId, { columns = '*', selectOpts, consentField = 'email_marketing' } = {}) {
  let query = db
    .from('contacts')
    .select(columns, selectOpts)
    .eq('location_id', locationId)
    .eq(assertConsentField(consentField), true)
    .not('email_status', 'in', '("bounced","complained")')
  // Returns { query } so the caller can destructure without the
  // thenable-protocol auto-unwrap firing the underlying HTTP call
  // before the caller intends. See audience-filter.js resolveTagFilters
  // header for the full reasoning.
  return applyAudienceFilterAsync({ db, query, filter, locationId })
}


// ============================================================
// TRANSACTIONAL EMAILS (event reminders, booking confirmations)
// ============================================================

/**
 * Send a transactional email (uses Postmark's transactional stream)
 */
export async function sendTransactionalEmail({
  to, subject, htmlBody, contactId, locationId, tag,
  // Optional attribution written ATOMICALLY with the email_sends row.
  // Callers that send on behalf of a sequence pass these so an open/click
  // webhook can never beat the attribution (the sequence runner used to
  // write them in a follow-up UPDATE that raced the webhook).
  sourceType = 'transactional', sequenceId = null, sequenceStepId = null,
}) {
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
      source_type: sourceType,
      sequence_id: sequenceId,
      sequence_step_id: sequenceStepId,
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

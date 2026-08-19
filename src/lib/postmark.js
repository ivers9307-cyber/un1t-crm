import { createServerClient } from './supabase'
import { resolvePostmarkToken } from './postmark-token'
import { applyAudienceFilter, applyAudienceFilterAsync } from './audience-filter'
import { htmlToPlainText } from './email-content'
import { resolveEmailSender } from './tenant-email'
import { withSendMarker } from './postmark-send-marker'

const POSTMARK_API_URL = 'https://api.postmarkapp.com'

// ── Error classification (CAMPAIGN-REL.1) ─────────────────────────
//
// Postmark API error codes (https://postmarkapp.com/developer/api/overview#error-codes):
//   100 — Maintenance (HTTP 503)              → transient
//   429 — Rate limit exceeded (HTTP 429)      → transient
//   300 — Invalid email request               → permanent
//   400 — Sender signature not found          → permanent
//   406 — Inactive recipient (prior bounce)   → permanent
//   ... every other real code needs operator action, not a retry.
// Our own synthetic code:
//    -1 — network error / unparseable response for the WHOLE batch
//         call (see sendBatch) → transient.
// Synthetic whole-batch results also carry HttpStatus so a 429/5xx
// on the HTTP layer classifies as transient even when Postmark's
// body ErrorCode is absent or unknown.
const TRANSIENT_POSTMARK_CODES = new Set([-1, 100, 429])

/**
 * True when a per-email send result represents a TRANSIENT failure —
 * one where retrying the same email later can plausibly succeed
 * (network blip, rate limit, provider maintenance/5xx). Permanent
 * rejections (invalid address, inactive recipient, bad signature)
 * return false: retrying those can never succeed and hurts sender
 * reputation.
 *
 * @param {{ ErrorCode?: number, HttpStatus?: number } | null} result
 * @returns {boolean}
 */
export function isTransientSendError(result) {
  if (!result) return false
  if (TRANSIENT_POSTMARK_CODES.has(result.ErrorCode)) return true
  const status = result.HttpStatus
  if (typeof status === 'number' && (status === 429 || status >= 500)) return true
  return false
}

function getPostmarkToken() {
  const token = resolvePostmarkToken()
  if (!token) {
    throw new Error(
      'Postmark API key not configured. Set POSTMARK_API_KEY in your environment variables. ' +
      `Available env vars: POSTMARK_API_KEY=${process.env.POSTMARK_API_KEY ? 'SET' : 'MISSING'}, ` +
      `POSTMARK_SERVER_TOKEN=${process.env.POSTMARK_SERVER_TOKEN ? 'SET' : 'MISSING'}`
    )
  }
  return token
}

// INTEG-B3 — resolve the tenant sending override for a send. Returns
// { token, from } where BOTH are null unless a LIVE tenant email domain
// (server-per-tenant, mig 427) resolves for the given location:
//   - `token` non-null  → use it as X-Postmark-Server-Token (that org's
//     Postmark server) instead of getPostmarkToken()
//   - `from`  non-null  → use it as the From (that org's verified sender)
//
// ZERO BEHAVIOUR CHANGE is keyed on `token`: with no locationId/sender, or
// no live tenant row, or any resolver error, resolveEmailSender returns the
// global default (serverToken null) → token/from stay null → the caller's
// EXISTING getPostmarkToken() + POSTMARK_FROM_EMAIL path runs byte-for-byte
// unchanged. resolveEmailSender never throws.
async function resolveTenantOverride({ locationId, sender }) {
  // `sender === undefined` = the caller did not pre-resolve; only then do
  // we look up by locationId. A caller can pass `sender: null` to force the
  // global default with no lookup.
  const resolved = sender !== undefined
    ? sender
    : (locationId ? await resolveEmailSender(createServerClient(), locationId) : null)
  const token = resolved?.serverToken || null
  if (!token) return { token: null, from: null }
  const from = resolved.fromName
    ? `${resolved.fromName} <${resolved.fromEmail}>`
    : (resolved.fromEmail || null)
  return { token, from }
}

// ── Engagement tracking (EMAIL-NOTRACK.1) ─────────────────────────
//
// Richard's call (2026-08-07): delivery status yes; open and click
// tracking NO on one-to-one mail. Marketing keeps both — there the
// recipient sits in a consented bulk audience and the open rate
// informs a real decision.
//
// Until now sendEmail/sendBatch set TrackOpens + TrackLinks
// UNCONDITIONALLY, so a ticket reply, a contract, a password reset and
// a receipt were instrumented exactly like a marketing blast:
//   • TrackOpens embeds a 1x1 pixel — it leaks open time and IP, and
//     these are Irish members, so GDPR applies. We already block
//     INBOUND remote images by default for precisely this reason
//     (EMAIL-INBOX): blocking theirs while shipping our own is
//     indefensible.
//   • TrackLinks rewrites every href through Postmark's click domain.
//     Beyond privacy that is a FUNCTIONAL hazard on transactional
//     mail: a rewritten link reads as phishing in a support reply,
//     and a rewritten password-reset or contract-signing link is a
//     live failure mode, not a cosmetic one.
//
// THE SPLIT IS ON THE MESSAGE STREAM: 'broadcast' (marketing) tracks,
// everything else does not.
//
// WHY WE KEY ON THE CALLER'S *EXPLICIT* STREAM, NOT THE RESOLVED ONE:
// sendEmail's `stream` has historically defaulted to 'broadcast', so
// keying on the resolved value would make TRACKING THE DEFAULT — a new
// call site that forgot to say anything would silently ship a pixel.
// The safe outcome has to be the one you get by omission, so an
// omitted stream reads as "unstated", not as "marketing", and gets no
// tracking. The resolved default stays 'broadcast' on the wire because
// the List-Unsubscribe one-click headers hang off it (UNSUB.3) and
// changing that would be an unsubscribe-compliance change, which this
// work deliberately does not touch. Every one of the ~20 production
// call sites passes `stream` explicitly today, so the two readings
// differ for no live caller — the distinction exists to make the NEXT
// call site safe by default.
//
// The off-values match the house precedent already used by the direct
// -fetch transactional senders (contractor-invoice-email.js,
// xero/bills-email.js, xero/contractor-bills.js,
// xero/fte-expense-claims.js): explicit false/'None' rather than
// omitted keys, so the send never inherits a server- or stream-level
// tracking default from the Postmark dashboard.
export const MARKETING_STREAM = 'broadcast'

const TRACKING_ON = Object.freeze({ TrackOpens: true, TrackLinks: 'HtmlOnly' })
const TRACKING_OFF = Object.freeze({ TrackOpens: false, TrackLinks: 'None' })

/**
 * Resolve the Postmark tracking fields for one message.
 *
 * @param {Object} opts
 * @param {string} [opts.stream] - the stream the CALLER passed, raw.
 *   `undefined` deliberately does NOT mean marketing (see above).
 * @param {boolean} [opts.trackEngagement] - explicit per-call override.
 *   `true` forces tracking on (a genuinely consented send that happens
 *   not to ride the broadcast stream), `false` forces it off even for
 *   marketing. Anything else (the normal case) defers to the stream.
 * @returns {{TrackOpens: boolean, TrackLinks: string}}
 */
export function resolveTracking({ stream, trackEngagement } = {}) {
  if (trackEngagement === true) return { ...TRACKING_ON }
  if (trackEngagement === false) return { ...TRACKING_OFF }
  return stream === MARKETING_STREAM ? { ...TRACKING_ON } : { ...TRACKING_OFF }
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
 * @param {string} options.to - recipient email (comma-separated for several)
 * @param {string} options.cc - EMAIL-CC.1 — Cc recipients, comma-separated.
 *   Visible to every recipient, which is the whole point of a Cc.
 * @param {string} options.bcc - EMAIL-CC.1 — Bcc recipients, comma-separated.
 *   THIS IS THE ONLY PLACE A BCC ADDRESS MAY GO. It is set on Postmark's own
 *   `Bcc` API field and is never folded into To/Cc and never written into
 *   `Headers` — Postmark does not put a Bcc header on the delivered message,
 *   so no recipient ever sees the list. Callers build both fields through
 *   toPostmarkFields() in src/lib/email-recipients.js, which is the single
 *   site where a resolved recipient set becomes wire values.
 * @param {string} options.subject - email subject
 * @param {string} options.htmlBody - HTML content
 * @param {string} options.from - sender (e.g. "UN1T <hello@un1t.ie>")
 * @param {string} options.replyTo - reply-to address
 * @param {string} options.stream - THIS APP'S INTERNAL stream vocabulary:
 *   'broadcast' (marketing) or 'outbound' (transactional). It drives
 *   open/click tracking, the List-Unsubscribe gate, consentFieldForStream()
 *   and what gets written to email_sends.postmark_stream. Resolves to
 *   'broadcast' when omitted (unchanged), but an OMITTED stream never enables
 *   open/click tracking — see resolveTracking.
 * @param {string} options.postmarkStream - EMAIL-OUTBOUND-SERVER.1 — the
 *   POSTMARK MESSAGE STREAM ID that goes on the wire as `MessageStream`, when
 *   it differs from the internal one. A DIFFERENT CONCEPT from `stream` above:
 *   this is an opaque provider-side slug (e.g. 'email-send' on the ticketing
 *   server), scoped to whichever Postmark server the token belongs to, and it
 *   means nothing to this application. Omit it (every pre-existing caller) and
 *   the internal stream goes on the wire exactly as before.
 *   NEVER let this value reach consentFieldForStream(), campaigns.postmark_stream
 *   (CHECK-constrained to broadcast|outbound by mig 302) or
 *   email_sends.postmark_stream — there it would be silently read as the
 *   internal vocabulary and misclassify the send's consent family.
 * @param {boolean} options.trackEngagement - EMAIL-NOTRACK.1 explicit
 *   override for open/click tracking. Omit it (every caller today) and the
 *   stream decides: marketing tracks, transactional does not.
 * @param {string} options.tag - tracking tag
 * @param {Object} options.metadata - custom metadata
 * @param {string} options.unsubscribeUrl - List-Unsubscribe URL for GDPR
 * @param {Array<{Name: string, Value: string}>} options.headers - extra SMTP
 *   headers (EMAIL-INBOX.1 — inbox replies pass In-Reply-To/References so the
 *   reply threads correctly in the recipient's mail client)
 * @param {Array<{Name: string, Content: string, ContentType: string}>} options.attachments
 *   - CONTRACTS-PDF.1 — Postmark file attachments, already in Postmark's own
 *   shape: Content is the base64-encoded file. Purely additive; omitting it
 *   (every pre-existing caller) leaves the request body byte-identical.
 *   Postmark caps a message at 10MB TOTAL including the base64 overhead, so
 *   callers must size-check before passing anything here.
 */
export async function sendEmail({
  to,
  // EMAIL-CC.1 — both default to undefined, so the request body below is
  // byte-identical to a pre-EMAIL-CC.1 send for every caller that omits them.
  cc,
  bcc,
  subject,
  htmlBody,
  textBody,
  from,
  replyTo,
  // EMAIL-NOTRACK.1 — NO destructuring default. The wire default is applied
  // below as `messageStream`; `stream` stays raw so resolveTracking can tell
  // "the caller said broadcast" from "the caller said nothing".
  stream,
  // EMAIL-OUTBOUND-SERVER.1 — Postmark's own stream id, wire-only. See the
  // docstring: this is NOT `stream` and must never be treated as it.
  postmarkStream,
  trackEngagement,
  tag,
  metadata = {},
  unsubscribeUrl,
  headers: extraHeaders,
  attachments,
  // INTEG-B3 — optional per-tenant routing. Pass `locationId` to resolve
  // the location's org sending config, or a pre-resolved `sender`. When a
  // LIVE tenant email domain exists the send goes out on that org's Postmark
  // server + verified From; otherwise this is a no-op (byte-identical).
  locationId,
  sender,
}) {
  const tenant = await resolveTenantOverride({ locationId, sender })

  // THE INTERNAL stream, resolved. Preserves the historical default so the
  // List-Unsubscribe gate below is byte-identical for a caller that omits
  // `stream`; only tracking reads the raw value.
  const internalStream = stream || 'broadcast'

  // WHAT GOES ON THE WIRE. EMAIL-OUTBOUND-SERVER.1 split these two: a send on
  // a non-default Postmark server rides a stream id that exists only on THAT
  // server ('email-send' on the ticketing server), while the message is still
  // internally transactional. With postmarkStream omitted — every caller but
  // the ticket routes — the two are the same value and the payload is
  // byte-identical to before.
  const messageStream = postmarkStream || internalStream

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Postmark-Server-Token': tenant.token || getPostmarkToken(),
  }

  const body = {
    From: tenant.from || from || process.env.POSTMARK_FROM_EMAIL || 'UN1T <hello@un1t.ie>',
    To: to,
    // EMAIL-CC.1 — `|| undefined` so an empty string never becomes a key with
    // no value, and so the serialised body keeps its old shape when omitted.
    // Bcc is set HERE and nowhere else in this function: nothing below adds it
    // to `body.Headers`, which is what keeps the address off the delivered
    // message. See the sendEmail docblock.
    Cc: cc || undefined,
    Bcc: bcc || undefined,
    Subject: subject,
    HtmlBody: htmlBody,
    // CAMPAIGN-REL.4 — always ship a plain-text alternative. HTML-only
    // multipart is a spam signal; derive a conservative text part from
    // the HTML when the caller didn't supply one.
    TextBody: textBody || htmlToPlainText(htmlBody) || undefined,
    ReplyTo: replyTo || undefined,
    MessageStream: messageStream,
    Tag: tag || undefined,
    Metadata: metadata,
    // EMAIL-NOTRACK.1 — spread in the same key position the two literals
    // occupied, so a marketing payload serialises byte-for-byte as before.
    ...resolveTracking({ stream, trackEngagement }),
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
  // Reads the RESOLVED INTERNAL stream on purpose: unsubscribe compliance is
  // out of scope for EMAIL-NOTRACK.1, so an omitted stream keeps attaching the
  // one-click headers exactly as it did before. It is deliberately NOT the
  // wire value — "is this marketing?" is a question about our own vocabulary,
  // and a provider stream id can never answer it.
  if (internalStream === 'broadcast' && unsubscribeUrl) {
    body.Headers = [
      { Name: 'List-Unsubscribe', Value: `<${toListUnsubscribeUrl(unsubscribeUrl)}>` },
      { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
    ]
  }

  // EMAIL-INBOX.1 — caller-supplied headers (threading headers for inbox
  // replies). Appended after the compliance headers, never replacing them.
  if (Array.isArray(extraHeaders) && extraHeaders.length) {
    body.Headers = [...(body.Headers || []), ...extraHeaders]
  }

  // CONTRACTS-PDF.1 — optional file attachments (the signed-contract PDF).
  // The key is only added when the caller actually supplies attachments, so
  // an existing caller's payload is unchanged.
  if (Array.isArray(attachments) && attachments.length) {
    body.Attachments = attachments
  }

  const response = await fetch(`${POSTMARK_API_URL}/email`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const result = await response.json()

  if (!response.ok) {
    console.error('Postmark send error:', result)
    // EMAIL-OUTBOUND-SERVER.1 — carry Postmark's own classification on the
    // error. `message` is unchanged (every existing caller reads only that),
    // but a rejection is now machine-readable: the ticket send path has to
    // tell "this From has no verified sender signature" (ErrorCode 400/401,
    // recoverable by sending from a domain we own) apart from every other
    // rejection, which it must NOT retry. sendBatch already had this via its
    // per-message { ErrorCode, HttpStatus } results; sendEmail threw it away.
    const err = new Error(result?.Message || 'Failed to send email')
    err.errorCode = typeof result?.ErrorCode === 'number' ? result.ErrorCode : null
    err.httpStatus = response.status
    throw err
  }

  return {
    messageId: result.MessageID,
    to: result.To,
    submittedAt: result.SubmittedAt,
  }
}

/**
 * Send batch emails via Postmark (up to 500 per call).
 *
 * INTEG-B3 — the optional 2nd arg carries per-tenant routing for the WHOLE
 * batch: `{ locationId }` (resolved once) or a pre-resolved `{ sender }`.
 * With neither (every caller today) the resolver returns the global default
 * and the token + per-email From are byte-identical to before.
 *
 * EMAIL-NOTRACK.1 — each email may carry `trackEngagement` (boolean) to
 * override the stream-derived open/click tracking for that message only.
 */
export async function sendBatch(emails, { locationId, sender } = {}) {
  const tenant = await resolveTenantOverride({ locationId, sender })

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Postmark-Server-Token': tenant.token || getPostmarkToken(),
  }

  // Postmark batch limit is 500
  const chunks = []
  for (let i = 0; i < emails.length; i += 500) {
    chunks.push(emails.slice(i, i + 500))
  }

  const results = []

  for (const chunk of chunks) {
    const body = chunk.map(email => ({
      From: tenant.from || email.from || process.env.POSTMARK_FROM_EMAIL || 'UN1T <hello@un1t.ie>',
      To: email.to,
      Subject: email.subject,
      HtmlBody: email.htmlBody,
      // CAMPAIGN-REL.4 — plain-text alternative (see sendEmail above).
      TextBody: email.textBody || htmlToPlainText(email.htmlBody) || undefined,
      ReplyTo: email.replyTo || undefined,
      MessageStream: email.stream || 'broadcast',
      Tag: email.tag || undefined,
      Metadata: email.metadata || {},
      // EMAIL-NOTRACK.1 — per-email, and keyed on the RAW email.stream for
      // the same reason as sendEmail: an unstated stream must not opt the
      // recipient into a tracking pixel. campaign-sender always sets
      // `stream` explicitly ('broadcast' for Marketing campaigns), so the
      // marketing payload is unchanged.
      ...resolveTracking({ stream: email.stream, trackEngagement: email.trackEngagement }),
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
        // HttpStatus rides along so callers can classify a 429/5xx on
        // the whole batch call as transient (isTransientSendError).
        results.push(...chunk.map(() => ({ ErrorCode: code, Message: message, HttpStatus: response.status })))
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
 * Replace merge tags in HTML with contact data.
 *
 * The `replacements` table below is the source of truth for WHICH tags
 * substitute. K3 — src/lib/merge-tags.js is the operator-facing mirror of it
 * (labels, descriptions, and which tags the editors offer), and
 * merge-tags.test.js fails if the two drift apart in either direction. This
 * docblock used to try to list the tags by hand and had itself fallen three
 * behind; adding a tag here now means adding it to the registry too.
 *
 * Two notes that are not obvious from the table:
 *   {{lead_status}} is a deprecated alias of {{pipeline_stage}} (CLASSIFY.2)
 *     — both read contacts.pipeline_stage_slug. Kept so email bodies written
 *     before the rename keep rendering.
 *   {{glofox_passcode}} (GLOFOX3.5) is the one-time passcode minted when CRM
 *     creates a Glofox account; glofox-push.js stores it on
 *     contacts.glofox_passcode and the welcome sequence reads it. It is empty
 *     for everyone else, so it is not offered in the editors.
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
 * Build the canonical /unsubscribe/<token> URL for a contact, or
 * NULL if the contact has no unsubscribe token.
 *
 * The token is contact_preferences.unsubscribe_token and nothing
 * else. There is no fallback, and there cannot be one:
 * /api/unsubscribe/[token] resolves `.eq('unsubscribe_token', token)`
 * — that has been the only lookup since the table was created (mig
 * 005), the /unsubscribe/[token] page is a pass-through to it, and
 * /api/preferences/[token] resolves the same column the same way.
 *
 * UNSUBTOKEN.2 — this used to fall back to `contact.id`, under a
 * comment claiming it mirrored "the lookup logic the unsubscribe page
 * already accepts". That comment was wrong on the day it was written
 * (UNSUB.1, 2026-05-13): the two values are independently generated
 * UUIDs, so the fallback produced a URL that could only ever 404 —
 * both as the visible footer link and as the RFC 8058
 * List-Unsubscribe / one-click header built from the same URL. A
 * recipient who could be mailed but could not opt out is the exact
 * failure GDPR and CAN-SPAM care about, and it was silent.
 *
 * Returning null pushes the decision to the caller, which is where it
 * belongs — the two send paths refuse differently (see
 * campaign-sender.js and sequences/steps.js) and neither may quietly
 * ship the mail anyway. Mig 532 backfilled every contact that lacked a
 * preferences row, so this returns null for nobody today; it is the
 * closed door, not the fix for a live outage.
 *
 * The caller provides baseUrl from getAppUrl() so this is
 * unit-testable without env vars.
 *
 * @returns {string|null} the URL, or null when there is no token
 */
export function buildUnsubscribeUrl(contact, baseUrl, locationId, campaignId) {
  const prefs = contact?.contact_preferences?.[0] || contact?.contact_preferences
  const token = prefs?.unsubscribe_token
  if (!token) return null
  // LOCCOMMS.4 — `?l=` scopes the opt-out to the SENDING location, so leaving a
  // Hatch Street list does not silently remove someone from Stillorgan's.
  //
  // OMITTING IT IS MEANINGFUL, NOT A BUG: no `l` = unsubscribe from EVERY
  // location. Emails already delivered carry the old location-less URL and must
  // keep working; someone clicking one expects to be removed, and removing them
  // from everything is the only direction that cannot generate a complaint.
  //
  // COMMSFIX.C.4 — `&c=` names the campaign that carried this link, so
  // /api/unsubscribe/[token] can attribute the opt-out. Without it
  // campaigns.total_unsubscribed only ever moved on Postmark's own
  // SubscriptionChange webhook (spam complaint / hard bounce / manual
  // suppression), never on the primary path: the footer link and Gmail/Apple's
  // one-click button, both of which resolve to our own endpoint. Absent for
  // non-campaign sends (sequence steps) — attribution is per campaign only.
  const params = []
  if (locationId) params.push(`l=${encodeURIComponent(locationId)}`)
  if (campaignId) params.push(`c=${encodeURIComponent(campaignId)}`)
  const query = params.length ? `?${params.join('&')}` : ''
  return `${baseUrl}/unsubscribe/${token}${query}`
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

// LOCCOMMS.3 — map a consent field to its column on contact_location_audience.
//
// The three MARKETING channels are per-location and live on the view as
// loc_*; `email_administrative` deliberately stays GLOBAL (it comes through
// `c.*` unchanged) because transactional mail follows the transaction, not a
// marketing list — you cannot unsubscribe from a booking confirmation.
//
// One place for the mapping so a caller can never half-migrate and gate a
// per-location send on the stale denormalised global column.
const LOCATION_CONSENT_COLUMNS = {
  email_marketing:    'loc_email_marketing',
  sms_marketing:      'loc_sms_marketing',
  whatsapp_marketing: 'loc_whatsapp_marketing',
}

export function consentColumnFor(consentField) {
  return LOCATION_CONSENT_COLUMNS[consentField] || consentField
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
  // LOCCOMMS.3 — reads contact_location_audience (mig 491), NOT contacts.
  // Per-location consent is the authority: a Hatch campaign previously reached
  // only contacts whose ROW sat at Hatch (58 of 81; the other 23 silently
  // unreachable since June). The view INNER-joins contact_location_preferences,
  // so "row absent = that location may never send" is enforced structurally.
  //
  // Still a VIEW and still single-table filtering, deliberately. CLASSIFY.1
  // (below) moved this off an inner-join on contact_preferences because
  // PostgREST embedded-resource filters silently break head:true counts — a
  // wrong count here is a campaign that under- or over-sends with no error.
  let query = db
    .from('contact_location_audience')
    .select(columns, selectOpts)
    .eq('audience_location_id', locationId)
    .eq(consentColumnFor(assertConsentField(consentField)), true)
    .not('email_status', 'in', '("bounced","complained")')

  // NOENGSUP.1 — the MARKETING path additionally excludes contacts carrying
  // email_suppressed_at. That stamp used to mean either "90-day non-opener" or
  // "repeat bounces"; the engagement rule is retired (mig 537) because not
  // opening is a preference, not a dead address, so it now means repeat
  // bounces ONLY, always with an email_bounce_escalations row (mig 515) behind
  // it. The administrative path is never suppression-gated: transactional mail
  // must always reach the contact.
  if (consentField === 'email_marketing') {
    query = query.is('email_suppressed_at', null)
  }

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
  // LOCCOMMS.3 — same per-location cutover as buildAudienceQuery above. This is
  // the builder the LIVE send path (campaign-sender.js) actually calls.
  let query = db
    .from('contact_location_audience')
    .select(columns, selectOpts)
    .eq('audience_location_id', locationId)
    .eq(consentColumnFor(assertConsentField(consentField)), true)
    .not('email_status', 'in', '("bounced","complained")')
  // EMAIL-HYGIENE.1 — same marketing-only inactivity-suppression gate as
  // buildAudienceQuery above (email_suppressed_at, mig 395).
  if (consentField === 'email_marketing') {
    query = query.is('email_suppressed_at', null)
  }
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
  // INTEG-B3 — one service client, reused for the tenant-sender lookup and
  // the email_sends insert. The sender resolves to the global default when
  // there is no live tenant email domain (every org today) → byte-identical
  // send, and from_email logs the ACTUAL From used.
  const db = (contactId || locationId) ? createServerClient() : null
  const sender = locationId ? await resolveEmailSender(db, locationId) : null

  const result = await sendEmail({
    to,
    subject,
    htmlBody,
    stream: 'outbound',  // Postmark transactional stream
    tag: tag || 'transactional',
    sender: sender || undefined,
    // POSTMARK-RACE.1 — the marker is stamped on EXACTLY the condition the
    // email_sends insert below is gated on. `contactId` falsy means this send
    // is deliberately unlogged (an ops alert, a staff notice, a race
    // confirmation for a payer with no contact), and marking it would promise
    // the webhook processor a row that is never coming.
    metadata: contactId ? withSendMarker() : undefined,
  })

  // Log to email_sends
  if (contactId) {
    await db.from('email_sends').insert({
      contact_id: contactId,
      location_id: locationId,
      source_type: sourceType,
      sequence_id: sequenceId,
      sequence_step_id: sequenceStepId,
      subject,
      from_email: sender?.fromEmail || process.env.POSTMARK_FROM_EMAIL,
      to_email: to,
      postmark_message_id: result.messageId,
      postmark_stream: 'outbound',
      status: 'sent',
    })
  }

  return result
}

/**
 * EMAIL-MAILBOX-ADMIN.1 — the address of a location's DEFAULT email account
 * (email_mailboxes, mig 485), or null.
 *
 * `is_default` was documented from the start as "the address stamped as
 * Reply-To on campaign + marketing sends" (mig 485's own COMMENT), but until
 * the account editor shipped nothing could set it, so the send paths still
 * read the column it replaced. Now that an operator can choose the default,
 * the default is what they get.
 *
 * Active only: a deactivated account stops accepting inbound, so stamping it
 * as Reply-To would invite customers to write to an address whose mail
 * dead-letters.
 *
 * Takes the caller's client rather than making one — the send paths already
 * hold a service-role client, and this runs per campaign tick.
 */
export async function getDefaultMailboxAddress(db, locationId) {
  if (!db || !locationId) return null
  try {
    const { data } = await db.from('email_mailboxes')
      .select('address')
      .eq('location_id', locationId)
      .eq('is_default', true)
      .eq('active', true)
      .limit(1)
      .maybeSingle()
    return data?.address || null
  } catch {
    return null
  }
}

/**
 * EMAIL-INBOX.1 — the location's inbound-inbox address. When set, campaign +
 * marketing sends stamp it as Reply-To so customer replies route back in via
 * /api/webhooks/postmark-inbound. Returns null when unset or on any error
 * (callers treat it as best-effort).
 *
 * The default email_mailboxes row wins; locations.email_inbox_reply_to (mig
 * 394, DEPRECATED by mig 485) is the fallback, kept because it still holds a
 * live value for studios configured before the accounts model and nothing
 * writes it any more. A studio with no default account and no legacy column
 * gets null — replies then go to the sending address, exactly as before.
 */
export async function getLocationInboxReplyTo(locationId) {
  if (!locationId) return null
  try {
    const db = createServerClient()
    const fromMailbox = await getDefaultMailboxAddress(db, locationId)
    if (fromMailbox) return fromMailbox
    const { data } = await db.from('locations')
      .select('email_inbox_reply_to')
      .eq('id', locationId)
      .maybeSingle()
    return data?.email_inbox_reply_to || null
  } catch {
    return null
  }
}

/**
 * COMMS-AUDIT 2026-07-10 (SEQ batch) — marketing sibling of
 * sendTransactionalEmail for single sends that are MARKETING mail
 * (sequence step emails: welcome / nurture / win-back).
 *
 * Why a separate helper: sendEmail only attaches the RFC 8058
 * List-Unsubscribe / List-Unsubscribe-Post one-click headers when
 * stream === 'broadcast', so marketing mail routed through
 * sendTransactionalEmail (stream 'outbound') shipped with no header
 * unsubscribe at all — a Gmail/Yahoo bulk-sender compliance gap —
 * and polluted the transactional stream's reputation. This helper
 * rides the broadcast stream (same as campaign sends) and logs to
 * email_sends with postmark_stream='broadcast' plus the same atomic
 * sequence attribution as sendTransactionalEmail (see that
 * function's race-with-the-open-webhook note).
 *
 * Callers still own the consent gate + the visible unsubscribe
 * footer (applyMergeTags/appendUnsubscribeFooter) — pass the
 * per-contact unsubscribeUrl so the one-click headers are attached.
 */
export async function sendMarketingEmail({
  to, subject, htmlBody, contactId, locationId, tag, unsubscribeUrl, replyTo,
  sourceType = 'sequence', sequenceId = null, sequenceStepId = null,
}) {
  // EMAIL-INBOX.1 — marketing sends default their Reply-To to the
  // location's inbound-inbox address so replies land in the unified
  // inbox instead of an external mailbox. Best-effort: a lookup
  // failure sends with no Reply-To rather than failing the send.
  let resolvedReplyTo = replyTo
  if (!resolvedReplyTo && locationId) {
    resolvedReplyTo = await getLocationInboxReplyTo(locationId)
  }

  // INTEG-B3 — one service client, reused for the tenant-sender lookup and
  // the email_sends insert. Global default when no live tenant domain
  // exists (every org today) → byte-identical send + honest from_email.
  const db = (contactId || locationId) ? createServerClient() : null
  const sender = locationId ? await resolveEmailSender(db, locationId) : null

  const result = await sendEmail({
    to,
    subject,
    htmlBody,
    replyTo: resolvedReplyTo || undefined,
    stream: 'broadcast',  // Postmark marketing stream — attaches List-Unsubscribe headers
    tag: tag || 'marketing',
    unsubscribeUrl,
    sender: sender || undefined,
    // POSTMARK-RACE.1 — same pairing as sendTransactionalEmail: marked iff the
    // insert below will run.
    metadata: contactId ? withSendMarker() : undefined,
  })

  // Log to email_sends (same shape as the campaign + transactional paths).
  if (contactId) {
    await db.from('email_sends').insert({
      contact_id: contactId,
      location_id: locationId,
      source_type: sourceType,
      sequence_id: sequenceId,
      sequence_step_id: sequenceStepId,
      subject,
      from_email: sender?.fromEmail || process.env.POSTMARK_FROM_EMAIL,
      to_email: to,
      postmark_message_id: result.messageId,
      postmark_stream: 'broadcast',
      status: 'sent',
    })
  }

  return result
}

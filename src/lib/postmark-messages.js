// HOST-METRICS.1 — Postmark Messages API client.
//
// READ-ONLY. This module never sends, suppresses, or mutates anything at
// Postmark — it only reads back what was already sent, for the host-metrics
// backfill to reconcile against our own send records. Postmark retains
// message history for 45 days, so the backfill that calls this must run on
// that cadence or it silently loses the tail of the window.
//
// Mirrors postmark-suppressions.js: a module-local API base URL, a header
// builder that returns null instead of throwing on a missing token, and every
// export returns a `{…, error}` shape rather than throwing. A throw here would
// fail the backfill job outright for a problem (a Postmark hiccup, an expired
// token) that should instead surface as a reconciliation gap to look at later.
//
// API SHAPE (https://postmarkapp.com/developer/api/messages-api):
//   list     GET /messages/outbound?count=&offset=&tag=&fromdate=&todate=
//            → { TotalCount, Messages: [{ MessageID, Recipients, Tag,
//                Metadata, ReceivedAt, Status, … }] }
//   details  GET /messages/outbound/{id}/details
//            → { MessageID, MessageEvents: [{ Type: 'Delivered' | 'Opened' |
//                'LinkClicked' | 'Bounced' | 'SubscriptionChanged' |
//                'Transient', ReceivedAt, Details }], … }
//
// BOUNCE LOG (https://postmarkapp.com/developer/api/bounce-api), separate
// from the messages API above and read via listBounces(): the message-
// details timeline's Bounced event carries no bounce type (Details is just
// { Summary, BounceID }), and spam complaints never appear in the timeline
// at all. Both live only here, matched back onto a message by MessageID.
//   list     GET /bounces?count=&offset=&tag=&fromdate=&todate=
//            → { TotalCount, Bounces: [{ ID, Type: 'HardBounce' |
//                'SoftBounce' | 'Transient' | 'SpamComplaint' | …, TypeCode,
//                MessageID, Email, BouncedAt, Inactive, … }] }

import { resolvePostmarkToken } from './postmark-token'

const POSTMARK_API_URL = 'https://api.postmarkapp.com'

const errMessage = (err) => err?.message || String(err)

/**
 * Headers for a Postmark call, or null when no server token is configured.
 * Never throws — same posture as postmark-suppressions.js's postmarkHeaders,
 * because this runs inside a best-effort backfill, not a transactional send.
 */
function postmarkHeaders() {
  const token = resolvePostmarkToken()
  if (!token) return null
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Postmark-Server-Token': token,
  }
}

/**
 * List outbound messages, most recent send activity first.
 *
 * @param {{tag?: string, fromDate?: string, toDate?: string, count?: number, offset?: number}} [opts]
 *   fromDate/toDate are Postmark's own 'YYYY-MM-DD' (or full ISO) strings,
 *   passed through unvalidated. count/offset default to 500/0 (Postmark's
 *   own max page size).
 * @returns {Promise<{total: number, messages: Array<Object>, error: string|null}>}
 *   Never throws.
 */
export async function listOutboundMessages({ tag, fromDate, toDate, count = 500, offset = 0 } = {}) {
  const headers = postmarkHeaders()
  if (!headers) {
    console.error('[postmark-messages] no Postmark server token configured — cannot list outbound messages')
    return { total: 0, messages: [], error: 'Postmark API token not configured' }
  }

  const params = new URLSearchParams()
  params.set('count', String(count))
  params.set('offset', String(offset))
  if (tag !== undefined && tag !== null) params.set('tag', tag)
  if (fromDate !== undefined && fromDate !== null) params.set('fromdate', fromDate)
  if (toDate !== undefined && toDate !== null) params.set('todate', toDate)
  const url = `${POSTMARK_API_URL}/messages/outbound?${params.toString()}`

  try {
    const response = await fetch(url, { method: 'GET', headers })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const error = payload?.Message || `Postmark messages list failed (HTTP ${response.status})`
      console.error(`[postmark-messages] list failed: ${error}`)
      return { total: 0, messages: [], error }
    }
    if (!payload || typeof payload !== 'object') {
      const error = 'Postmark returned an unreadable response'
      console.error(`[postmark-messages] list failed: ${error}`)
      return { total: 0, messages: [], error }
    }
    return {
      total: Number(payload?.TotalCount) || 0,
      messages: Array.isArray(payload?.Messages) ? payload.Messages : [],
      error: null,
    }
  } catch (err) {
    const error = errMessage(err)
    console.error(`[postmark-messages] list threw: ${error}`)
    return { total: 0, messages: [], error }
  }
}

/**
 * List bounce-log records (hard/soft bounces, transient failures, spam
 * complaints) — the source of truth for bounce type and complaints, neither
 * of which the message-details timeline carries (see BOUNCE LOG note above).
 *
 * @param {{tag?: string, fromDate?: string, toDate?: string, count?: number, offset?: number}} [opts]
 * @returns {Promise<{total: number, bounces: Array<Object>, error: string|null}>}
 *   Never throws.
 */
export async function listBounces({ tag, fromDate, toDate, count = 500, offset = 0 } = {}) {
  const headers = postmarkHeaders()
  if (!headers) {
    console.error('[postmark-messages] no Postmark server token configured — cannot list bounces')
    return { total: 0, bounces: [], error: 'Postmark API token not configured' }
  }

  const params = new URLSearchParams()
  params.set('count', String(count))
  params.set('offset', String(offset))
  if (tag !== undefined && tag !== null) params.set('tag', tag)
  if (fromDate !== undefined && fromDate !== null) params.set('fromdate', fromDate)
  if (toDate !== undefined && toDate !== null) params.set('todate', toDate)
  const url = `${POSTMARK_API_URL}/bounces?${params.toString()}`

  try {
    const response = await fetch(url, { method: 'GET', headers })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const error = payload?.Message || `Postmark bounces list failed (HTTP ${response.status})`
      console.error(`[postmark-messages] bounces list failed: ${error}`)
      return { total: 0, bounces: [], error }
    }
    if (!payload || typeof payload !== 'object') {
      const error = 'Postmark returned an unreadable response'
      console.error(`[postmark-messages] bounces list failed: ${error}`)
      return { total: 0, bounces: [], error }
    }
    return {
      total: Number(payload?.TotalCount) || 0,
      bounces: Array.isArray(payload?.Bounces) ? payload.Bounces : [],
      error: null,
    }
  } catch (err) {
    const error = errMessage(err)
    console.error(`[postmark-messages] bounces list threw: ${error}`)
    return { total: 0, bounces: [], error }
  }
}

/**
 * Fetch the full event history for one outbound message — deliveries, opens,
 * link clicks, bounces, subscription changes.
 *
 * @param {string} messageId
 * @returns {Promise<{details: Object|null, error: string|null}>} Never throws.
 */
export async function getOutboundMessageDetails(messageId) {
  const headers = postmarkHeaders()
  if (!headers) {
    console.error('[postmark-messages] no Postmark server token configured — cannot fetch message details')
    return { details: null, error: 'Postmark API token not configured' }
  }

  const url = `${POSTMARK_API_URL}/messages/outbound/${encodeURIComponent(messageId)}/details`

  try {
    const response = await fetch(url, { method: 'GET', headers })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const error = payload?.Message || `Postmark message details failed (HTTP ${response.status})`
      console.error(`[postmark-messages] details failed for ${messageId}: ${error}`)
      return { details: null, error }
    }
    if (!payload || typeof payload !== 'object') {
      const error = 'Postmark returned an unreadable response'
      console.error(`[postmark-messages] details failed for ${messageId}: ${error}`)
      return { details: null, error }
    }
    return { details: payload, error: null }
  } catch (err) {
    const error = errMessage(err)
    console.error(`[postmark-messages] details threw for ${messageId}: ${error}`)
    return { details: null, error }
  }
}

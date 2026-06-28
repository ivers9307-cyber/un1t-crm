// /api/webhooks/twilio/status
//
// Twilio POSTs here as the lifecycle of a message changes:
//   queued -> sending -> sent -> delivered  (happy path)
//   ... -> undelivered                       (carrier rejected post-accept)
//   ... -> failed                            (Twilio-side failure)
//
// We only update sms_broadcast_recipients rows — ad-hoc / sequence /
// event-reminder sends don't pass a StatusCallback URL, so they never
// hit this route. The query params identify which row to update:
//   ?b=<broadcast_id>&c=<contact_id>
//
// The route is public (Twilio can't authenticate with a Bearer), so
// we verify the request via Twilio's HMAC-SHA1 signature in the
// X-Twilio-Signature header. Spec:
//   https://www.twilio.com/docs/usage/webhooks/webhooks-security
// Algorithm:
//   1. Take the FULL public URL Twilio posted to (incl. query string)
//   2. Append every form POST param's name+value, sorted by name
//   3. HMAC-SHA1 with TWILIO_AUTH_TOKEN
//   4. Base64 encode
//   5. Constant-time compare to the X-Twilio-Signature header
//
// Idempotency: Twilio may deliver the same status more than once
// (at-least-once semantics). We check the recipient's CURRENT status
// before flipping + incrementing the broadcast counter, so a replay
// is a no-op rather than a double count.

import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createServerClient } from '@/lib/supabase'
import { getAppUrl } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Verify a Twilio webhook signature. Returns true iff the
 * X-Twilio-Signature matches the expected HMAC of url + sorted
 * params with the auth token.
 *
 * Pure — exported for unit tests in twilio-status.test.js.
 *
 * @param {object} args
 * @param {string} args.authToken
 * @param {string} args.url           — the full URL Twilio posted to (incl. query)
 * @param {Record<string, string>} args.params  — parsed form-body fields
 * @param {string} args.signature     — value of the X-Twilio-Signature header
 * @returns {boolean}
 */
export function verifyTwilioSignature({ authToken, url, params, signature }) {
  if (!authToken || !signature) return false
  // Per Twilio spec: take the URL, then for each form-POST key in
  // alphabetical order, concatenate key + value (no separators).
  const sortedKeys = Object.keys(params || {}).sort()
  let payload = url
  for (const k of sortedKeys) payload += k + (params[k] ?? '')
  const expected = crypto
    .createHmac('sha1', authToken)
    .update(payload)
    .digest('base64')
  // Constant-time compare to defeat timing attacks.
  if (expected.length !== signature.length) return false
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signature),
  )
}

// Twilio's lifecycle states. We only care about the terminal ones —
// 'queued' / 'sending' fire frequently and don't tell us anything
// the recipient didn't already get from their app status.
const TERMINAL_STATES = new Set(['delivered', 'undelivered', 'failed', 'sent'])

export async function POST(request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN
  if (!authToken) {
    console.warn('[twilio-status] TWILIO_AUTH_TOKEN not set — cannot verify signature, rejecting')
    return NextResponse.json({ success: false, error: 'Server misconfigured' }, { status: 500 })
  }

  // Parse form body (Twilio always sends application/x-www-form-urlencoded).
  const text = await request.text()
  const formParams = Object.fromEntries(new URLSearchParams(text).entries())

  // Reconstruct the URL Twilio signed against. Use NEXT_PUBLIC_APP_URL
  // as the trusted base — the request.url Next gives us reflects the
  // raw incoming Host header which a malicious caller could spoof, so
  // signing against THAT would let them sign their own forgeries.
  let signedUrl
  try {
    const base = getAppUrl()
    const incoming = new URL(request.url)
    signedUrl = `${base.replace(/\/$/, '')}${incoming.pathname}${incoming.search}`
  } catch {
    return NextResponse.json({ success: false, error: 'NEXT_PUBLIC_APP_URL not configured' }, { status: 500 })
  }

  const signature = request.headers.get('x-twilio-signature') || ''
  const ok = verifyTwilioSignature({ authToken, url: signedUrl, params: formParams, signature })
  if (!ok) {
    console.warn(`[twilio-status] signature verification failed for ${signedUrl}`)
    return NextResponse.json({ success: false, error: 'Invalid signature' }, { status: 401 })
  }

  const messageStatus = formParams.MessageStatus || formParams.SmsStatus
  const messageSid = formParams.MessageSid
  const errorCode = formParams.ErrorCode || null
  const errorMessage = formParams.ErrorMessage || null

  if (!messageStatus || !messageSid) {
    return NextResponse.json({ success: true, message: 'no-op (missing status)' })
  }

  if (!TERMINAL_STATES.has(messageStatus)) {
    // queued / sending / accepted — ignore. Avoids extra writes for
    // updates we don't surface in the UI.
    return NextResponse.json({ success: true, message: `ignored interim status: ${messageStatus}` })
  }

  // Locate the recipient row. Prefer the query-string identifiers we
  // set at send time (cheaper than a SID lookup); fall back to
  // searching by SID if the params are missing or stale.
  const url = new URL(request.url)
  const broadcastId = url.searchParams.get('b') || null
  const contactId = url.searchParams.get('c') || null

  const db = createServerClient()
  let { data: recipient } = broadcastId && contactId
    ? await db
        .from('sms_broadcast_recipients')
        .select('id, broadcast_id, contact_id, status')
        .eq('broadcast_id', broadcastId)
        .eq('contact_id', contactId)
        .maybeSingle()
    : { data: null }

  if (!recipient && messageSid) {
    const fallback = await db
      .from('sms_broadcast_recipients')
      .select('id, broadcast_id, contact_id, status')
      .eq('twilio_message_sid', messageSid)
      .maybeSingle()
    recipient = fallback.data || null
  }

  if (!recipient) {
    // Not a broadcast send (likely ad-hoc / sequence / event reminder
    // that didn't pass a status callback URL). Acknowledge with 200 so
    // Twilio stops retrying.
    return NextResponse.json({ success: true, message: 'not a broadcast recipient' })
  }

  // Idempotency: only flip + increment when this is a state we
  // haven't recorded. 'sent' is already set by the send loop, so we
  // skip it. 'delivered' / 'undelivered' / 'failed' are terminal.
  if (recipient.status === messageStatus) {
    return NextResponse.json({ success: true, message: 'already in target state' })
  }

  // Refuse to overwrite a more-terminal state with a less-terminal
  // one. e.g. if we somehow already recorded 'delivered' and Twilio
  // sends a late 'sent', leave the row alone.
  const ORDER = { pending: 0, sent: 1, delivered: 2, undelivered: 2, failed: 2 }
  if ((ORDER[messageStatus] ?? 0) <= (ORDER[recipient.status] ?? 0) && messageStatus === 'sent') {
    return NextResponse.json({ success: true, message: 'ignoring backwards transition' })
  }

  const updates = { status: messageStatus }
  if (messageStatus === 'delivered') updates.delivered_at = new Date().toISOString()
  if (messageStatus === 'undelivered') {
    updates.undelivered_at = new Date().toISOString()
    if (errorMessage || errorCode) {
      updates.error_message = errorMessage
        ? `Twilio ${errorCode || ''}: ${errorMessage}`.trim()
        : `Twilio code ${errorCode}`
    }
  }
  if (messageStatus === 'failed') {
    updates.failed_at = new Date().toISOString()
    if (errorMessage || errorCode) {
      updates.error_message = errorMessage
        ? `Twilio ${errorCode || ''}: ${errorMessage}`.trim()
        : `Twilio code ${errorCode}`
    }
  }

  await db.from('sms_broadcast_recipients').update(updates).eq('id', recipient.id)

  // Bump the per-broadcast counter for the analytics UI. Atomic via
  // the SQL function — the webhook may run concurrently for the same
  // broadcast and we don't want a read-modify-write race.
  if (messageStatus === 'delivered') {
    await db.rpc('increment_sms_broadcast_delivered', { p_broadcast_id: recipient.broadcast_id })
  } else if (messageStatus === 'undelivered') {
    await db.rpc('increment_sms_broadcast_undelivered', { p_broadcast_id: recipient.broadcast_id })
  } else if (messageStatus === 'failed') {
    // 'failed' = Twilio never sent it. A recipient the send loop already
    // counted as 'sent' that now fails must move OUT of total_sent and INTO
    // total_failed, or the broadcast's "sent" figure permanently over-counts
    // async failures. The early `recipient.status === messageStatus` guard
    // (above) makes this fire at most once per recipient. (mig 332 RPC.)
    await db.rpc('increment_sms_broadcast_metric', { p_broadcast_id: recipient.broadcast_id, p_metric: 'total_failed', p_delta: 1 })
    if (recipient.status === 'sent') {
      await db.rpc('increment_sms_broadcast_metric', { p_broadcast_id: recipient.broadcast_id, p_metric: 'total_sent', p_delta: -1 })
    }
  }
  // Note: total_sent / total_failed are otherwise written by the send loop
  // (sms.js#sendBroadcast) at send time; here we only correct an async
  // sent→failed transition Twilio reports after the loop has finished.

  return NextResponse.json({ success: true, status: messageStatus })
}

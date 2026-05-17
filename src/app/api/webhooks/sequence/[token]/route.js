// /api/webhooks/sequence/[token] — inbound receiver for the FLOW2
// webhook trigger (mig 131). External systems (n8n / Glofox /
// Stripe / Zapier / anything that can POST JSON) hit this URL
// to enrol a contact into a webhook-triggered sequence.
//
// Auth model:
//   1. Token in URL — 32-char hex, unique per sequence, generated
//      server-side. Unguessable; effectively a bearer credential
//      in URL form.
//   2. (Optional) Shared secret in X-Webhook-Secret header. When
//      sequences.webhook_secret is set, the receiver constant-
//      time-compares it. If unset, the URL token is the only auth.
//   3. Rate limit: 100 requests / minute per token. Generous for
//      legitimate use, tight enough that a leaked token can't be
//      used to spam-enrol thousands of contacts.
//
// Request body (JSON):
//   {
//     "contact_email": "user@example.com",   // OR
//     "contact_id":    "uuid",
//     "source_ref":    "external-id-123"     // optional, for audit
//   }
//
// Response (200 on success):
//   { success: true, enrolled: 1 | 0, contact_id: "...",
//     sequence_id: "..." }
//
// Failure modes:
//   400 — body missing contact_email/contact_id, or both invalid
//   401 — wrong/missing X-Webhook-Secret when secret is configured
//   404 — token doesn't match any sequence (we ALSO 404 on
//         secret mismatch to avoid leaking that the URL exists)
//   409 — contact found but not in the sequence's location
//   429 — rate-limited
//
// We never throw past the catch — webhook senders typically retry
// on 5xx, so any unexpected error returns 500 with a generic
// message rather than crashing the runtime.

import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { enrolContacts } from '@/lib/sequences/enrol'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 32-char hex token format. Anything else is an obvious 404 — saves
// a DB roundtrip on garbage URLs / scanners.
const TOKEN_RE = /^[a-f0-9]{32}$/

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export async function POST(request, props) {
  const params = await props.params;
  const token = String(params?.token || '')
  if (!TOKEN_RE.test(token)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const db = createServerClient()

  // Rate-limit per token (not per IP) so a single sender hitting
  // the URL legitimately many times still gets blocked when their
  // pattern abuses the endpoint, while different operators on
  // different sequences don't compete for the same bucket.
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `webhook-sequence:${token}`, { max: 100, windowMs: 60_000 })
  if (!limit.allowed) {
    return rateLimitResponse(limit, 'Rate limit exceeded for this webhook URL.')
  }

  // Look up the sequence. 404 if no match — leaking "this token
  // exists but is paused" would help an attacker enumerate.
  const { data: seq, error: lookupErr } = await db
    .from('email_sequences')
    .select('id, location_id, status, trigger_type, webhook_secret, name')
    .eq('webhook_token', token)
    .maybeSingle()
  if (lookupErr) {
    logWarn('webhook-sequence', 'lookup error', { err: lookupErr.message, ip })
    return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 })
  }
  if (!seq) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  // Optional shared-secret verification. Same 404 as a missing
  // token — don't tell the caller that the URL is valid but the
  // secret isn't.
  if (seq.webhook_secret) {
    const provided = request.headers.get('x-webhook-secret') || ''
    if (!constantTimeEqual(provided, seq.webhook_secret)) {
      logWarn('webhook-sequence', 'secret mismatch', { sequence_id: seq.id, ip })
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
  }

  // Sequence status guard — don't enrol into draft / paused /
  // archived sequences. Return 200 with enrolled=0 so the
  // sender doesn't keep retrying.
  if (seq.status !== 'active') {
    return NextResponse.json({
      success: true, enrolled: 0,
      sequence_id: seq.id, status: seq.status,
      message: `Sequence is ${seq.status}; webhook accepted but no contact enrolled.`,
    })
  }

  // Parse + validate body — must contain contact_email or contact_id.
  let body
  try { body = await request.json() } catch { body = {} }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ success: false, error: 'Body must be JSON object' }, { status: 400 })
  }
  const email = typeof body.contact_email === 'string' ? body.contact_email.trim().toLowerCase() : null
  const contactId = typeof body.contact_id === 'string' ? body.contact_id.trim() : null
  const sourceRef = typeof body.source_ref === 'string' ? body.source_ref.slice(0, 200) : null
  if (!email && !contactId) {
    return NextResponse.json({
      success: false,
      error: 'Body must include contact_email or contact_id',
    }, { status: 400 })
  }

  // Find the contact, scoped to the sequence's location (so a
  // leaked token can't enrol a contact from a different
  // location's CRM into your sequence).
  let lookupQuery = db.from('contacts')
    .select('id, location_id, email')
    .eq('location_id', seq.location_id)
    .limit(1)
  if (contactId) {
    lookupQuery = lookupQuery.eq('id', contactId)
  } else {
    lookupQuery = lookupQuery.eq('email', email)
  }
  const { data: contactRows, error: contactErr } = await lookupQuery
  if (contactErr) {
    logWarn('webhook-sequence', 'contact lookup error', { err: contactErr.message, sequence_id: seq.id })
    return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 })
  }
  const contact = contactRows?.[0]
  if (!contact) {
    return NextResponse.json({
      success: false,
      error: 'Contact not found in this sequence\'s location',
    }, { status: 404 })
  }

  // Enrol — same code path the in-CRM triggers (booking_created,
  // anniversary, etc.) use. Dedup + cooldown gates handled there.
  try {
    const result = await enrolContacts({
      sequenceId: seq.id,
      contactIds: [contact.id],
      sourceType: 'webhook',
      sourceRef: sourceRef || token.slice(0, 8) + '-' + Date.now(),
    })
    return NextResponse.json({
      success: true,
      enrolled: result.enrolled,
      skipped: result.skipped,
      contact_id: contact.id,
      sequence_id: seq.id,
    })
  } catch (e) {
    logWarn('webhook-sequence', 'enrol error', { err: e?.message || String(e), sequence_id: seq.id, contact_id: contact.id })
    return NextResponse.json({ success: false, error: 'Enrolment failed' }, { status: 500 })
  }
}

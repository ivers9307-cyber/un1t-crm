// EMAIL-INBOX.1 — Postmark inbound webhook for the unified inbox's
// email channel.
//
// Postmark's inbound stream POSTs every email received on the inbound
// address here. We thread it into email_conversations /
// email_inbox_messages (mig 394) so it shows up alongside WhatsApp +
// Instagram at /communications/inbox.
//
// Auth — token-in-URL pattern (same as invoices-inbound): Postmark's
// inbound webhook config only lets you set a URL, not custom headers,
// so the shared secret lives in the path. Configure Postmark to POST
// to https://crm.un1tdublin.com/api/webhooks/postmark-inbound/<token>
// where <token> = POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN. Rotation via
// POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN_PREVIOUS, then unset PREVIOUS.
// Wrong token 404s (not 403) so the URL pattern can't be probed.
//
// Threading resolution (helpers in src/lib/email-inbox.js):
//   (a) In-Reply-To / References ids matched against
//       email_sends.postmark_message_id → that send's contact +
//       location (a reply to OUR campaign/sequence mail — the
//       highest-signal path).
//   (b) else From address → contacts by email. Location comes from
//       the recipient address (locations.email_inbox_reply_to match)
//       when derivable; contact pick is deterministic (location match
//       preferred, then oldest created_at).
//   (c) unmatched sender → conversation with contact_id NULL at the
//       recipient-matched location, falling back to the oldest active
//       location (deterministic default for single-inbound-address
//       estates).
//
// Conversation model: one per (location, counterpart email) — see the
// mig 394 header. New inbound clears resolved_at (re-enters the
// Needs-reply queue) and bumps unread atomically.
//
// Why no queue table (unlike the outbound Postmark webhook): inbound
// human replies are low-volume (no 5k-in-20s bursts) and each event
// creates rows regardless — deferring would just add a hop. Same
// reasoning as invoices-inbound.
//
// Idempotency: recordWebhookEvent on Postmark's MessageID, plus the
// unique index on email_inbox_messages.postmark_message_id as the
// belt-and-braces layer.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifySharedSecret } from '@/lib/webhook-auth'
import { recordWebhookEvent, WEBHOOK_PROVIDERS } from '@/lib/webhook-events'
import { htmlToPlainText } from '@/lib/email-content'
import {
  normalizeEmail,
  getHeader,
  extractCandidateMessageIds,
  extractRfcMessageId,
  recipientEmails,
  matchLocationByRecipient,
  pickContact,
  inboundPreview,
  truncateHtmlBody,
} from '@/lib/email-inbox'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Token-in-URL auth — timing-safe compare against the primary and the
 * optional rotation token. Exported for the guard's benefit and so a
 * route test can exercise the gate without a request fixture. Mirrors
 * verifyInboundRequest in the invoices-inbound webhook.
 */
export function verifyEmailInboundRequest({ urlToken, primarySecret, previousSecret }) {
  if (!primarySecret) return { ok: false, status: 500, reason: 'missing_secret' }
  if (!urlToken) return { ok: false, status: 404, reason: 'missing_token' }
  const primary = verifySharedSecret(urlToken, primarySecret)
  if (primary.ok) return { ok: true, matched: 'primary' }
  if (previousSecret) {
    const previous = verifySharedSecret(urlToken, previousSecret)
    if (previous.ok) return { ok: true, matched: 'previous' }
  }
  return { ok: false, status: 404, reason: 'token_mismatch' }
}

// Chunk .in() candidate lists defensively (header chains can be long).
const MAX_THREAD_CANDIDATES = 40

export async function POST(request, { params }) {
  const { token } = await params
  const auth = verifyEmailInboundRequest({
    urlToken: token,
    primarySecret: process.env.POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN,
    previousSecret: process.env.POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN_PREVIOUS,
  })
  if (!auth.ok) {
    if (auth.reason === 'missing_secret') {
      console.error('[security] POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN not set — refusing inbound email webhook.')
    } else {
      console.warn(`[security] Inbound email webhook rejected: ${auth.reason}`)
    }
    return NextResponse.json({ success: false, error: auth.reason }, { status: auth.status })
  }
  if (auth.matched === 'previous') {
    console.warn(
      '[security] Inbound email webhook accepted via POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN_PREVIOUS — ' +
      'finish rotating the Postmark inbound URL to the new token, then unset PREVIOUS.'
    )
  }

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'invalid_json' }, { status: 400 })
  }

  const messageId = body?.MessageID
  if (!messageId) {
    return NextResponse.json({ success: false, error: 'Missing MessageID' }, { status: 400 })
  }

  const db = createServerClient()

  // Idempotency — Postmark retries on 5xx; don't double-thread.
  const dedup = await recordWebhookEvent({
    db, provider: WEBHOOK_PROVIDERS.POSTMARK,
    eventId: `inbound-email:${messageId}`,
  })
  if (dedup.seen) {
    return NextResponse.json({ success: true, deduped: true })
  }

  const fromEmail = normalizeEmail(body.FromFull?.Email || body.From)
  if (!fromEmail) {
    // A real email always has a sender; without one there is nothing to
    // thread. 200 so Postmark doesn't retry an unfixable payload.
    console.warn('[postmark-inbound] no parseable From address', { messageId })
    return NextResponse.json({ success: true, ignored: 'no_sender' })
  }

  // ── Threading resolution ──────────────────────────────────────────
  const headers = Array.isArray(body.Headers) ? body.Headers : []
  let contactId = null
  let locationId = null
  let matchedVia = 'unmatched'

  // (a) Reply to one of OUR sends — In-Reply-To/References ↔ email_sends.
  const candidates = extractCandidateMessageIds(headers).slice(0, MAX_THREAD_CANDIDATES)
  if (candidates.length) {
    const { data: sends, error: sendsErr } = await db.from('email_sends')
      .select('contact_id, location_id, postmark_message_id, sent_at')
      .in('postmark_message_id', candidates)
      .order('sent_at', { ascending: false })
      .limit(1)
    if (sendsErr) {
      console.error('[postmark-inbound] email_sends lookup failed:', sendsErr.message)
      return NextResponse.json({ success: false, error: 'thread_lookup_failed' }, { status: 500 })
    }
    const send = sends?.[0]
    if (send) {
      contactId = send.contact_id || null
      locationId = send.location_id || null
      matchedVia = 'in_reply_to'
    }
  }

  // Recipient address → location (locations.email_inbox_reply_to).
  // Also the (c) default-location resolver. Small table — match in JS.
  if (!locationId) {
    const { data: locations, error: locErr } = await db.from('locations')
      .select('id, email_inbox_reply_to, active, created_at')
      .eq('active', true)
      .order('created_at', { ascending: true })
    if (locErr) {
      console.error('[postmark-inbound] locations lookup failed:', locErr.message)
      return NextResponse.json({ success: false, error: 'location_lookup_failed' }, { status: 500 })
    }
    const byRecipient = matchLocationByRecipient(locations || [], recipientEmails(body))
    if (byRecipient) {
      locationId = byRecipient.id
      matchedVia = matchedVia === 'unmatched' ? 'recipient_address' : matchedVia
    } else {
      // Deterministic default: the oldest active location. Correct for a
      // single-inbound-address estate (today: one live studio); once each
      // location has its own inbound address the recipient match wins.
      locationId = locations?.[0]?.id || null
    }
  }

  // (b) From address → contacts (deterministic pick; prefer the
  // resolved location). Runs even when (a) matched but the send had no
  // contact — and fills contact linkage for recipient-only matches.
  if (!contactId) {
    const { data: contacts, error: cErr } = await db.from('contacts')
      .select('id, location_id, created_at')
      .ilike('email', fromEmail)
      .limit(50)
    if (cErr) {
      console.error('[postmark-inbound] contacts lookup failed:', cErr.message)
      return NextResponse.json({ success: false, error: 'contact_lookup_failed' }, { status: 500 })
    }
    const picked = pickContact(contacts || [], locationId)
    if (picked) {
      contactId = picked.id
      if (!locationId) locationId = picked.location_id
      if (matchedVia === 'unmatched') matchedVia = 'from_address'
    }
  }

  if (!locationId) {
    // No active locations at all — nothing to attach to. 200: retrying
    // won't conjure a location.
    console.error('[postmark-inbound] no location resolvable (no active locations?)', { messageId })
    return NextResponse.json({ success: true, ignored: 'no_location' })
  }

  // ── Upsert conversation (one per location + counterpart email) ────
  const { data: existing, error: convErr } = await db.from('email_conversations')
    .select('id, contact_id')
    .eq('location_id', locationId)
    .eq('counterpart_email', fromEmail)
    .maybeSingle()
  if (convErr) {
    console.error('[postmark-inbound] conversation lookup failed:', convErr.message)
    return NextResponse.json({ success: false, error: 'conversation_lookup_failed' }, { status: 500 })
  }

  const subject = body.Subject || null
  const counterpartName = body.FromFull?.Name || null
  let conversationId = existing?.id
  if (!conversationId) {
    const { data: created, error: insErr } = await db.from('email_conversations')
      .insert({
        location_id: locationId,
        contact_id: contactId,
        counterpart_email: fromEmail,
        counterpart_name: counterpartName,
        subject,
        status: 'active',
      })
      .select('id')
      .single()
    if (insErr || !created) {
      // Unique-violation race (Postmark parallel retry): re-read once.
      const { data: raced } = await db.from('email_conversations')
        .select('id, contact_id')
        .eq('location_id', locationId)
        .eq('counterpart_email', fromEmail)
        .maybeSingle()
      if (!raced) {
        console.error('[postmark-inbound] conversation insert failed:', insErr?.message)
        return NextResponse.json({ success: false, error: 'conversation_insert_failed' }, { status: 500 })
      }
      conversationId = raced.id
    } else {
      conversationId = created.id
    }
  } else if (!existing.contact_id && contactId) {
    // A previously-anonymous thread just resolved to a contact — link it.
    await db.from('email_conversations')
      .update({ contact_id: contactId })
      .eq('id', conversationId)
      .is('contact_id', null)
  } else if (existing.contact_id) {
    // The thread's earlier linkage wins (non-destructive).
    contactId = existing.contact_id
  }

  // ── Insert the message ────────────────────────────────────────────
  const textBody = (body.TextBody || '').trim() || htmlToPlainText(body.HtmlBody) || ''
  const now = new Date().toISOString()
  const { error: msgErr } = await db.from('email_inbox_messages').insert({
    conversation_id: conversationId,
    contact_id: contactId,
    location_id: locationId,
    direction: 'inbound',
    from_email: fromEmail,
    to_email: recipientEmails(body)[0] || null,
    subject,
    text_body: textBody,
    html_body: truncateHtmlBody(body.HtmlBody || null),
    postmark_message_id: messageId,
    rfc_message_id: extractRfcMessageId(headers),
    in_reply_to: getHeader(headers, 'In-Reply-To'),
    references_header: getHeader(headers, 'References'),
    status: 'received',
    sent_at: body.Date ? new Date(body.Date).toISOString() : now,
  })
  if (msgErr) {
    // 23505 = the unique postmark_message_id index caught a racing
    // duplicate — that's a success, not an error.
    if (msgErr.code === '23505') {
      return NextResponse.json({ success: true, deduped: true })
    }
    console.error('[postmark-inbound] message insert failed:', msgErr.message)
    return NextResponse.json({ success: false, error: 'message_insert_failed' }, { status: 500 })
  }

  // ── Bump conversation summary + unread (mirrors the IG ingest) ────
  await db.from('email_conversations').update({
    subject: subject || undefined,
    counterpart_name: counterpartName || undefined,
    last_message_at: now,
    last_message_direction: 'inbound',
    last_message_preview: inboundPreview(textBody) || (subject ? inboundPreview(subject) : ''),
    resolved_at: null,
    updated_at: now,
  }).eq('id', conversationId)
  try { await db.rpc('increment_email_conversation_unread', { p_conversation_id: conversationId }) } catch {}

  return NextResponse.json({ success: true, conversation_id: conversationId, matched_via: matchedVia })
}

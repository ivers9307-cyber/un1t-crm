// EMAIL-INBOX.1 / EMAIL-TICKET.3 — Postmark inbound webhook for the
// email channel.
//
// Postmark's inbound stream POSTs every email received on a configured
// inbound address here. Each one becomes a TICKET (email_tickets, mig
// 482) filed against the MAILBOX it was delivered to (email_mailboxes,
// mig 485).
//
// Auth — token-in-URL pattern (same as invoices-inbound): Postmark's
// inbound webhook config only lets you set a URL, not custom headers,
// so the shared secret lives in the path. Configure Postmark to POST
// to https://crm.un1tdublin.com/api/webhooks/postmark-inbound/<token>
// where <token> = POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN. Rotation via
// POSTMARK_EMAIL_INBOX_WEBHOOK_TOKEN_PREVIOUS, then unset PREVIOUS.
// Wrong token 404s (not 403) so the URL pattern can't be probed.
//
// WHERE the mail landed — the recipient address is matched against
// ACTIVE email_mailboxes and the mailbox carries the location. There
// is NO fallback: an unmatched recipient DEAD-LETTERS. The route used
// to default to "the oldest active location", which is how Postmark's
// own sample payload filed itself into Stillorgan's queue on
// 2026-08-05. With several addresses across several domains that
// silently mixes one studio's mail into another's. Consequence, stated
// plainly: with Postmark inbound-domain forwarding EVERY address at a
// configured domain reaches this route, so anything@ that is not a
// configured mailbox now dead-letters. That is correct — it is not a
// mailbox — and webhook_dead_letter is a surface someone can look at,
// unlike a wrong studio's queue. Operators who want everything
// captured configure a catch-all mailbox.
//
// WHO it is from (helpers in src/lib/email-inbox.js):
//   (a) In-Reply-To / References ids matched against
//       email_sends.postmark_message_id → that send's contact (a reply
//       to OUR campaign/sequence mail — the highest-signal path).
//       Contact ONLY: the mailbox is authoritative about location and
//       nothing else may override it.
//   (b) else From address → contacts by email; the pick is
//       deterministic (mailbox location preferred, then oldest
//       created_at). An unknown sender still gets a ticket, with
//       contact_id NULL.
//
// WHICH ticket it joins: threading ids are matched against this
// location's own email_inbox_messages, most recent wins
// (pickThreadedTicket), and resolveTicketAction decides append vs
// create. A reply to a CLOSED ticket REOPENS it — it does not fork
// (Richard, 2026-08-07). Closing is internal bookkeeping; the status
// route sends the member nothing, so replying to their own old email
// is just continuing the conversation, and a fork would make our
// record disagree with the thread in their mail client.
//
// What stops a ticket decaying back into mig 394's immortal
// per-person thread is the THREADING itself, not the closed state: a
// genuinely new enquiry carries no In-Reply-To/References match,
// resolves to no ticket, and starts a fresh one.
//
// DUAL-WRITE, deliberately — every inbound also maintains its mig 394
// email_conversations row and the message carries BOTH ids.
//
// COMMENT-ONLY UPDATE, INBOX-SPLIT.1 (2026-08-07): the original reason —
// "nine files still read email_conversations, dropping the write would
// blank the live inbox" — has EXPIRED. EmailInbox.jsx is deleted and
// UnifiedInbox.jsx no longer merges email, so NO WEB SURFACE reads the
// table. The remaining readers are the MOBILE app (mobile/lib/email-api.js
// → /api/email/conversations*, still its only email surface) and the
// tickets reply route's own legacy mirror. The dual-write is dead weight
// for the web but NOT yet safe to delete — retiring it is a webhook change
// plus a mobile cutover plus eventually dropping the table, and that is
// deliberately a separate step. Behaviour below is unchanged.
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
import { deadLetterWebhook } from '@/lib/webhook-dead-letter'
import { htmlToPlainText } from '@/lib/email-content'
import {
  normalizeEmail,
  getHeader,
  extractCandidateMessageIds,
  extractRfcMessageId,
  recipientEmails,
  pickContact,
  inboundPreview,
  truncateHtmlBody,
} from '@/lib/email-inbox'
import { resolveMailboxByRecipient } from '@/lib/email-mailboxes'
import { resolveTicketAction, ticketSubject, pickThreadedTicket } from '@/lib/email-tickets'
import { escapeLikePattern } from '@/lib/like-escape'

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
  const recipients = recipientEmails(body)
  let contactId = null
  let matchedVia = 'unmatched'

  // (a) Reply to one of OUR sends — In-Reply-To/References ↔ email_sends.
  // Resolves CONTACT only. It used to resolve location too; since the
  // mailbox cutover the delivered-to address is the only thing that says
  // where mail landed, and a threading header is attacker-controlled.
  const candidates = extractCandidateMessageIds(headers).slice(0, MAX_THREAD_CANDIDATES)
  if (candidates.length) {
    const { data: sends, error: sendsErr } = await db.from('email_sends')
      .select('contact_id, postmark_message_id, sent_at')
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
      matchedVia = 'in_reply_to'
    }
  }

  // Recipient address → mailbox → location. AUTHORITATIVE, and the only
  // thing that decides where this mail is filed. Small table — match in JS
  // (resolveMailboxByRecipient also enforces the recipient precedence order,
  // so a message addressed to two of our mailboxes resolves the same way
  // regardless of what order the rows came back in).
  const { data: mailboxes, error: mbErr } = await db.from('email_mailboxes')
    .select('id, location_id, address, active')
    .eq('active', true)
  if (mbErr) {
    console.error('[postmark-inbound] email_mailboxes lookup failed:', mbErr.message)
    return NextResponse.json({ success: false, error: 'mailbox_lookup_failed' }, { status: 500 })
  }
  const mailbox = resolveMailboxByRecipient(mailboxes || [], recipients)
  if (!mailbox) {
    // No fallback, by design — see the header. 200 because retrying will not
    // conjure a mailbox and a non-2xx makes Postmark disable the webhook.
    //
    // provider is 'postmark_inbound', NOT WEBHOOK_PROVIDERS.POSTMARK: that
    // key is registered auto-replayable and its re-driver re-inserts the
    // payload into postmark_webhook_queue — the OUTBOUND delivery-event
    // queue. Replaying an inbound email through it would push an email into
    // the wrong pipeline AND mark the dead-letter row resolved when nothing
    // was. This failure is not replayable: it needs an operator to configure
    // a mailbox, so the row stays pending and visible for triage.
    await deadLetterWebhook(db, {
      provider: 'postmark_inbound',
      eventType: 'inbound_email',
      payload: body,
      error: 'no_matching_mailbox',
    })
    console.warn('[postmark-inbound] no active mailbox matched — dead-lettered', {
      messageId, recipients,
    })
    return NextResponse.json({ success: true, dead_lettered: 'no_matching_mailbox' })
  }
  const locationId = mailbox.location_id

  // (b) From address → contacts (deterministic pick; prefer the mailbox's
  // location). Runs even when (a) matched but the send had no contact — and
  // fills contact linkage for recipient-only matches.
  if (!contactId) {
    // escapeLikePattern: fromEmail comes off an UNAUTHENTICATED webhook and
    // normalizeEmail admits both LIKE wildcards, so a bare .ilike() matched a
    // PATTERN — `%@example.com` picked up every contact at the domain and
    // `a_b@` also matched `axb@`. pickContact then chose one deterministically,
    // linking a stranger's mail to a real contact's identity, silently.
    const { data: contacts, error: cErr } = await db.from('contacts')
      .select('id, location_id, created_at')
      .ilike('email', escapeLikePattern(fromEmail))
      .limit(50)
    if (cErr) {
      console.error('[postmark-inbound] contacts lookup failed:', cErr.message)
      return NextResponse.json({ success: false, error: 'contact_lookup_failed' }, { status: 500 })
    }
    const picked = pickContact(contacts || [], locationId)
    if (picked) {
      contactId = picked.id
      if (matchedVia === 'unmatched') matchedVia = 'from_address'
    }
  }

  // Stamped last, so matched_via still reports the strongest signal we had:
  // 'recipient_address' now means "the mailbox matched but we could not
  // identify the sender", which is the diagnostic worth having.
  if (matchedVia === 'unmatched') matchedVia = 'recipient_address'

  // ── Which ticket does this join? ──────────────────────────────────
  // Our own earlier messages in this location whose ids a threading header
  // names. Location-scoped: an RFC id is guessable text in an attacker-
  // supplied header, and without the scope a crafted In-Reply-To could
  // thread a stranger's mail into another studio's ticket — the very
  // cross-studio mixing the mailbox routing exists to prevent.
  //
  // Two `.in()` queries rather than one `.or()`: `.or()` takes a RAW
  // PostgREST filter string, so a stray `)` in a References header would
  // rewrite the filter. `.in()` is escaped by postgrest-js.
  let threadedTicket = null
  if (candidates.length) {
    const [byRfc, byPostmark] = await Promise.all([
      db.from('email_inbox_messages')
        .select('ticket_id, created_at')
        .eq('location_id', locationId)
        .not('ticket_id', 'is', null)
        .in('rfc_message_id', candidates),
      db.from('email_inbox_messages')
        .select('ticket_id, created_at')
        .eq('location_id', locationId)
        .not('ticket_id', 'is', null)
        .in('postmark_message_id', candidates),
    ])
    const threadErr = byRfc.error || byPostmark.error
    if (threadErr) {
      console.error('[postmark-inbound] ticket thread lookup failed:', threadErr.message)
      return NextResponse.json({ success: false, error: 'ticket_lookup_failed' }, { status: 500 })
    }
    const threadedTicketId = pickThreadedTicket([...(byRfc.data || []), ...(byPostmark.data || [])])
    if (threadedTicketId) {
      const { data: found, error: tErr } = await db.from('email_tickets')
        .select('id, status, subject, first_response_at')
        .eq('id', threadedTicketId)
        .eq('location_id', locationId)
        .maybeSingle()
      if (tErr) {
        console.error('[postmark-inbound] ticket lookup failed:', tErr.message)
        return NextResponse.json({ success: false, error: 'ticket_lookup_failed' }, { status: 500 })
      }
      threadedTicket = found || null
    }
  }
  const action = resolveTicketAction(threadedTicket)

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

  const textBody = (body.TextBody || '').trim() || htmlToPlainText(body.HtmlBody) || ''
  const now = new Date().toISOString()
  const preview = inboundPreview(textBody) || (subject ? inboundPreview(subject) : '')

  // ── Create or append the ticket ───────────────────────────────────
  // `append` writes nothing yet — its summary update runs after the message
  // lands, mirroring the conversation bump. `create` has to insert first:
  // email_inbox_messages.ticket_id is a foreign key.
  let ticketId = null
  if (action.action === 'append') {
    ticketId = action.ticketId
  } else {
    const { data: createdTicket, error: ticketErr } = await db.from('email_tickets')
      .insert({
        location_id: locationId,
        mailbox_id: mailbox.id,
        contact_id: contactId,
        requester_email: fromEmail,
        requester_name: counterpartName,
        subject: ticketSubject(null, subject),
        status: 'open',
        // Set only when this reply threaded to a CLOSED ticket. That ticket
        // stays closed — this is its successor, not its resurrection.
        reopened_from: action.reopenedFrom,
        last_message_at: now,
        last_message_direction: 'inbound',
        last_message_preview: preview,
      })
      .select('id')
      .single()
    if (ticketErr || !createdTicket) {
      console.error('[postmark-inbound] ticket insert failed:', ticketErr?.message)
      return NextResponse.json({ success: false, error: 'ticket_insert_failed' }, { status: 500 })
    }
    ticketId = createdTicket.id
  }

  // ── Insert the message ────────────────────────────────────────────
  // Carries BOTH ids for the length of the transition.
  const { error: msgErr } = await db.from('email_inbox_messages').insert({
    ticket_id: ticketId,
    conversation_id: conversationId,
    contact_id: contactId,
    location_id: locationId,
    direction: 'inbound',
    from_email: fromEmail,
    to_email: recipients[0] || null,
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

  // ── Bump the ticket ───────────────────────────────────────────────
  // No `subject` here on purpose: a ticket is named by the issue that opened
  // it. Mig 394 tracked the latest inbound and thread names drifted with
  // every "Re: Re: Fwd:".
  if (action.action === 'append') {
    await db.from('email_tickets').update({
      status: 'open',
      last_message_at: now,
      last_message_direction: 'inbound',
      last_message_preview: preview,
      updated_at: now,
    }).eq('id', ticketId)
  }
  // supabase-js builders are thenables with no .catch — try/catch, not
  // .catch(), or the rpc never fires.
  try { await db.rpc('increment_email_ticket_unread', { p_ticket_id: ticketId }) } catch {}

  // ── Bump conversation summary + unread (mirrors the IG ingest) ────
  await db.from('email_conversations').update({
    subject: subject || undefined,
    counterpart_name: counterpartName || undefined,
    last_message_at: now,
    last_message_direction: 'inbound',
    last_message_preview: preview,
    resolved_at: null,
    updated_at: now,
  }).eq('id', conversationId)
  try { await db.rpc('increment_email_conversation_unread', { p_conversation_id: conversationId }) } catch {}

  return NextResponse.json({
    success: true,
    ticket_id: ticketId,
    conversation_id: conversationId,
    mailbox_id: mailbox.id,
    matched_via: matchedVia,
  })
}
